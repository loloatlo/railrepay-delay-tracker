/**
 * Unit Tests: TD-DELAY-TRACKER-005 - Historic Journey Delay Alert FK Fix
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * Service: delay-tracker
 * Workflow: Technical Debt Remediation
 *
 * BUG CONTEXT:
 * When historic journeys (departure < now) have delay >= 15 min, the handler
 * calls createDelayAlert() which generates a RANDOM UUID via uuidv4() for
 * monitored_journey_id. The delay_alerts table has FK constraint requiring
 * monitored_journey_id to reference a valid monitored_journeys.id row.
 * Since no monitored_journeys row is created for historic journeys, the INSERT
 * always fails with FK constraint violation.
 *
 * SECONDARY BUG:
 * The error is caught by overly broad catch block and mislabeled as
 * "darwin_unavailable" when it's actually a database error.
 *
 * FIX APPROACH:
 * 1. Create monitored_journeys row with monitoring_status='completed' BEFORE delay alert
 * 2. Use the real monitored_journeys.id as FK reference (not random UUID)
 * 3. Narrow error handling to distinguish Darwin errors from DB errors
 *
 * NOTE: These tests WILL FAIL until Blake implements the fix.
 * DO NOT modify these tests - implement the code to make them pass.
 *
 * AC Mapping (from Quinn's TD-0 spec):
 * - AC-1: Historic delayed journey creates monitored_journeys row with monitoring_status='completed'
 * - AC-2: delay_alerts.monitored_journey_id references real monitored_journeys.id (not random UUID)
 * - AC-3: delay.detected outbox event published with correct delay_minutes
 * - AC-4: Error handling distinguishes Darwin API errors from DB errors
 * - AC-5: Historic journeys with delay < 15 min -> delay.not-detected reason below_threshold (regression)
 * - AC-6: Darwin API failure -> delay.not-detected reason darwin_unavailable (regression)
 * - AC-7: Duplicate events are idempotently skipped
 *
 * IMPORTANT: This new test file supersedes the assertion in TD-DELAY-TRACKER-002
 * line 256 which expects NO monitored_journeys row for historic journeys.
 * After this fix, historic DELAYED journeys WILL create monitored_journeys rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JourneyConfirmedHandler } from '../../src/kafka/journey-confirmed-handler.js';
import { JourneyRepository } from '../../src/repositories/journey-repository.js';
import { DelayAlertRepository } from '../../src/repositories/delay-alert-repository.js';
import { OutboxRepository } from '../../src/repositories/outbox-repository.js';
import { DarwinIngestorClient } from '../../src/clients/darwin-ingestor.js';

/**
 * Valid historic journey payload with delay >= 15 min
 * This journey should trigger the createDelayAlert() path
 */
const historicDelayedPayload = {
  journey_id: '550e8400-e29b-41d4-a716-446655440020',
  user_id: '123e4567-e89b-12d3-a456-426614174000',
  origin_crs: 'PAD',
  destination_crs: 'CDF',
  departure_datetime: '2026-02-09T15:48:00.000Z', // Past datetime
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
      rid: '202602098022634',
      toc_code: 'GW',
    },
  ],
  correlation_id: '660e9500-f39c-52e5-b827-557766551120',
};

describe('TD-DELAY-TRACKER-005: Historic Journey Delay Alert FK Fix', () => {
  let handler: JourneyConfirmedHandler;
  let mockJourneyRepository: JourneyRepository;
  let mockDelayAlertRepository: DelayAlertRepository;
  let mockOutboxRepository: OutboxRepository;
  let mockDarwinClient: DarwinIngestorClient;

  beforeEach(() => {
    // Mock current time to 2026-02-10 (after historic journey departure)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

    // Mock repositories
    mockJourneyRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'monitored-journey-uuid-123',
        journey_id: '550e8400-e29b-41d4-a716-446655440020',
        user_id: '123e4567-e89b-12d3-a456-426614174000',
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        scheduled_departure: new Date('2026-02-09T15:48:00.000Z'),
        scheduled_arrival: new Date('2026-02-09T17:37:00.000Z'),
        monitoring_status: 'completed',
        last_checked_at: null,
        next_check_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      }),
      findByJourneyId: vi.fn().mockResolvedValue(null), // No duplicate by default
      update: vi.fn(),
    } as unknown as JourneyRepository;

    mockDelayAlertRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'delay-alert-uuid-456',
        monitored_journey_id: 'monitored-journey-uuid-123',
        delay_minutes: 34,
        delay_detected_at: new Date(),
        delay_reasons: null,
        is_cancellation: false,
        threshold_exceeded: true,
        claim_triggered: false,
        claim_triggered_at: null,
        claim_reference_id: null,
        claim_trigger_response: null,
        notification_sent: false,
        notification_sent_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      }),
    } as unknown as DelayAlertRepository;

    mockOutboxRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'outbox-event-uuid-789',
        event_type: 'delay.detected',
        aggregate_type: 'journey',
        aggregate_id: '550e8400-e29b-41d4-a716-446655440020',
        payload: {},
        correlation_id: '660e9500-f39c-52e5-b827-557766551120',
        status: 'pending',
        retry_count: 0,
        error_message: null,
        created_at: new Date(),
        processed_at: null,
      }),
    } as unknown as OutboxRepository;

    // Mock Darwin client - default: 34 minute delay (exceeds 15 min threshold)
    mockDarwinClient = {
      getDelayInfo: vi.fn().mockResolvedValue({
        delay_minutes: 34,
        is_cancelled: false,
        delay_reasons: { reason: 'Signal failure at Reading' },
      }),
    } as unknown as DarwinIngestorClient;

    handler = new JourneyConfirmedHandler({
      journeyRepository: mockJourneyRepository,
      delayAlertRepository: mockDelayAlertRepository,
      outboxRepository: mockOutboxRepository,
      darwinClient: mockDarwinClient,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('AC-1: Historic delayed journey creates monitored_journeys row with monitoring_status="completed"', () => {
    it('should create monitored_journeys row BEFORE delay alert when delay >= 15 min', async () => {
      await handler.handle(historicDelayedPayload);

      // AC-1: Verify monitored_journeys row is created
      expect(mockJourneyRepository.create).toHaveBeenCalledOnce();
      expect(mockJourneyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          journey_id: '550e8400-e29b-41d4-a716-446655440020',
          user_id: '123e4567-e89b-12d3-a456-426614174000',
          rid: '202602098022634',
          service_date: '2026-02-09',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
          scheduled_departure: expect.any(Date),
          scheduled_arrival: expect.any(Date),
          monitoring_status: 'completed', // CRITICAL: Must be 'completed', not 'active'
        })
      );
    });

    it('should create completed monitored_journeys row when delay < 15 min (not-detected / below_threshold path) — BL-315 fix', async () => {
      // BL-315 root cause: publishDelayNotDetected() previously wrote ONLY to the outbox,
      // leaving no monitored_journeys row.  GET /delays/:journeyId then 404'd on every poll.
      // Fix: publishDelayNotDetected() MUST ALSO call journeyRepository.create() with
      // monitoring_status='completed' so the query endpoint returns status:'on_time' not 404.
      // The old assertion ("not.toHaveBeenCalled") encoded the *buggy* design and is replaced here.
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 10,
        is_cancelled: false,
      });

      await handler.handle(historicDelayedPayload);

      // Not-detected path MUST create a monitored_journeys row with completed status (BL-315)
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      const createArg = mockJourneyRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).toHaveProperty('monitoring_status', 'completed');
    });

    it('should create monitored_journeys row for cancelled services', async () => {
      // Mock Darwin: cancelled service (always exceeds threshold)
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 0,
        is_cancelled: true,
        delay_reasons: { reason: 'Service cancelled due to staff shortage' },
      });

      await handler.handle(historicDelayedPayload);

      // AC-1: Cancelled services should create monitored_journeys row
      expect(mockJourneyRepository.create).toHaveBeenCalledOnce();
      expect(mockJourneyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          monitoring_status: 'completed',
        })
      );
    });
  });

  describe('AC-2: delay_alerts.monitored_journey_id references real monitored_journeys.id', () => {
    it('should use the ID returned from journeyRepository.create() as FK reference', async () => {
      await handler.handle(historicDelayedPayload);

      // AC-2: Verify delay alert uses REAL monitored_journeys.id (not random UUID)
      expect(mockDelayAlertRepository.create).toHaveBeenCalledOnce();
      expect(mockDelayAlertRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          monitored_journey_id: 'monitored-journey-uuid-123', // The ID from journeyRepository.create()
          delay_minutes: 34,
          is_cancellation: false,
          threshold_exceeded: true,
        })
      );
    });

    it('should create delay alert AFTER monitored_journeys row is created', async () => {
      // Track call order
      const callOrder: string[] = [];
      mockJourneyRepository.create = vi.fn().mockImplementation(async () => {
        callOrder.push('journeyRepository.create');
        return {
          id: 'monitored-journey-uuid-123',
          journey_id: '550e8400-e29b-41d4-a716-446655440020',
          monitoring_status: 'completed',
        };
      });
      mockDelayAlertRepository.create = vi.fn().mockImplementation(async () => {
        callOrder.push('delayAlertRepository.create');
        return { id: 'delay-alert-uuid-456' };
      });

      await handler.handle(historicDelayedPayload);

      // AC-2: Verify creation order (journey BEFORE alert)
      expect(callOrder).toEqual(['journeyRepository.create', 'delayAlertRepository.create']);
    });

    it('should NOT use a random UUID for monitored_journey_id', async () => {
      await handler.handle(historicDelayedPayload);

      const delayAlertCall = mockDelayAlertRepository.create.mock.calls[0][0];
      const monitoredJourneyId = delayAlertCall.monitored_journey_id;

      // AC-2: The monitored_journey_id should match the ID returned from journeyRepository.create()
      // NOT a random UUID generated via uuidv4()
      expect(monitoredJourneyId).toBe('monitored-journey-uuid-123');
    });
  });

  describe('AC-3: delay.detected outbox event published with correct delay_minutes', () => {
    it('should publish delay.detected event after delay alert is created', async () => {
      await handler.handle(historicDelayedPayload);

      // AC-3: Verify outbox event published
      expect(mockOutboxRepository.create).toHaveBeenCalledOnce();
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          aggregate_type: 'journey',
          aggregate_id: '550e8400-e29b-41d4-a716-446655440020',
          payload: expect.objectContaining({
            journey_id: '550e8400-e29b-41d4-a716-446655440020',
            user_id: '123e4567-e89b-12d3-a456-426614174000',
            delay_minutes: 34, // From Darwin API response
            is_cancellation: false,
          }),
          correlation_id: '660e9500-f39c-52e5-b827-557766551120',
        })
      );
    });

    it('should include is_cancellation=true in delay.detected event for cancelled services', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 0,
        is_cancelled: true,
        delay_reasons: { reason: 'Service cancelled' },
      });

      await handler.handle(historicDelayedPayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          payload: expect.objectContaining({
            is_cancellation: true,
          }),
        })
      );
    });

    it('should include delay_reasons in delay alert when provided by Darwin', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 25,
        is_cancelled: false,
        delay_reasons: { reason: 'Overhead line equipment damaged', location: 'Slough' },
      });

      await handler.handle(historicDelayedPayload);

      expect(mockDelayAlertRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          delay_reasons: { reason: 'Overhead line equipment damaged', location: 'Slough' },
        })
      );
    });
  });

  describe('AC-4: Error handling distinguishes Darwin API errors from DB errors', () => {
    it('should NOT label database FK constraint error as "darwin_unavailable"', async () => {
      // Mock: journeyRepository.create() fails (simulating FK violation)
      mockJourneyRepository.create = vi.fn().mockRejectedValue(
        new Error('insert or update on table "delay_alerts" violates foreign key constraint')
      );

      // AC-4: Database error should propagate or be logged correctly (NOT as darwin_unavailable)
      await expect(handler.handle(historicDelayedPayload)).rejects.toThrow(/foreign key constraint/);

      // Should NOT publish delay.not-detected with darwin_unavailable
      const notDetectedCalls = mockOutboxRepository.create.mock.calls.filter(
        (call) => call[0].event_type === 'delay.not-detected'
      );
      expect(notDetectedCalls).toHaveLength(0);
    });

    it('should use "darwin_unavailable" reason when Darwin API call itself fails and still create completed monitored_journeys row (BL-315)', async () => {
      // BL-315 root cause: publishDelayNotDetected() previously wrote ONLY to the outbox
      // on the darwin_unavailable path, leaving no monitored_journeys row.
      // Fix: publishDelayNotDetected() MUST ALSO call journeyRepository.create() with
      // monitoring_status='completed' so GET /delays/:journeyId returns on_time not 404.
      // The old assertion ("not.toHaveBeenCalled" for journeyRepository.create) encoded the
      // *buggy* design. delayAlertRepository.create MUST still NOT be called (no false alert).
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin API timeout')
      );

      await handler.handle(historicDelayedPayload);

      // AC-4: Should publish delay.not-detected with darwin_unavailable (unchanged)
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          payload: expect.objectContaining({
            reason: 'darwin_unavailable',
          }),
        })
      );

      // BL-315: darwin_unavailable path MUST create monitored_journeys row with completed status
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      const createArg = mockJourneyRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).toHaveProperty('monitoring_status', 'completed');
      // Delay alert MUST NOT be created — no qualifying delay on darwin_unavailable path
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
    });

    it('should distinguish between Darwin 404 and DB constraint errors — Darwin 404 creates completed monitored_journeys row (BL-315)', async () => {
      // BL-315 root cause: publishDelayNotDetected() previously wrote ONLY to the outbox
      // on the darwin_unavailable (Darwin 404) path, leaving no monitored_journeys row.
      // Fix: publishDelayNotDetected() MUST ALSO call journeyRepository.create() with
      // monitoring_status='completed' so GET /delays/:journeyId returns on_time not 404.
      // The old assertion ("not.toHaveBeenCalled" for journeyRepository.create) encoded the
      // *buggy* design and is replaced here.
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin service not found: 404')
      );

      await handler.handle(historicDelayedPayload);

      // AC-4: Darwin 404 -> darwin_unavailable (expected behavior — unchanged)
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          payload: expect.objectContaining({
            reason: 'darwin_unavailable',
          }),
        })
      );

      // BL-315: Darwin 404 path MUST create monitored_journeys row (darwin_unavailable path)
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      const createArg = mockJourneyRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).toHaveProperty('monitoring_status', 'completed');
    });
  });

  describe('AC-5: Historic journeys with delay < 15 min -> delay.not-detected reason below_threshold (regression)', () => {
    it('should publish delay.not-detected with below_threshold when delay < 15 min', async () => {
      // Mock Darwin: delay below threshold
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 8,
        is_cancelled: false,
      });

      await handler.handle(historicDelayedPayload);

      // AC-5: Regression test - existing behavior should be preserved
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          aggregate_type: 'journey',
          aggregate_id: '550e8400-e29b-41d4-a716-446655440020',
          payload: expect.objectContaining({
            journey_id: '550e8400-e29b-41d4-a716-446655440020',
            user_id: '123e4567-e89b-12d3-a456-426614174000',
            reason: 'below_threshold',
          }),
          correlation_id: '660e9500-f39c-52e5-b827-557766551120',
        })
      );

      // Should NOT create delay alert — no qualifying delay on below_threshold path (invariant preserved)
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
      // BL-315: not-detected path MUST create monitored_journeys row with completed status
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      const createArg = mockJourneyRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).toHaveProperty('monitoring_status', 'completed');
    });

    it('should NOT create delay alert when delay is exactly 14 minutes, but MUST create completed monitored_journeys row (BL-315)', async () => {
      // BL-315 root cause: publishDelayNotDetected() previously wrote ONLY to the outbox,
      // leaving no monitored_journeys row.  GET /delays/:journeyId then 404'd on every poll.
      // Fix: publishDelayNotDetected() MUST ALSO call journeyRepository.create() with
      // monitoring_status='completed' so the query endpoint returns status:'on_time'.
      // The old assertion ("not.toHaveBeenCalled" for journeyRepository.create) encoded the
      // *buggy* design and is replaced here. delayAlertRepository.create MUST still NOT be called.
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 14,
        is_cancelled: false,
      });

      await handler.handle(historicDelayedPayload);

      // Below threshold (need >= 15) — no delay alert (invariant preserved)
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
      // BL-315: not-detected path MUST create monitored_journeys row with completed status
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      const createArg = mockJourneyRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).toHaveProperty('monitoring_status', 'completed');
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          payload: expect.objectContaining({
            reason: 'below_threshold',
          }),
        })
      );
    });

    it('should create delay alert when delay is exactly 15 minutes (threshold boundary)', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 15,
        is_cancelled: false,
      });

      await handler.handle(historicDelayedPayload);

      // Exactly at threshold - should create alert
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      expect(mockDelayAlertRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          delay_minutes: 15,
          threshold_exceeded: true,
        })
      );
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
        })
      );
    });
  });

  describe('AC-6: Darwin API failure -> delay.not-detected reason darwin_unavailable (regression)', () => {
    it('should publish delay.not-detected with darwin_unavailable when Darwin API fails and create completed monitored_journeys row (BL-315)', async () => {
      // BL-315 root cause: publishDelayNotDetected() previously wrote ONLY to the outbox
      // on the darwin_unavailable path, leaving no monitored_journeys row.
      // Fix: publishDelayNotDetected() MUST ALSO call journeyRepository.create() with
      // monitoring_status='completed' so GET /delays/:journeyId returns on_time not 404.
      // The old assertion ("not.toHaveBeenCalled" for journeyRepository.create) encoded the
      // *buggy* design and is replaced here. delayAlertRepository.create MUST still NOT be called.
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin API request timeout')
      );

      await handler.handle(historicDelayedPayload);

      // AC-6: Regression test - Darwin unavailability is gracefully handled (unchanged)
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          payload: expect.objectContaining({
            reason: 'darwin_unavailable',
          }),
        })
      );

      // Delay alert MUST NOT be created — no qualifying delay on darwin_unavailable path (invariant preserved)
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
      // BL-315: darwin_unavailable path MUST create monitored_journeys row with completed status
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      const createArg = mockJourneyRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).toHaveProperty('monitoring_status', 'completed');
    });

    it('should handle Darwin 500 error gracefully', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin API returned 500 Internal Server Error')
      );

      await handler.handle(historicDelayedPayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          payload: expect.objectContaining({
            reason: 'darwin_unavailable',
          }),
        })
      );
    });

    it('should NOT throw when Darwin is unavailable (graceful degradation)', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Network unreachable')
      );

      // AC-6: Should NOT throw - Darwin unavailability is expected
      await expect(handler.handle(historicDelayedPayload)).resolves.not.toThrow();
    });
  });

  describe('AC-7: Duplicate events are idempotently skipped', () => {
    it('should skip processing if journey_id already exists in monitored_journeys', async () => {
      // Mock: journey already exists
      mockJourneyRepository.findByJourneyId = vi.fn().mockResolvedValue({
        id: 'existing-monitored-journey-id',
        journey_id: '550e8400-e29b-41d4-a716-446655440020',
        monitoring_status: 'completed',
      });

      await handler.handle(historicDelayedPayload);

      // AC-7: Idempotency - should NOT create duplicate
      expect(mockJourneyRepository.create).not.toHaveBeenCalled();
      expect(mockDarwinClient.getDelayInfo).not.toHaveBeenCalled();
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
      expect(mockOutboxRepository.create).not.toHaveBeenCalled();
    });

    it('should check for duplicate via findByJourneyId before processing', async () => {
      await handler.handle(historicDelayedPayload);

      // AC-7: Verify duplicate check is performed
      expect(mockJourneyRepository.findByJourneyId).toHaveBeenCalledOnce();
      expect(mockJourneyRepository.findByJourneyId).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440020'
      );
    });

    it('should allow processing if findByJourneyId returns null (no duplicate)', async () => {
      mockJourneyRepository.findByJourneyId = vi.fn().mockResolvedValue(null);

      await handler.handle(historicDelayedPayload);

      // AC-7: Should proceed with normal processing
      expect(mockJourneyRepository.create).toHaveBeenCalled();
      expect(mockDarwinClient.getDelayInfo).toHaveBeenCalled();
      expect(mockDelayAlertRepository.create).toHaveBeenCalled();
      expect(mockOutboxRepository.create).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle multi-segment historic journey with delay', async () => {
      const multiSegmentPayload = {
        ...historicDelayedPayload,
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

      await handler.handle(multiSegmentPayload);

      // Should use first segment RID for monitored_journeys
      expect(mockJourneyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          rid: '202602091548001',
        })
      );

      // Should query Darwin with first segment RID
      expect(mockDarwinClient.getDelayInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          rid: '202602091548001',
        })
      );
    });

    it('should extract service_date from departure_datetime', async () => {
      await handler.handle(historicDelayedPayload);

      expect(mockJourneyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          service_date: '2026-02-09',
        })
      );
    });

    it('should handle delay_reasons=null from Darwin API', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 20,
        is_cancelled: false,
        delay_reasons: null,
      });

      await handler.handle(historicDelayedPayload);

      expect(mockDelayAlertRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          delay_reasons: null,
        })
      );
    });
  });
});
