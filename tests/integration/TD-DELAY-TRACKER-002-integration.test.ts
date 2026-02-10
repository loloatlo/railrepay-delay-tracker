/**
 * Integration Tests: TD-DELAY-TRACKER-002 - End-to-End Kafka Consumer Flow
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * Service: delay-tracker
 * Workflow: Technical Debt Remediation
 *
 * Tests the FULL flow from journey.confirmed event → database → outbox event
 * using Testcontainers with real PostgreSQL. NO mocked databases.
 *
 * Test scenarios:
 * - AC-6: delay_alerts rows created with correct delay_minutes
 * - AC-11: Full integration with real PostgreSQL (Testcontainers)
 * - Historic journey → Darwin lookup → delay_alerts + outbox
 * - Future journey → monitored_journeys + outbox
 * - darwin_unavailable handling → outbox event
 * - Idempotent duplicate handling
 *
 * NOTE: These tests WILL FAIL until Blake implements the consumer.
 * DO NOT modify tests - implement the code to make them pass.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import path from 'path';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyConfirmedHandler } from '../../src/kafka/journey-confirmed-handler.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyRepository } from '../../src/repositories/journey-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayAlertRepository } from '../../src/repositories/delay-alert-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { OutboxRepository } from '../../src/repositories/outbox-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DarwinIngestorClient } from '../../src/clients/darwin-ingestor.js';

/**
 * Valid journey.confirmed event payloads for integration tests
 */
const historicJourneyPayload = {
  journey_id: '550e8400-e29b-41d4-a716-446655440010',
  user_id: '123e4567-e89b-12d3-a456-426614174010',
  origin_crs: 'PAD',
  destination_crs: 'CDF',
  departure_datetime: '2026-02-09T15:48:00.000Z', // Past
  arrival_datetime: '2026-02-09T17:37:00.000Z',
  journey_type: 'single',
  toc_code: 'GW',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'PAD',
      destination_crs: 'CDF',
      scheduled_departure: '2026-02-09T15:48:00.000Z',
      scheduled_arrival: '2026-02-09T17:37:00.000Z',
      rid: '202602091548001',
      toc_code: 'GW',
    },
  ],
  correlation_id: '660e9500-f39c-52e5-b827-557766551210',
};

const futureJourneyPayload = {
  journey_id: '550e8400-e29b-41d4-a716-446655440020',
  user_id: '123e4567-e89b-12d3-a456-426614174020',
  origin_crs: 'KGX',
  destination_crs: 'EDN',
  departure_datetime: '2026-03-15T08:00:00.000Z', // Future
  arrival_datetime: '2026-03-15T12:30:00.000Z',
  journey_type: 'single',
  toc_code: 'GR',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'KGX',
      destination_crs: 'EDN',
      scheduled_departure: '2026-03-15T08:00:00.000Z',
      scheduled_arrival: '2026-03-15T12:30:00.000Z',
      rid: '202603150800456',
      toc_code: 'GR',
    },
  ],
  correlation_id: '660e9500-f39c-52e5-b827-557766551220',
};

describe('TD-DELAY-TRACKER-002: Integration Tests (Real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let handler: JourneyConfirmedHandler;
  let journeyRepository: JourneyRepository;
  let delayAlertRepository: DelayAlertRepository;
  let outboxRepository: OutboxRepository;
  let mockDarwinClient: DarwinIngestorClient;

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('test_db')
      .start();

    // Create connection pool
    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });

    // Run migrations to create schema (including darwin_unavailable status)
    const migrationDir = path.join(__dirname, '../../migrations');
    execSync(`npx node-pg-migrate up -m "${migrationDir}" --migrations-schema delay_tracker --migrations-table pgmigrations`, {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    });

    // Initialize repositories
    journeyRepository = new JourneyRepository({ pool });
    delayAlertRepository = new DelayAlertRepository({ pool });
    outboxRepository = new OutboxRepository({ pool });

    // Mock Darwin client (controlled responses for tests)
    mockDarwinClient = {
      getDelayInfo: vi.fn(),
    } as unknown as DarwinIngestorClient;

    // Initialize handler
    handler = new JourneyConfirmedHandler({
      journeyRepository,
      delayAlertRepository,
      outboxRepository,
      darwinClient: mockDarwinClient,
    });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    // Clean up tables before each test
    await pool.query('DELETE FROM delay_tracker.outbox');
    await pool.query('DELETE FROM delay_tracker.delay_alerts');
    await pool.query('DELETE FROM delay_tracker.monitored_journeys');

    // Reset mock
    vi.clearAllMocks();
  });

  describe('AC-6 & AC-11: Historic Journey - Delay Detection Flow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should create delay_alerts row with correct delay_minutes when delay >= 15', async () => {
      // Mock: Darwin reports 25 minute delay
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 25,
        is_cancelled: false,
        delay_reasons: { reason: 'Signal failure at Reading' },
      });

      await handler.handle(historicJourneyPayload);

      // Verify delay_alerts row created
      const alerts = await pool.query(
        'SELECT * FROM delay_tracker.delay_alerts'
      );

      expect(alerts.rows).toHaveLength(1);
      expect(alerts.rows[0].delay_minutes).toBe(25);
      expect(alerts.rows[0].delay_reasons).toEqual({ reason: 'Signal failure at Reading' });
      expect(alerts.rows[0].is_cancellation).toBe(false);
      expect(alerts.rows[0].threshold_exceeded).toBe(true);
      expect(alerts.rows[0].claim_triggered).toBe(false);
    });

    it('should create outbox event delay.detected when delay >= 15', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 30,
        is_cancelled: false,
      });

      await handler.handle(historicJourneyPayload);

      // Verify outbox event
      const outboxEvents = await pool.query(
        "SELECT * FROM delay_tracker.outbox WHERE event_type = 'delay.detected'"
      );

      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].aggregate_id).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(outboxEvents.rows[0].aggregate_type).toBe('journey');
      expect(outboxEvents.rows[0].payload).toEqual(
        expect.objectContaining({
          journey_id: '550e8400-e29b-41d4-a716-446655440010',
          user_id: '123e4567-e89b-12d3-a456-426614174010',
          delay_minutes: 30,
          is_cancellation: false,
        })
      );
      expect(outboxEvents.rows[0].correlation_id).toBe('660e9500-f39c-52e5-b827-557766551210');
      expect(outboxEvents.rows[0].status).toBe('pending');
    });

    it('should create outbox event delay.not-detected when delay < 15', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 8,
        is_cancelled: false,
      });

      await handler.handle(historicJourneyPayload);

      // NO delay_alerts row
      const alerts = await pool.query('SELECT * FROM delay_tracker.delay_alerts');
      expect(alerts.rows).toHaveLength(0);

      // Outbox event: delay.not-detected
      const outboxEvents = await pool.query(
        "SELECT * FROM delay_tracker.outbox WHERE event_type = 'delay.not-detected'"
      );

      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].payload).toEqual(
        expect.objectContaining({
          journey_id: '550e8400-e29b-41d4-a716-446655440010',
          user_id: '123e4567-e89b-12d3-a456-426614174010',
          reason: 'below_threshold',
        })
      );
    });

    it('should handle cancellations (delay_minutes = 0, is_cancellation = true)', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 0,
        is_cancelled: true,
        delay_reasons: { reason: 'Service cancelled due to operational issues' },
      });

      await handler.handle(historicJourneyPayload);

      // Verify delay_alerts row
      const alerts = await pool.query('SELECT * FROM delay_tracker.delay_alerts');
      expect(alerts.rows).toHaveLength(1);
      expect(alerts.rows[0].delay_minutes).toBe(0);
      expect(alerts.rows[0].is_cancellation).toBe(true);
      expect(alerts.rows[0].threshold_exceeded).toBe(true); // Cancellations always exceed

      // Verify outbox event
      const outboxEvents = await pool.query(
        "SELECT * FROM delay_tracker.outbox WHERE event_type = 'delay.detected'"
      );
      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].payload.is_cancellation).toBe(true);
    });
  });

  describe('AC-11: Future Journey - Monitoring Registration Flow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should create monitored_journeys row for future journey', async () => {
      await handler.handle(futureJourneyPayload);

      const journeys = await pool.query(
        'SELECT * FROM delay_tracker.monitored_journeys WHERE journey_id = $1',
        ['550e8400-e29b-41d4-a716-446655440020']
      );

      expect(journeys.rows).toHaveLength(1);
      expect(journeys.rows[0].user_id).toBe('123e4567-e89b-12d3-a456-426614174020');
      expect(journeys.rows[0].rid).toBe('202603150800456');
      expect(journeys.rows[0].service_date).toBe('2026-03-15');
      expect(journeys.rows[0].origin_crs).toBe('KGX');
      expect(journeys.rows[0].destination_crs).toBe('EDN');
      expect(journeys.rows[0].monitoring_status).toBe('active');
      expect(journeys.rows[0].next_check_at).toBeDefined();
    });

    it('should set next_check_at to 1 hour before departure', async () => {
      await handler.handle(futureJourneyPayload);

      const journeys = await pool.query(
        'SELECT next_check_at FROM delay_tracker.monitored_journeys WHERE journey_id = $1',
        ['550e8400-e29b-41d4-a716-446655440020']
      );

      const nextCheckAt = new Date(journeys.rows[0].next_check_at);
      const expectedTime = new Date('2026-03-15T07:00:00.000Z'); // 1 hour before 08:00

      expect(nextCheckAt).toEqual(expectedTime);
    });

    it('should create outbox event journey.monitoring-registered', async () => {
      await handler.handle(futureJourneyPayload);

      const outboxEvents = await pool.query(
        "SELECT * FROM delay_tracker.outbox WHERE event_type = 'journey.monitoring-registered'"
      );

      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].aggregate_id).toBe('550e8400-e29b-41d4-a716-446655440020');
      expect(outboxEvents.rows[0].payload).toEqual(
        expect.objectContaining({
          journey_id: '550e8400-e29b-41d4-a716-446655440020',
          user_id: '123e4567-e89b-12d3-a456-426614174020',
          monitoring_status: 'active',
        })
      );
      expect(outboxEvents.rows[0].correlation_id).toBe('660e9500-f39c-52e5-b827-557766551220');
    });

    it('should NOT create delay_alerts row for future journey', async () => {
      await handler.handle(futureJourneyPayload);

      const alerts = await pool.query('SELECT * FROM delay_tracker.delay_alerts');
      expect(alerts.rows).toHaveLength(0);
    });
  });

  describe('AC-7: darwin_unavailable Status Handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should publish delay.not-detected event when Darwin returns 404', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin service not found: 404')
      );

      await handler.handle(historicJourneyPayload);

      // NO delay_alerts row created
      const alerts = await pool.query('SELECT * FROM delay_tracker.delay_alerts');
      expect(alerts.rows).toHaveLength(0);

      // Outbox event: delay.not-detected with darwin_unavailable reason
      const outboxEvents = await pool.query(
        "SELECT * FROM delay_tracker.outbox WHERE event_type = 'delay.not-detected'"
      );

      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].payload).toEqual(
        expect.objectContaining({
          journey_id: '550e8400-e29b-41d4-a716-446655440010',
          user_id: '123e4567-e89b-12d3-a456-426614174010',
          reason: 'darwin_unavailable',
        })
      );
    });

    it('should NOT throw error when Darwin unavailable', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(new Error('Network timeout'));

      await expect(handler.handle(historicJourneyPayload)).resolves.not.toThrow();
    });
  });

  describe('AC-10: Idempotent Duplicate Handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should NOT create duplicate monitored_journeys row for same journey_id', async () => {
      // First processing
      await handler.handle(futureJourneyPayload);

      // Verify row created
      const firstCheck = await pool.query(
        'SELECT * FROM delay_tracker.monitored_journeys WHERE journey_id = $1',
        ['550e8400-e29b-41d4-a716-446655440020']
      );
      expect(firstCheck.rows).toHaveLength(1);

      // Second processing (duplicate event)
      await handler.handle(futureJourneyPayload);

      // Verify STILL only one row
      const secondCheck = await pool.query(
        'SELECT * FROM delay_tracker.monitored_journeys WHERE journey_id = $1',
        ['550e8400-e29b-41d4-a716-446655440020']
      );
      expect(secondCheck.rows).toHaveLength(1);
    });

    it('should NOT create duplicate outbox events for duplicate journey', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 20,
        is_cancelled: false,
      });

      // First processing
      await handler.handle(historicJourneyPayload);

      const firstOutbox = await pool.query(
        'SELECT * FROM delay_tracker.outbox WHERE aggregate_id = $1',
        ['550e8400-e29b-41d4-a716-446655440010']
      );
      expect(firstOutbox.rows).toHaveLength(1);

      // Second processing (duplicate event)
      await handler.handle(historicJourneyPayload);

      // Verify STILL only one outbox event
      const secondOutbox = await pool.query(
        'SELECT * FROM delay_tracker.outbox WHERE aggregate_id = $1',
        ['550e8400-e29b-41d4-a716-446655440010']
      );
      expect(secondOutbox.rows).toHaveLength(1);
    });
  });

  describe('AC-9: Correlation ID Propagation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should propagate correlation_id to outbox event (historic journey)', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 15,
        is_cancelled: false,
      });

      await handler.handle(historicJourneyPayload);

      const outboxEvents = await pool.query('SELECT * FROM delay_tracker.outbox');
      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].correlation_id).toBe('660e9500-f39c-52e5-b827-557766551210');
    });

    it('should propagate correlation_id to outbox event (future journey)', async () => {
      await handler.handle(futureJourneyPayload);

      const outboxEvents = await pool.query('SELECT * FROM delay_tracker.outbox');
      expect(outboxEvents.rows).toHaveLength(1);
      expect(outboxEvents.rows[0].correlation_id).toBe('660e9500-f39c-52e5-b827-557766551220');
    });
  });

  describe('Edge Cases', () => {
    it('should handle journey with multiple segments (use first segment RID)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

      const multiSegmentPayload = {
        ...historicJourneyPayload,
        journey_id: '550e8400-e29b-41d4-a716-446655440030',
        correlation_id: '660e9500-f39c-52e5-b827-557766551230',
        segments: [
          {
            segment_order: 1,
            origin_crs: 'PAD',
            destination_crs: 'BRI',
            scheduled_departure: '2026-02-09T15:48:00.000Z',
            scheduled_arrival: '2026-02-09T16:30:00.000Z',
            rid: '202602091548001',
            toc_code: 'GW',
          },
          {
            segment_order: 2,
            origin_crs: 'BRI',
            destination_crs: 'CDF',
            scheduled_departure: '2026-02-09T16:45:00.000Z',
            scheduled_arrival: '2026-02-09T17:37:00.000Z',
            rid: '202602091645002',
            toc_code: 'GW',
          },
        ],
      };

      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 0,
        is_cancelled: false,
      });

      await handler.handle(multiSegmentPayload);

      // Should use first segment RID
      expect(mockDarwinClient.getDelayInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          rid: '202602091548001',
        })
      );

      vi.useRealTimers();
    });
  });
});
