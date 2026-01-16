/**
 * Integration Tests: End-to-End Delay Detection Workflow
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests the complete delay detection workflow:
 * 1. Journey registration and monitoring setup
 * 2. Cron job execution and delay detection
 * 3. Claim trigger and outbox event creation
 * 4. Full lifecycle from registration to completion
 *
 * Uses Testcontainers for real PostgreSQL integration.
 *
 * NOTE: These tests should FAIL until Blake implements all components.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayTrackerService } from '../../src/services/delay-tracker-service.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyMonitor } from '../../src/services/journey-monitor.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayDetector } from '../../src/services/delay-detector.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { ClaimTrigger } from '../../src/services/claim-trigger.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { CronScheduler } from '../../src/services/cron-scheduler.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyRepository } from '../../src/repositories/journey-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayAlertRepository } from '../../src/repositories/delay-alert-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { OutboxRepository } from '../../src/repositories/outbox-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { OutboxPublisher } from '../../src/services/outbox-publisher.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DarwinIngestorClient } from '../../src/clients/darwin-ingestor.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { EligibilityEngineClient } from '../../src/clients/eligibility-engine.js';

// Import fixtures
import {
  singleDelayedService,
  noDelays,
  delayAtThreshold,
  cancelledService,
  multipleServicesResponse,
} from '../fixtures/api/darwin-ingestor-responses.fixtures.js';

import {
  claimTriggerSuccess,
  notEligibleResponse,
} from '../fixtures/api/eligibility-engine-responses.fixtures.js';

/**
 * UUID constants for E2E integration tests
 * Using valid UUIDs to satisfy PostgreSQL UUID type constraints
 */
const E2E_UUIDS = {
  // Journey Registration Flow
  USER_E2E_001: 'e2e00001-0001-4001-8001-000000000001',
  JOURNEY_E2E_001: 'e2e00001-0001-4001-8001-000000000002',
  USER_E2E_002: 'e2e00002-0002-4002-8002-000000000001',
  JOURNEY_E2E_002: 'e2e00002-0002-4002-8002-000000000002',
  USER_E2E_003: 'e2e00003-0003-4003-8003-000000000001',
  JOURNEY_E2E_003: 'e2e00003-0003-4003-8003-000000000002',
  USER_E2E_004: 'e2e00004-0004-4004-8004-000000000001',
  JOURNEY_E2E_004: 'e2e00004-0004-4004-8004-000000000002',

  // Delay Detection Cycle
  USER_DELAY_001: 'e2e00010-0010-4010-8010-000000000001',
  JOURNEY_DELAY_001: 'e2e00010-0010-4010-8010-000000000002',
  USER_ONTIME_001: 'e2e00011-0011-4011-8011-000000000001',
  JOURNEY_ONTIME_001: 'e2e00011-0011-4011-8011-000000000002',
  USER_THRESHOLD_001: 'e2e00012-0012-4012-8012-000000000001',
  JOURNEY_THRESHOLD_001: 'e2e00012-0012-4012-8012-000000000002',
  USER_CANCELLED_001: 'e2e00013-0013-4013-8013-000000000001',
  JOURNEY_CANCELLED_001: 'e2e00013-0013-4013-8013-000000000002',
  USER_EVENT_001: 'e2e00014-0014-4014-8014-000000000001',
  JOURNEY_EVENT_001: 'e2e00014-0014-4014-8014-000000000002',
  USER_NEXTCHECK_001: 'e2e00015-0015-4015-8015-000000000001',
  JOURNEY_NEXTCHECK_001: 'e2e00015-0015-4015-8015-000000000002',

  // Claim Trigger Flow
  USER_CLAIM_001: 'e2e00020-0020-4020-8020-000000000001',
  JOURNEY_CLAIM_001: 'e2e00020-0020-4020-8020-000000000002',
  USER_NOTELIGIBLE_001: 'e2e00021-0021-4021-8021-000000000001',
  JOURNEY_NOTELIGIBLE_001: 'e2e00021-0021-4021-8021-000000000002',
  USER_CLAIMEV_001: 'e2e00022-0022-4022-8022-000000000001',
  JOURNEY_CLAIMEV_001: 'e2e00022-0022-4022-8022-000000000002',
  USER_RETRIGGER_001: 'e2e00023-0023-4023-8023-000000000001',
  JOURNEY_RETRIGGER_001: 'e2e00023-0023-4023-8023-000000000002',

  // Multiple Journeys Processing
  USER_MULTI_001: 'e2e00030-0030-4030-8030-000000000001',
  JOURNEY_MULTI_001: 'e2e00030-0030-4030-8030-000000000002',
  USER_MULTI_002: 'e2e00031-0031-4031-8031-000000000001',
  JOURNEY_MULTI_002: 'e2e00031-0031-4031-8031-000000000002',
  USER_MULTI_003: 'e2e00032-0032-4032-8032-000000000001',
  JOURNEY_MULTI_003: 'e2e00032-0032-4032-8032-000000000002',

  // Journey Completion
  USER_COMPLETE_001: 'e2e00040-0040-4040-8040-000000000001',
  JOURNEY_COMPLETE_001: 'e2e00040-0040-4040-8040-000000000002',
  USER_COMPLETEEV_001: 'e2e00041-0041-4041-8041-000000000001',
  JOURNEY_COMPLETEEV_001: 'e2e00041-0041-4041-8041-000000000002',

  // RID Resolution
  USER_RID_001: 'e2e00050-0050-4050-8050-000000000001',
  JOURNEY_RID_001: 'e2e00050-0050-4050-8050-000000000002',
  USER_RIDRETRY_001: 'e2e00051-0051-4051-8051-000000000001',
  JOURNEY_RIDRETRY_001: 'e2e00051-0051-4051-8051-000000000002',

  // Error Handling
  USER_ERROR_001: 'e2e00060-0060-4060-8060-000000000001',
  JOURNEY_ERROR_001: 'e2e00060-0060-4060-8060-000000000002',
  USER_ELIGERROR_001: 'e2e00061-0061-4061-8061-000000000001',
  JOURNEY_ELIGERROR_001: 'e2e00061-0061-4061-8061-000000000002',
  USER_ATOMIC_001: 'e2e00062-0062-4062-8062-000000000001',
  JOURNEY_ATOMIC_001: 'e2e00062-0062-4062-8062-000000000002',

  // Metrics and Observability
  USER_METRICS_001: 'e2e00070-0070-4070-8070-000000000001',
  JOURNEY_METRICS_001: 'e2e00070-0070-4070-8070-000000000002',
  USER_CORR_001: 'e2e00071-0071-4071-8071-000000000001',
  JOURNEY_CORR_001: 'e2e00071-0071-4071-8071-000000000002',
};

describe('End-to-End Delay Detection Workflow', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  // Repositories
  let journeyRepository: JourneyRepository;
  let delayAlertRepository: DelayAlertRepository;
  let outboxRepository: OutboxRepository;

  // Services
  let journeyMonitor: JourneyMonitor;
  let delayDetector: DelayDetector;
  let claimTrigger: ClaimTrigger;
  let outboxPublisher: OutboxPublisher;
  let delayTrackerService: DelayTrackerService;

  // Mock clients
  let mockDarwinClient: DarwinIngestorClient;
  let mockEligibilityClient: EligibilityEngineClient;

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('railrepay_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });

    // Run migrations using node-pg-migrate (per ADR-003)
    const migrationDir = path.join(__dirname, '../../migrations');
    execSync(`npx node-pg-migrate up -m "${migrationDir}"`, {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    });
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T08:30:00Z'));

    // Clean up tables
    await pool.query('DELETE FROM delay_tracker.outbox');
    await pool.query('DELETE FROM delay_tracker.delay_alerts');
    await pool.query('DELETE FROM delay_tracker.monitored_journeys');

    // Initialize repositories
    journeyRepository = new JourneyRepository({ pool });
    delayAlertRepository = new DelayAlertRepository({ pool });
    outboxRepository = new OutboxRepository({ pool });

    // Initialize mock clients
    mockDarwinClient = {
      getDelaysByRids: vi.fn().mockResolvedValue(singleDelayedService),
    } as unknown as DarwinIngestorClient;

    mockEligibilityClient = {
      triggerClaim: vi.fn().mockResolvedValue(claimTriggerSuccess),
      checkEligibility: vi.fn().mockResolvedValue({ eligible: true }),
    } as unknown as EligibilityEngineClient;

    // Initialize services
    outboxPublisher = new OutboxPublisher({
      repository: outboxRepository,
      pool,
    });

    journeyMonitor = new JourneyMonitor({
      repository: journeyRepository,
    });

    delayDetector = new DelayDetector({
      thresholdMinutes: 15,
    });

    claimTrigger = new ClaimTrigger({
      eligibilityClient: mockEligibilityClient,
    });

    delayTrackerService = new DelayTrackerService({
      journeyMonitor,
      delayDetector,
      claimTrigger,
      delayAlertRepository,
      outboxPublisher,
      darwinClient: mockDarwinClient,
      pool,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Journey Registration Flow', () => {
    it('should register journey and set up monitoring', async () => {
      const journeyData = {
        user_id: E2E_UUIDS.USER_E2E_001,
        journey_id: E2E_UUIDS.JOURNEY_E2E_001,
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T10:00:00Z',
        scheduled_arrival: '2026-01-15T14:30:00Z',
      };

      const registered = await delayTrackerService.registerJourney(journeyData);

      expect(registered.id).toBeDefined();
      expect(registered.monitoring_status).toBe('pending_rid');

      // Verify in database
      const saved = await journeyRepository.findById(registered.id);
      expect(saved).toBeDefined();
      expect(saved?.user_id).toBe(E2E_UUIDS.USER_E2E_001);
    });

    it('should set T-48h check for future journeys', async () => {
      const futureJourney = {
        user_id: E2E_UUIDS.USER_E2E_002,
        journey_id: E2E_UUIDS.JOURNEY_E2E_002,
        service_date: '2026-01-20', // 5 days away
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        scheduled_departure: '2026-01-20T09:00:00Z',
        scheduled_arrival: '2026-01-20T11:00:00Z',
      };

      const registered = await delayTrackerService.registerJourney(futureJourney);

      // T-48h from 2026-01-20T09:00:00Z = 2026-01-18T09:00:00Z
      expect(registered.next_check_at).toEqual(new Date('2026-01-18T09:00:00Z'));
    });

    it('should set immediate check for imminent journeys', async () => {
      const imminentJourney = {
        user_id: E2E_UUIDS.USER_E2E_003,
        journey_id: E2E_UUIDS.JOURNEY_E2E_003,
        service_date: '2026-01-15',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        scheduled_departure: '2026-01-15T12:00:00Z', // Same day, 3.5 hours away
        scheduled_arrival: '2026-01-15T14:30:00Z',
      };

      const registered = await delayTrackerService.registerJourney(imminentJourney);

      // Should be within 5 minutes
      const nextCheck = new Date(registered.next_check_at);
      const now = new Date('2026-01-15T08:30:00Z');
      const diffMinutes = (nextCheck.getTime() - now.getTime()) / (1000 * 60);

      expect(diffMinutes).toBeLessThanOrEqual(5);
    });

    it('should create journey.monitoring_started outbox event', async () => {
      const journeyData = {
        user_id: E2E_UUIDS.USER_E2E_004,
        journey_id: E2E_UUIDS.JOURNEY_E2E_004,
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        scheduled_departure: '2026-01-15T11:00:00Z',
        scheduled_arrival: '2026-01-15T13:00:00Z',
      };

      await delayTrackerService.registerJourney(journeyData);

      const events = await outboxRepository.findPending();
      const startedEvent = events.find(e => e.event_type === 'journey.monitoring_started');

      expect(startedEvent).toBeDefined();
      expect(startedEvent?.payload.journeyId).toBe(E2E_UUIDS.JOURNEY_E2E_004);
    });
  });

  describe('Delay Detection Cycle', () => {
    it('should detect delay and create alert when threshold exceeded', async () => {
      // Register journey with RID that matches our fixture
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_DELAY_001,
        journey_id: E2E_UUIDS.JOURNEY_DELAY_001,
        rid: '202601150800123', // Matches singleDelayedService fixture
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'), // Due for check
      });

      // Run detection cycle
      await delayTrackerService.runDetectionCycle();

      // Should have called Darwin API
      expect(mockDarwinClient.getDelaysByRids).toHaveBeenCalledWith(['202601150800123']);

      // Should have created delay alert
      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].delay_minutes).toBe(25);
      expect(alerts[0].threshold_exceeded).toBe(true);
    });

    it('should not create alert for minor delay below threshold', async () => {
      mockDarwinClient.getDelaysByRids = vi.fn().mockResolvedValue(noDelays);

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_ONTIME_001,
        journey_id: E2E_UUIDS.JOURNEY_ONTIME_001,
        rid: '202601150900456',
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'RDG',
        scheduled_departure: '2026-01-15T09:00:00Z',
        scheduled_arrival: '2026-01-15T09:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts).toHaveLength(0);
    });

    it('should detect delay exactly at threshold', async () => {
      mockDarwinClient.getDelaysByRids = vi.fn().mockResolvedValue(delayAtThreshold);

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_THRESHOLD_001,
        journey_id: E2E_UUIDS.JOURNEY_THRESHOLD_001,
        rid: '202601151100789',
        service_date: '2026-01-15',
        origin_crs: 'VIC',
        destination_crs: 'BTN',
        scheduled_departure: '2026-01-15T11:00:00Z',
        scheduled_arrival: '2026-01-15T12:00:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].delay_minutes).toBe(15);
      expect(alerts[0].threshold_exceeded).toBe(true);
    });

    it('should handle cancelled services', async () => {
      mockDarwinClient.getDelaysByRids = vi.fn().mockResolvedValue(cancelledService);

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_CANCELLED_001,
        journey_id: E2E_UUIDS.JOURNEY_CANCELLED_001,
        rid: '202601151400321',
        service_date: '2026-01-15',
        origin_crs: 'LIV',
        destination_crs: 'MAN',
        scheduled_departure: '2026-01-15T14:00:00Z',
        scheduled_arrival: '2026-01-15T15:00:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      // Journey should be marked as cancelled
      const updatedJourney = await journeyRepository.findById(journey.id!);
      expect(updatedJourney?.monitoring_status).toBe('cancelled');

      // Alert should be created for cancellation
      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].is_cancellation).toBe(true);
    });

    it('should create delay.detected outbox event', async () => {
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_EVENT_001,
        journey_id: E2E_UUIDS.JOURNEY_EVENT_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const events = await outboxRepository.findPending();
      const delayEvent = events.find(e => e.event_type === 'delay.detected');

      expect(delayEvent).toBeDefined();
      expect(delayEvent?.payload.delayMinutes).toBe(25);
    });

    it('should update next_check_at after detection', async () => {
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_NEXTCHECK_001,
        journey_id: E2E_UUIDS.JOURNEY_NEXTCHECK_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const updated = await journeyRepository.findById(journey.id!);
      // Should be 5 minutes from now
      expect(updated?.next_check_at).toEqual(new Date('2026-01-15T08:35:00Z'));
    });
  });

  describe('Claim Trigger Flow', () => {
    it('should trigger claim for eligible delay', async () => {
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_CLAIM_001,
        journey_id: E2E_UUIDS.JOURNEY_CLAIM_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      // Run full cycle including claim trigger
      await delayTrackerService.runDetectionCycle();

      expect(mockEligibilityClient.triggerClaim).toHaveBeenCalled();

      // Alert should have claim reference
      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts[0].claim_triggered).toBe(true);
      expect(alerts[0].claim_reference_id).toBe('claim-ref-001-abc123');
    });

    it('should handle not eligible response', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockResolvedValue(notEligibleResponse);

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_NOTELIGIBLE_001,
        journey_id: E2E_UUIDS.JOURNEY_NOTELIGIBLE_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts[0].claim_triggered).toBe(false);
      expect(alerts[0].claim_trigger_response).toContain('not eligible');
    });

    it('should create claim.triggered outbox event', async () => {
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_CLAIMEV_001,
        journey_id: E2E_UUIDS.JOURNEY_CLAIMEV_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const events = await outboxRepository.findPending();
      const claimEvent = events.find(e => e.event_type === 'claim.triggered');

      expect(claimEvent).toBeDefined();
      expect(claimEvent?.payload.claimReferenceId).toBe('claim-ref-001-abc123');
    });

    it('should not re-trigger claim for already triggered alert', async () => {
      // First cycle - creates alert and triggers claim
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_RETRIGGER_001,
        journey_id: E2E_UUIDS.JOURNEY_RETRIGGER_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      // Update next_check_at to run again
      await journeyRepository.update(journey.id!, {
        next_check_at: new Date('2026-01-15T08:30:00Z'),
      });

      // Second cycle - should not re-trigger
      await delayTrackerService.runDetectionCycle();

      // Eligibility client should only have been called once
      expect(mockEligibilityClient.triggerClaim).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multiple Journeys Processing', () => {
    it('should process multiple journeys in single cycle', async () => {
      mockDarwinClient.getDelaysByRids = vi.fn().mockResolvedValue(multipleServicesResponse);

      // Create 3 journeys matching the fixture
      await journeyRepository.create({
        user_id: E2E_UUIDS.USER_MULTI_001,
        journey_id: E2E_UUIDS.JOURNEY_MULTI_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await journeyRepository.create({
        user_id: E2E_UUIDS.USER_MULTI_002,
        journey_id: E2E_UUIDS.JOURNEY_MULTI_002,
        rid: '202601151000456',
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        scheduled_departure: '2026-01-15T10:00:00Z',
        scheduled_arrival: '2026-01-15T12:00:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await journeyRepository.create({
        user_id: E2E_UUIDS.USER_MULTI_003,
        journey_id: E2E_UUIDS.JOURNEY_MULTI_003,
        rid: '202601151200789',
        service_date: '2026-01-15',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        scheduled_departure: '2026-01-15T12:00:00Z',
        scheduled_arrival: '2026-01-15T14:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      // Should batch the RID lookup
      expect(mockDarwinClient.getDelaysByRids).toHaveBeenCalledWith([
        '202601150800123',
        '202601151000456',
        '202601151200789',
      ]);

      // Two alerts should be created (25min and 45min delays exceed threshold, 5min doesn't)
      const result = await pool.query('SELECT COUNT(*) FROM delay_tracker.delay_alerts');
      expect(parseInt(result.rows[0].count)).toBe(2);
    });
  });

  describe('Journey Completion', () => {
    it('should mark journey as completed after arrival time passes', async () => {
      // Set time to after journey arrival
      vi.setSystemTime(new Date('2026-01-15T13:00:00Z'));

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_COMPLETE_001,
        journey_id: E2E_UUIDS.JOURNEY_COMPLETE_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z', // Already passed
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T12:55:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const updated = await journeyRepository.findById(journey.id!);
      expect(updated?.monitoring_status).toBe('completed');
      expect(updated?.next_check_at).toBeNull();
    });

    it('should create journey.completed outbox event', async () => {
      vi.setSystemTime(new Date('2026-01-15T13:00:00Z'));

      await journeyRepository.create({
        user_id: E2E_UUIDS.USER_COMPLETEEV_001,
        journey_id: E2E_UUIDS.JOURNEY_COMPLETEEV_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T12:55:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const events = await outboxRepository.findPending();
      const completedEvent = events.find(e => e.event_type === 'journey.completed');

      expect(completedEvent).toBeDefined();
    });
  });

  describe('RID Resolution', () => {
    it('should resolve RID when journey approaches T-48h', async () => {
      // Journey registered early, now within 48h
      vi.setSystemTime(new Date('2026-01-18T10:00:00Z'));

      mockDarwinClient.resolveRid = vi.fn().mockResolvedValue({
        rid: '202601200800999',
        found: true,
      });

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_RID_001,
        journey_id: E2E_UUIDS.JOURNEY_RID_001,
        rid: null, // No RID yet
        service_date: '2026-01-20',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-20T08:00:00Z',
        scheduled_arrival: '2026-01-20T12:30:00Z',
        monitoring_status: 'pending_rid',
        next_check_at: new Date('2026-01-18T08:00:00Z'), // T-48h
      });

      await delayTrackerService.runDetectionCycle();

      const updated = await journeyRepository.findById(journey.id!);
      expect(updated?.rid).toBe('202601200800999');
      expect(updated?.monitoring_status).toBe('active');
    });

    it('should retry RID resolution if not yet available', async () => {
      vi.setSystemTime(new Date('2026-01-18T10:00:00Z'));

      mockDarwinClient.resolveRid = vi.fn().mockResolvedValue({
        rid: null,
        found: false,
      });

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_RIDRETRY_001,
        journey_id: E2E_UUIDS.JOURNEY_RIDRETRY_001,
        rid: null,
        service_date: '2026-01-20',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-20T08:00:00Z',
        scheduled_arrival: '2026-01-20T12:30:00Z',
        monitoring_status: 'pending_rid',
        next_check_at: new Date('2026-01-18T08:00:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      const updated = await journeyRepository.findById(journey.id!);
      expect(updated?.rid).toBeNull();
      expect(updated?.monitoring_status).toBe('pending_rid');
      // Should schedule retry
      expect(updated?.next_check_at).toEqual(new Date('2026-01-18T10:05:00Z'));
    });
  });

  describe('Error Handling', () => {
    it('should handle Darwin API errors gracefully', async () => {
      mockDarwinClient.getDelaysByRids = vi.fn().mockRejectedValue(new Error('API unavailable'));

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_ERROR_001,
        journey_id: E2E_UUIDS.JOURNEY_ERROR_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      // Should not throw
      await expect(delayTrackerService.runDetectionCycle()).resolves.not.toThrow();

      // Journey should remain active with updated next_check
      const updated = await journeyRepository.findById(journey.id!);
      expect(updated?.monitoring_status).toBe('active');
    });

    it('should handle eligibility engine errors gracefully', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockRejectedValue(new Error('Service error'));

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_ELIGERROR_001,
        journey_id: E2E_UUIDS.JOURNEY_ELIGERROR_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      // Alert should be created but claim not triggered
      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].claim_triggered).toBe(false);
    });

    it('should use transaction for atomic operations', async () => {
      // Simulate failure during outbox write
      const originalCreate = outboxRepository.create.bind(outboxRepository);
      outboxRepository.create = vi.fn().mockRejectedValue(new Error('DB error'));

      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_ATOMIC_001,
        journey_id: E2E_UUIDS.JOURNEY_ATOMIC_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      // Alert should NOT be created if outbox write fails (transaction rollback)
      const alerts = await delayAlertRepository.findByJourneyId(journey.id!);
      expect(alerts).toHaveLength(0);

      // Restore
      outboxRepository.create = originalCreate;
    });
  });

  describe('Metrics and Observability', () => {
    it('should track detection cycle metrics', async () => {
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_METRICS_001,
        journey_id: E2E_UUIDS.JOURNEY_METRICS_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      const metrics = await delayTrackerService.runDetectionCycle();

      expect(metrics).toHaveProperty('journeysChecked');
      expect(metrics).toHaveProperty('delaysDetected');
      expect(metrics).toHaveProperty('claimsTriggered');
      expect(metrics).toHaveProperty('durationMs');
      expect(metrics.journeysChecked).toBe(1);
      expect(metrics.delaysDetected).toBe(1);
      expect(metrics.claimsTriggered).toBe(1);
    });

    it('should include correlation ID in all operations', async () => {
      const journey = await journeyRepository.create({
        user_id: E2E_UUIDS.USER_CORR_001,
        journey_id: E2E_UUIDS.JOURNEY_CORR_001,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'active',
        next_check_at: new Date('2026-01-15T08:25:00Z'),
      });

      await delayTrackerService.runDetectionCycle();

      // All outbox events should have correlation ID
      const events = await outboxRepository.findPending();
      for (const event of events) {
        expect(event.payload.correlationId).toBeDefined();
      }

      // All events from same cycle should share correlation ID
      const correlationIds = events.map(e => e.payload.correlationId);
      const uniqueIds = [...new Set(correlationIds)];
      expect(uniqueIds).toHaveLength(1);
    });
  });
});
