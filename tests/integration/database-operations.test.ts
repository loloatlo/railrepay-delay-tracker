/**
 * Integration Tests: Database Operations
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for CRUD operations on delay_tracker schema tables using Testcontainers.
 * These tests verify actual database interactions, not mocked behavior.
 *
 * NOTE: These tests should FAIL until Blake implements the repository layer.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import path from 'path';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyRepository } from '../../src/repositories/journey-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayAlertRepository } from '../../src/repositories/delay-alert-repository.js';

// Import fixtures
import {
  activeJourneyWithRid,
  pendingRidJourney,
  delayedJourney,
  multipleJourneysForUser,
  MULTI_JOURNEY_USER_ID,
  MonitoredJourneyFixture,
} from '../fixtures/db/monitored-journeys.fixtures.js';

import {
  delayWithClaimTriggered,
  delayPendingClaimTrigger,
  DelayAlertFixture,
} from '../fixtures/db/delay-alerts.fixtures.js';

/**
 * UUID constants for integration tests
 * Using valid UUIDs to satisfy PostgreSQL UUID type constraints
 */
const TEST_UUIDS = {
  USER_TIMESTAMP: '00000001-0001-4001-8001-000000000001',
  JOURNEY_TIMESTAMP: '00000001-0001-4001-8001-000000000002',
  USER_DUE: '00000002-0002-4002-8002-000000000001',
  JOURNEY_DUE: '00000002-0002-4002-8002-000000000002',
  USER_NOT_DUE: '00000002-0002-4002-8002-000000000003',
  JOURNEY_NOT_DUE: '00000002-0002-4002-8002-000000000004',
  USER_STATUS_PREFIX: '00000003-0003-4003-8003-00000000000',
  JOURNEY_STATUS_PREFIX: '00000003-0003-4003-8003-00000000001',
  USER_UPDATE: '00000004-0004-4004-8004-000000000001',
  JOURNEY_UPDATE: '00000004-0004-4004-8004-000000000002',
  USER_TS_UPDATE: '00000005-0005-4005-8005-000000000001',
  JOURNEY_TS_UPDATE: '00000005-0005-4005-8005-000000000002',
  USER_BATCH_1: '00000006-0006-4006-8006-000000000001',
  JOURNEY_BATCH_1: '00000006-0006-4006-8006-000000000002',
  USER_BATCH_2: '00000006-0006-4006-8006-000000000003',
  JOURNEY_BATCH_2: '00000006-0006-4006-8006-000000000004',
  USER_DELETE: '00000007-0007-4007-8007-000000000001',
  JOURNEY_DELETE: '00000007-0007-4007-8007-000000000002',
  USER_ALERT: '00000008-0008-4008-8008-000000000001',
  USER_UNIQUE_1: '00000009-0009-4009-8009-000000000001',
  JOURNEY_UNIQUE_1: '00000009-0009-4009-8009-000000000002',
  USER_UNIQUE_2: '00000009-0009-4009-8009-000000000003',
  JOURNEY_DUPLICATE: '00000009-0009-4009-8009-000000000004',
  USER_CASCADE: '0000000a-000a-400a-800a-000000000001',
  JOURNEY_CASCADE: '0000000a-000a-400a-800a-000000000002',
};

describe('Database Operations - Integration Tests', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let journeyRepository: JourneyRepository;
  let delayAlertRepository: DelayAlertRepository;

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('test_db')
      .start();

    // Create connection pool
    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });

    // Run migrations to create schema
    const migrationDir = path.join(__dirname, '../../migrations');
    execSync(`npx node-pg-migrate up -m "${migrationDir}"`, {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    });

    // Initialize repositories
    journeyRepository = new JourneyRepository({ pool });
    delayAlertRepository = new DelayAlertRepository({ pool });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    // Clean up tables before each test
    await pool.query('DELETE FROM delay_tracker.delay_alerts');
    await pool.query('DELETE FROM delay_tracker.monitored_journeys');
    await pool.query('DELETE FROM delay_tracker.outbox');
  });

  describe('JourneyRepository - CRUD Operations', () => {
    describe('create()', () => {
      it('should create a new monitored journey', async () => {
        const journey = await journeyRepository.create({
          user_id: activeJourneyWithRid.user_id,
          journey_id: activeJourneyWithRid.journey_id,
          rid: activeJourneyWithRid.rid,
          service_date: activeJourneyWithRid.service_date,
          origin_crs: activeJourneyWithRid.origin_crs,
          destination_crs: activeJourneyWithRid.destination_crs,
          scheduled_departure: activeJourneyWithRid.scheduled_departure,
          scheduled_arrival: activeJourneyWithRid.scheduled_arrival,
          monitoring_status: activeJourneyWithRid.monitoring_status,
        });

        expect(journey.id).toBeDefined();
        expect(journey.user_id).toBe(activeJourneyWithRid.user_id);
        expect(journey.origin_crs).toBe('KGX');
      });

      it('should auto-generate UUID for id', async () => {
        const journey = await journeyRepository.create({
          user_id: pendingRidJourney.user_id,
          journey_id: pendingRidJourney.journey_id,
          service_date: pendingRidJourney.service_date,
          origin_crs: pendingRidJourney.origin_crs,
          destination_crs: pendingRidJourney.destination_crs,
          scheduled_departure: pendingRidJourney.scheduled_departure,
          scheduled_arrival: pendingRidJourney.scheduled_arrival,
          monitoring_status: pendingRidJourney.monitoring_status,
        });

        expect(journey.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
      });

      it('should set default timestamps', async () => {
        const journey = await journeyRepository.create({
          user_id: TEST_UUIDS.USER_TIMESTAMP,
          journey_id: TEST_UUIDS.JOURNEY_TIMESTAMP,
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'pending_rid',
        });

        expect(journey.created_at).toBeInstanceOf(Date);
        expect(journey.updated_at).toBeInstanceOf(Date);
      });

      it('should enforce unique constraint on journey_id', async () => {
        await journeyRepository.create({
          user_id: TEST_UUIDS.USER_UNIQUE_1,
          journey_id: TEST_UUIDS.JOURNEY_DUPLICATE,
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'active',
        });

        await expect(
          journeyRepository.create({
            user_id: TEST_UUIDS.USER_UNIQUE_2,
            journey_id: TEST_UUIDS.JOURNEY_DUPLICATE, // Same journey_id
            service_date: '2026-01-15',
            origin_crs: 'PAD',
            destination_crs: 'BRI',
            scheduled_departure: '2026-01-15T10:00:00Z',
            scheduled_arrival: '2026-01-15T11:45:00Z',
            monitoring_status: 'active',
          })
        ).rejects.toThrow();
      });
    });

    describe('findById()', () => {
      it('should find journey by id', async () => {
        const created = await journeyRepository.create({
          user_id: activeJourneyWithRid.user_id,
          journey_id: activeJourneyWithRid.journey_id,
          rid: activeJourneyWithRid.rid,
          service_date: activeJourneyWithRid.service_date,
          origin_crs: activeJourneyWithRid.origin_crs,
          destination_crs: activeJourneyWithRid.destination_crs,
          scheduled_departure: activeJourneyWithRid.scheduled_departure,
          scheduled_arrival: activeJourneyWithRid.scheduled_arrival,
          monitoring_status: activeJourneyWithRid.monitoring_status,
        });

        const found = await journeyRepository.findById(created.id);

        expect(found).toBeDefined();
        expect(found!.id).toBe(created.id);
        expect(found!.origin_crs).toBe('KGX');
      });

      it('should return null for non-existent id', async () => {
        const found = await journeyRepository.findById('00000000-0000-0000-0000-000000000000');

        expect(found).toBeNull();
      });
    });

    describe('findByUserId()', () => {
      it('should find all journeys for a user', async () => {
        // Create multiple journeys for same user
        for (const journey of multipleJourneysForUser) {
          await journeyRepository.create({
            user_id: journey.user_id,
            journey_id: journey.journey_id,
            rid: journey.rid,
            service_date: journey.service_date,
            origin_crs: journey.origin_crs,
            destination_crs: journey.destination_crs,
            scheduled_departure: journey.scheduled_departure,
            scheduled_arrival: journey.scheduled_arrival,
            monitoring_status: journey.monitoring_status,
          });
        }

        const journeys = await journeyRepository.findByUserId(MULTI_JOURNEY_USER_ID);

        expect(journeys).toHaveLength(2);
      });

      it('should return empty array for user with no journeys', async () => {
        const journeys = await journeyRepository.findByUserId('00000000-0000-4000-8000-000000000000');

        expect(journeys).toEqual([]);
      });
    });

    describe('findJourneysDueForCheck()', () => {
      it('should find journeys where next_check_at <= now', async () => {
        // Create journey due for check (next_check_at in the past)
        await journeyRepository.create({
          user_id: TEST_UUIDS.USER_DUE,
          journey_id: TEST_UUIDS.JOURNEY_DUE,
          rid: '202601150800123',
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'active',
          next_check_at: new Date(Date.now() - 60000), // 1 minute ago
        });

        // Create journey not due (next_check_at in the future)
        await journeyRepository.create({
          user_id: TEST_UUIDS.USER_NOT_DUE,
          journey_id: TEST_UUIDS.JOURNEY_NOT_DUE,
          rid: '202601150900456',
          service_date: '2026-01-15',
          origin_crs: 'PAD',
          destination_crs: 'BRI',
          scheduled_departure: '2026-01-15T10:00:00Z',
          scheduled_arrival: '2026-01-15T11:45:00Z',
          monitoring_status: 'active',
          next_check_at: new Date(Date.now() + 300000), // 5 minutes from now
        });

        const dueJourneys = await journeyRepository.findJourneysDueForCheck();

        expect(dueJourneys).toHaveLength(1);
        expect(dueJourneys[0].journey_id).toBe(TEST_UUIDS.JOURNEY_DUE);
      });

      it('should only include active and pending_rid statuses', async () => {
        // Create journeys with different statuses
        const statuses = ['active', 'pending_rid', 'delayed', 'completed', 'cancelled'];

        for (let i = 0; i < statuses.length; i++) {
          await journeyRepository.create({
            user_id: `${TEST_UUIDS.USER_STATUS_PREFIX}${i}`,
            journey_id: `${TEST_UUIDS.JOURNEY_STATUS_PREFIX}${i}`,
            rid: statuses[i] === 'pending_rid' ? null : `20260115090${i}`,
            service_date: '2026-01-15',
            origin_crs: 'KGX',
            destination_crs: 'EDB',
            scheduled_departure: '2026-01-15T08:00:00Z',
            scheduled_arrival: '2026-01-15T12:30:00Z',
            monitoring_status: statuses[i] as any,
            next_check_at: new Date(Date.now() - 60000), // All due
          });
        }

        const dueJourneys = await journeyRepository.findJourneysDueForCheck();

        // Should only return active and pending_rid
        expect(dueJourneys).toHaveLength(2);
        expect(dueJourneys.every((j: any) =>
          ['active', 'pending_rid'].includes(j.monitoring_status)
        )).toBe(true);
      });
    });

    describe('update()', () => {
      it('should update journey fields', async () => {
        const created = await journeyRepository.create({
          user_id: TEST_UUIDS.USER_UPDATE,
          journey_id: TEST_UUIDS.JOURNEY_UPDATE,
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'pending_rid',
        });

        const updated = await journeyRepository.update(created.id, {
          rid: '202601150800999',
          monitoring_status: 'active',
        });

        expect(updated.rid).toBe('202601150800999');
        expect(updated.monitoring_status).toBe('active');
      });

      it('should update updated_at timestamp', async () => {
        const created = await journeyRepository.create({
          user_id: TEST_UUIDS.USER_TS_UPDATE,
          journey_id: TEST_UUIDS.JOURNEY_TS_UPDATE,
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'pending_rid',
        });

        // Wait a bit to ensure timestamp difference
        await new Promise((resolve) => setTimeout(resolve, 100));

        const updated = await journeyRepository.update(created.id, {
          monitoring_status: 'active',
        });

        expect(updated.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
      });
    });

    describe('updateLastChecked()', () => {
      it('should update last_checked_at and next_check_at for multiple journeys', async () => {
        const journey1 = await journeyRepository.create({
          user_id: TEST_UUIDS.USER_BATCH_1,
          journey_id: TEST_UUIDS.JOURNEY_BATCH_1,
          rid: '202601150800111',
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'active',
        });

        const journey2 = await journeyRepository.create({
          user_id: TEST_UUIDS.USER_BATCH_2,
          journey_id: TEST_UUIDS.JOURNEY_BATCH_2,
          rid: '202601150900222',
          service_date: '2026-01-15',
          origin_crs: 'PAD',
          destination_crs: 'BRI',
          scheduled_departure: '2026-01-15T10:00:00Z',
          scheduled_arrival: '2026-01-15T11:45:00Z',
          monitoring_status: 'active',
        });

        const now = new Date();
        const nextCheck = new Date(now.getTime() + 5 * 60 * 1000);

        await journeyRepository.updateLastChecked([journey1.id, journey2.id], now, nextCheck);

        const updated1 = await journeyRepository.findById(journey1.id);
        const updated2 = await journeyRepository.findById(journey2.id);

        expect(updated1!.last_checked_at).toEqual(now);
        expect(updated1!.next_check_at).toEqual(nextCheck);
        expect(updated2!.last_checked_at).toEqual(now);
        expect(updated2!.next_check_at).toEqual(nextCheck);
      });
    });

    describe('delete()', () => {
      it('should delete a journey', async () => {
        const created = await journeyRepository.create({
          user_id: TEST_UUIDS.USER_DELETE,
          journey_id: TEST_UUIDS.JOURNEY_DELETE,
          service_date: '2026-01-15',
          origin_crs: 'KGX',
          destination_crs: 'EDB',
          scheduled_departure: '2026-01-15T08:00:00Z',
          scheduled_arrival: '2026-01-15T12:30:00Z',
          monitoring_status: 'pending_rid',
        });

        await journeyRepository.delete(created.id);

        const found = await journeyRepository.findById(created.id);
        expect(found).toBeNull();
      });
    });
  });

  describe('DelayAlertRepository - CRUD Operations', () => {
    let testJourneyId: string;
    let alertTestCounter = 0;

    beforeEach(async () => {
      // Generate unique journey_id for each test to avoid unique constraint violations
      alertTestCounter++;
      const uniqueJourneyId = `0000000b-000b-400b-800b-${String(alertTestCounter).padStart(12, '0')}`;

      // Create a journey to link alerts to
      const journey = await journeyRepository.create({
        user_id: TEST_UUIDS.USER_ALERT,
        journey_id: uniqueJourneyId,
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
        monitoring_status: 'delayed',
      });
      testJourneyId = journey.id;
    });

    describe('create()', () => {
      it('should create a delay alert', async () => {
        const alert = await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 25,
          delay_reasons: { reason: 'Signal failure' },
        });

        expect(alert.id).toBeDefined();
        expect(alert.delay_minutes).toBe(25);
        expect(alert.claim_triggered).toBe(false);
      });

      it('should enforce positive delay_minutes constraint', async () => {
        await expect(
          delayAlertRepository.create({
            monitored_journey_id: testJourneyId,
            delay_minutes: 0,
          })
        ).rejects.toThrow();

        await expect(
          delayAlertRepository.create({
            monitored_journey_id: testJourneyId,
            delay_minutes: -5,
          })
        ).rejects.toThrow();
      });

      it('should store JSONB delay_reasons', async () => {
        const complexReasons = {
          reason: 'Infrastructure failure',
          secondary_reason: 'Speed restrictions',
          details: { location: 'Peterborough', duration: 'Extended' },
        };

        const alert = await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 45,
          delay_reasons: complexReasons,
        });

        expect(alert.delay_reasons).toEqual(complexReasons);
      });
    });

    describe('findByJourneyId()', () => {
      it('should find alerts for a journey', async () => {
        await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 20,
        });

        await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 30,
        });

        const alerts = await delayAlertRepository.findByJourneyId(testJourneyId);

        expect(alerts).toHaveLength(2);
      });
    });

    describe('findUntriggeredClaimEligible()', () => {
      it('should find alerts with delay >= 15 and not triggered', async () => {
        // Eligible (>= 15 min, not triggered)
        await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 20,
          claim_triggered: false,
        });

        // Not eligible (< 15 min)
        await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 10,
          claim_triggered: false,
        });

        // Not eligible (already triggered)
        await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 25,
          claim_triggered: true,
        });

        const eligible = await delayAlertRepository.findUntriggeredClaimEligible();

        expect(eligible).toHaveLength(1);
        expect(eligible[0].delay_minutes).toBe(20);
      });
    });

    describe('markClaimTriggered()', () => {
      it('should mark alert as claim triggered', async () => {
        const alert = await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 25,
        });

        await delayAlertRepository.markClaimTriggered(alert.id, 'claim-ref-123');

        const updated = await delayAlertRepository.findById(alert.id);

        expect(updated!.claim_triggered).toBe(true);
        expect(updated!.claim_triggered_at).toBeInstanceOf(Date);
        expect(updated!.claim_reference_id).toBe('claim-ref-123');
      });
    });

    describe('markNotificationSent()', () => {
      it('should mark alert as notification sent', async () => {
        const alert = await delayAlertRepository.create({
          monitored_journey_id: testJourneyId,
          delay_minutes: 25,
        });

        await delayAlertRepository.markNotificationSent(alert.id);

        const updated = await delayAlertRepository.findById(alert.id);

        expect(updated!.notification_sent).toBe(true);
        expect(updated!.notification_sent_at).toBeInstanceOf(Date);
      });
    });
  });

  describe('Foreign Key Relationships', () => {
    it('should cascade delete alerts when journey is deleted', async () => {
      const journey = await journeyRepository.create({
        user_id: TEST_UUIDS.USER_CASCADE,
        journey_id: TEST_UUIDS.JOURNEY_CASCADE,
        rid: '202601150800789',
        service_date: '2026-01-15',
        origin_crs: 'MAN',
        destination_crs: 'LDS',
        scheduled_departure: '2026-01-15T09:00:00Z',
        scheduled_arrival: '2026-01-15T10:00:00Z',
        monitoring_status: 'delayed',
      });

      await delayAlertRepository.create({
        monitored_journey_id: journey.id,
        delay_minutes: 20,
      });

      // Verify alert exists
      const alertsBefore = await delayAlertRepository.findByJourneyId(journey.id);
      expect(alertsBefore).toHaveLength(1);

      // Delete journey
      await journeyRepository.delete(journey.id);

      // Verify alert was cascade deleted
      const alertsAfter = await delayAlertRepository.findByJourneyId(journey.id);
      expect(alertsAfter).toHaveLength(0);
    });

    it('should reject alert creation with invalid journey id', async () => {
      await expect(
        delayAlertRepository.create({
          monitored_journey_id: '00000000-0000-0000-0000-000000000000',
          delay_minutes: 20,
        })
      ).rejects.toThrow();
    });
  });
});
