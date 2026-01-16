/**
 * Integration Tests: Outbox Event Publishing
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for the transactional outbox pattern:
 * 1. Events are written to outbox table within transaction
 * 2. Events are published reliably
 * 3. Events are marked as processed after publishing
 *
 * Uses Testcontainers for real PostgreSQL integration.
 *
 * NOTE: These tests should FAIL until Blake implements the outbox publisher.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { OutboxRepository } from '../../src/repositories/outbox-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { OutboxPublisher, OutboxEvent } from '../../src/services/outbox-publisher.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyRepository } from '../../src/repositories/journey-repository.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayAlertRepository } from '../../src/repositories/delay-alert-repository.js';

// Import fixtures
import {
  delayWithClaimTriggered,
  delayPendingClaimTrigger,
} from '../fixtures/db/delay-alerts.fixtures.js';

import {
  activeJourneyWithRid,
} from '../fixtures/db/monitored-journeys.fixtures.js';

describe('Outbox Event Publishing Integration', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let outboxRepository: OutboxRepository;
  let outboxPublisher: OutboxPublisher;

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
    // Clean up tables before each test
    await pool.query('DELETE FROM delay_tracker.outbox');
    await pool.query('DELETE FROM delay_tracker.delay_alerts');
    await pool.query('DELETE FROM delay_tracker.monitored_journeys');

    outboxRepository = new OutboxRepository({ pool });
    outboxPublisher = new OutboxPublisher({
      repository: outboxRepository,
      pool,
    });
  });

  describe('OutboxRepository', () => {
    describe('Create Event', () => {
      it('should create outbox event with pending status', async () => {
        const event: OutboxEvent = {
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {
            journeyId: 'journey-001',
            delayMinutes: 25,
            userId: 'user-001',
          },
        };

        const created = await outboxRepository.create(event);

        expect(created.id).toBeDefined();
        expect(created.event_type).toBe('delay.detected');
        expect(created.status).toBe('pending');
        expect(created.created_at).toBeInstanceOf(Date);
      });

      it('should store payload as JSONB', async () => {
        const complexPayload = {
          journeyId: 'journey-001',
          delayMinutes: 25,
          delayReasons: { reason: 'Signal failure', secondary: 'Staff shortage' },
          metadata: { source: 'darwin', version: '2.0' },
        };

        const event: OutboxEvent = {
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: complexPayload,
        };

        const created = await outboxRepository.create(event);
        const retrieved = await outboxRepository.findById(created.id!);

        expect(retrieved?.payload).toEqual(complexPayload);
      });

      it('should set retry_count to 0 initially', async () => {
        const event: OutboxEvent = {
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        };

        const created = await outboxRepository.create(event);

        expect(created.retry_count).toBe(0);
      });
    });

    describe('Find Pending Events', () => {
      it('should find events with pending status', async () => {
        // Create multiple events
        await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });
        await outboxRepository.create({
          event_type: 'claim.triggered',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-002',
          payload: {},
        });

        const pending = await outboxRepository.findPending();

        expect(pending).toHaveLength(2);
        expect(pending.every(e => e.status === 'pending')).toBe(true);
      });

      it('should not return processed events', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markProcessed(event.id!);

        const pending = await outboxRepository.findPending();

        expect(pending).toHaveLength(0);
      });

      it('should order by created_at ascending (oldest first)', async () => {
        // Create events with slight delay
        await outboxRepository.create({
          event_type: 'first.event',
          aggregate_type: 'test',
          aggregate_id: '1',
          payload: {},
        });

        await new Promise(resolve => setTimeout(resolve, 10));

        await outboxRepository.create({
          event_type: 'second.event',
          aggregate_type: 'test',
          aggregate_id: '2',
          payload: {},
        });

        const pending = await outboxRepository.findPending();

        expect(pending[0].event_type).toBe('first.event');
        expect(pending[1].event_type).toBe('second.event');
      });

      it('should limit results when specified', async () => {
        // Create 5 events
        for (let i = 0; i < 5; i++) {
          await outboxRepository.create({
            event_type: `event.${i}`,
            aggregate_type: 'test',
            aggregate_id: `${i}`,
            payload: {},
          });
        }

        const limited = await outboxRepository.findPending(3);

        expect(limited).toHaveLength(3);
      });
    });

    describe('Mark Processed', () => {
      it('should update status to processed', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markProcessed(event.id!);

        const updated = await outboxRepository.findById(event.id!);
        expect(updated?.status).toBe('processed');
      });

      it('should set processed_at timestamp', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markProcessed(event.id!);

        const updated = await outboxRepository.findById(event.id!);
        expect(updated?.processed_at).toBeInstanceOf(Date);
      });
    });

    describe('Mark Failed', () => {
      it('should update status to failed', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markFailed(event.id!, 'Connection timeout');

        const updated = await outboxRepository.findById(event.id!);
        expect(updated?.status).toBe('failed');
      });

      it('should store error message', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markFailed(event.id!, 'Connection timeout');

        const updated = await outboxRepository.findById(event.id!);
        expect(updated?.error_message).toBe('Connection timeout');
      });

      it('should increment retry_count', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markFailed(event.id!, 'Error 1');
        let updated = await outboxRepository.findById(event.id!);
        expect(updated?.retry_count).toBe(1);

        // Reset to pending for retry
        await outboxRepository.resetToPending(event.id!);
        await outboxRepository.markFailed(event.id!, 'Error 2');
        updated = await outboxRepository.findById(event.id!);
        expect(updated?.retry_count).toBe(2);
      });
    });

    describe('Find Failed Events for Retry', () => {
      it('should find failed events below max retry count', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        await outboxRepository.markFailed(event.id!, 'First failure');

        const failed = await outboxRepository.findFailedForRetry(3); // max 3 retries

        expect(failed).toHaveLength(1);
        expect(failed[0].id).toBe(event.id);
      });

      it('should not return events at max retry count', async () => {
        const event = await outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'delay_alert',
          aggregate_id: 'alert-001',
          payload: {},
        });

        // Fail 3 times
        for (let i = 0; i < 3; i++) {
          await outboxRepository.markFailed(event.id!, `Failure ${i + 1}`);
          if (i < 2) await outboxRepository.resetToPending(event.id!);
        }

        const failed = await outboxRepository.findFailedForRetry(3);

        expect(failed).toHaveLength(0);
      });
    });

    describe('Cleanup Old Events', () => {
      it('should delete processed events older than retention period', async () => {
        const event = await outboxRepository.create({
          event_type: 'old.event',
          aggregate_type: 'test',
          aggregate_id: '1',
          payload: {},
        });

        await outboxRepository.markProcessed(event.id!);

        // Manually update created_at to simulate old event
        await pool.query(
          `UPDATE delay_tracker.outbox
           SET created_at = NOW() - INTERVAL '8 days'
           WHERE id = $1`,
          [event.id]
        );

        const deleted = await outboxRepository.cleanupOldEvents(7); // 7 days retention

        expect(deleted).toBe(1);
      });

      it('should not delete pending events regardless of age', async () => {
        const event = await outboxRepository.create({
          event_type: 'old.pending',
          aggregate_type: 'test',
          aggregate_id: '1',
          payload: {},
        });

        // Make it old but keep pending
        await pool.query(
          `UPDATE delay_tracker.outbox
           SET created_at = NOW() - INTERVAL '30 days'
           WHERE id = $1`,
          [event.id]
        );

        const deleted = await outboxRepository.cleanupOldEvents(7);

        expect(deleted).toBe(0);
        const stillExists = await outboxRepository.findById(event.id!);
        expect(stillExists).toBeDefined();
      });
    });
  });

  describe('OutboxPublisher', () => {
    describe('Publish Delay Detected Event', () => {
      it('should create outbox event for delay detection', async () => {
        const delayData = {
          journeyId: 'journey-001',
          alertId: 'alert-001',
          userId: 'user-001',
          delayMinutes: 25,
          delayReasons: { reason: 'Signal failure' },
        };

        await outboxPublisher.publishDelayDetected(delayData);

        const pending = await outboxRepository.findPending();
        expect(pending).toHaveLength(1);
        expect(pending[0].event_type).toBe('delay.detected');
        expect(pending[0].payload.delayMinutes).toBe(25);
      });

      it('should use correct aggregate type and ID', async () => {
        await outboxPublisher.publishDelayDetected({
          journeyId: 'journey-001',
          alertId: 'alert-123',
          userId: 'user-001',
          delayMinutes: 20,
        });

        const pending = await outboxRepository.findPending();
        expect(pending[0].aggregate_type).toBe('delay_alert');
        expect(pending[0].aggregate_id).toBe('alert-123');
      });
    });

    describe('Publish Claim Triggered Event', () => {
      it('should create outbox event for claim trigger', async () => {
        const claimData = {
          alertId: 'alert-001',
          journeyId: 'journey-001',
          userId: 'user-001',
          claimReferenceId: 'claim-ref-001',
          delayMinutes: 25,
        };

        await outboxPublisher.publishClaimTriggered(claimData);

        const pending = await outboxRepository.findPending();
        expect(pending).toHaveLength(1);
        expect(pending[0].event_type).toBe('claim.triggered');
        expect(pending[0].payload.claimReferenceId).toBe('claim-ref-001');
      });
    });

    describe('Publish Journey Completed Event', () => {
      it('should create outbox event for journey completion', async () => {
        await outboxPublisher.publishJourneyCompleted({
          journeyId: 'journey-001',
          userId: 'user-001',
          completedAt: new Date('2026-01-15T12:30:00Z'),
          hadDelay: true,
          delayMinutes: 25,
        });

        const pending = await outboxRepository.findPending();
        expect(pending).toHaveLength(1);
        expect(pending[0].event_type).toBe('journey.completed');
      });
    });

    describe('Transactional Event Creation', () => {
      it('should create event within provided transaction', async () => {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          // Create journey first
          const journeyRepository = new JourneyRepository({ pool });
          const journey = await journeyRepository.create({
            ...activeJourneyWithRid,
            user_id: 'e2e00080-0080-4080-8080-000000000001', // Valid UUID for tx test
            journey_id: 'e2e00080-0080-4080-8080-000000000002', // Unique journey_id to avoid conflicts
          }, client);

          // Create event in same transaction
          await outboxPublisher.publishDelayDetected({
            journeyId: journey.id!,
            alertId: 'alert-tx-001',
            userId: 'user-tx-test',
            delayMinutes: 20,
          }, client);

          await client.query('COMMIT');

          // Both should exist
          const savedJourney = await journeyRepository.findById(journey.id!);
          const pending = await outboxRepository.findPending();

          expect(savedJourney).toBeDefined();
          expect(pending).toHaveLength(1);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });

      it('should rollback event if transaction fails', async () => {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          // Create event
          await outboxPublisher.publishDelayDetected({
            journeyId: 'journey-rollback',
            alertId: 'alert-rollback',
            userId: 'user-rollback',
            delayMinutes: 20,
          }, client);

          // Force rollback
          await client.query('ROLLBACK');

          // Event should not exist
          const pending = await outboxRepository.findPending();
          expect(pending).toHaveLength(0);
        } finally {
          client.release();
        }
      });
    });

    describe('Process Pending Events', () => {
      it('should process pending events and mark as processed', async () => {
        // Create pending events
        await outboxPublisher.publishDelayDetected({
          journeyId: 'journey-001',
          alertId: 'alert-001',
          userId: 'user-001',
          delayMinutes: 20,
        });

        // Mock message broker
        const mockBroker = {
          publish: vi.fn().mockResolvedValue(true),
        };

        const publisher = new OutboxPublisher({
          repository: outboxRepository,
          pool,
          messageBroker: mockBroker,
        });

        await publisher.processOutbox();

        expect(mockBroker.publish).toHaveBeenCalled();
        const pending = await outboxRepository.findPending();
        expect(pending).toHaveLength(0);
      });

      it('should mark event as failed on publish error', async () => {
        await outboxPublisher.publishDelayDetected({
          journeyId: 'journey-001',
          alertId: 'alert-001',
          userId: 'user-001',
          delayMinutes: 20,
        });

        const mockBroker = {
          publish: vi.fn().mockRejectedValue(new Error('Broker unavailable')),
        };

        const publisher = new OutboxPublisher({
          repository: outboxRepository,
          pool,
          messageBroker: mockBroker,
        });

        await publisher.processOutbox();

        const events = await pool.query(
          'SELECT * FROM delay_tracker.outbox WHERE status = $1',
          ['failed']
        );
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0].error_message).toContain('Broker unavailable');
      });

      it('should retry failed events up to max retries', async () => {
        const event = await outboxRepository.create({
          event_type: 'retry.test',
          aggregate_type: 'test',
          aggregate_id: '1',
          payload: {},
        });

        await outboxRepository.markFailed(event.id!, 'Initial failure');

        const mockBroker = {
          publish: vi.fn().mockResolvedValue(true),
        };

        const publisher = new OutboxPublisher({
          repository: outboxRepository,
          pool,
          messageBroker: mockBroker,
          maxRetries: 3,
        });

        await publisher.retryFailedEvents();

        expect(mockBroker.publish).toHaveBeenCalled();
      });
    });

    describe('Event Correlation', () => {
      it('should include correlation ID in event payload', async () => {
        await outboxPublisher.publishDelayDetected({
          journeyId: 'journey-001',
          alertId: 'alert-001',
          userId: 'user-001',
          delayMinutes: 20,
          correlationId: 'corr-123-456',
        });

        const pending = await outboxRepository.findPending();
        expect(pending[0].payload.correlationId).toBe('corr-123-456');
      });

      it('should generate correlation ID if not provided', async () => {
        await outboxPublisher.publishDelayDetected({
          journeyId: 'journey-001',
          alertId: 'alert-001',
          userId: 'user-001',
          delayMinutes: 20,
        });

        const pending = await outboxRepository.findPending();
        expect(pending[0].payload.correlationId).toBeDefined();
        expect(typeof pending[0].payload.correlationId).toBe('string');
      });
    });
  });

  describe('Event Types', () => {
    it('should support all delay-tracker event types', async () => {
      const eventTypes = [
        'delay.detected',
        'delay.threshold_exceeded',
        'claim.triggered',
        'claim.trigger_failed',
        'journey.monitoring_started',
        'journey.completed',
        'journey.cancelled',
      ];

      for (const eventType of eventTypes) {
        await outboxRepository.create({
          event_type: eventType,
          aggregate_type: 'test',
          aggregate_id: `test-${eventType}`,
          payload: { eventType },
        });
      }

      const pending = await outboxRepository.findPending();
      expect(pending).toHaveLength(eventTypes.length);
    });
  });

  describe('Concurrency Safety', () => {
    it('should handle concurrent event creation', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        outboxPublisher.publishDelayDetected({
          journeyId: `journey-${i}`,
          alertId: `alert-${i}`,
          userId: `user-${i}`,
          delayMinutes: 15 + i,
        })
      );

      await Promise.all(promises);

      const pending = await outboxRepository.findPending();
      expect(pending).toHaveLength(10);
    });

    it('should prevent duplicate processing with row locking', async () => {
      // Create event
      await outboxRepository.create({
        event_type: 'concurrent.test',
        aggregate_type: 'test',
        aggregate_id: '1',
        payload: {},
      });

      // Simulate concurrent processing attempts
      const processAttempts: boolean[] = [];

      const mockBroker = {
        publish: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return true;
        }),
      };

      const publisher = new OutboxPublisher({
        repository: outboxRepository,
        pool,
        messageBroker: mockBroker,
      });

      // Start two concurrent processing attempts
      await Promise.all([
        publisher.processOutbox().then(() => processAttempts.push(true)),
        publisher.processOutbox().then(() => processAttempts.push(true)),
      ]);

      // Event should only be published once
      expect(mockBroker.publish).toHaveBeenCalledTimes(1);
    });
  });
});

// Need to import vi for mocking
import { vi } from 'vitest';
