/**
 * Unit Tests: TD-DELAY-TRACKER-002 - journey.confirmed Event Handler
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * Service: delay-tracker
 * Workflow: Technical Debt Remediation
 *
 * Tests the Kafka consumer handler that processes journey.confirmed events
 * from journey-matcher service. This handler routes journeys to either:
 * - HISTORIC path: Immediate Darwin delay lookup (departure < now)
 * - FUTURE path: Register for periodic monitoring (departure >= now)
 *
 * TD Context: delay-tracker currently has NO Kafka consumer. All journey
 * registration is manual. This TD adds event-driven registration.
 *
 * NOTE: These tests WILL FAIL until Blake implements the handler.
 * DO NOT modify these tests - implement the code to make them pass.
 *
 * AC Mapping (from Quinn's TD-0 spec):
 * - AC-1: Kafka consumer setup and subscription
 * - AC-2: Payload validation (journey_id, user_id, CRS codes, datetime, segments)
 * - AC-3: Historic path routing (departure < now)
 * - AC-4: Future path routing (departure >= now)
 * - AC-5: Delay calculation from Darwin
 * - AC-7: darwin_unavailable status handling
 * - AC-8: Outbox event publishing
 * - AC-9: Correlation ID propagation
 * - AC-10: Idempotent duplicate handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
 * Valid journey.confirmed event payload (from journey-matcher)
 */
const validHistoricPayload = {
  journey_id: '550e8400-e29b-41d4-a716-446655440000',
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
      rid: '202602091548001',
      toc_code: 'GW',
    },
  ],
  correlation_id: '660e9500-f39c-52e5-b827-557766551111',
};

const validFuturePayload = {
  journey_id: '550e8400-e29b-41d4-a716-446655440001',
  user_id: '123e4567-e89b-12d3-a456-426614174000',
  origin_crs: 'KGX',
  destination_crs: 'EDN',
  departure_datetime: '2026-03-15T08:00:00.000Z', // Future datetime
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
  correlation_id: '660e9500-f39c-52e5-b827-557766551112',
};

describe('TD-DELAY-TRACKER-002: journey.confirmed Event Handler', () => {
  let handler: JourneyConfirmedHandler;
  let mockJourneyRepository: JourneyRepository;
  let mockDelayAlertRepository: DelayAlertRepository;
  let mockOutboxRepository: OutboxRepository;
  let mockDarwinClient: DarwinIngestorClient;

  beforeEach(() => {
    // Mock repositories
    mockJourneyRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'monitored-journey-uuid-mock',
        journey_id: 'test-journey-id',
        monitoring_status: 'completed',
      }),
      findByJourneyId: vi.fn().mockResolvedValue(null), // No duplicate by default
      update: vi.fn(),
    } as unknown as JourneyRepository;

    mockDelayAlertRepository = {
      create: vi.fn(),
    } as unknown as DelayAlertRepository;

    mockOutboxRepository = {
      create: vi.fn(),
    } as unknown as OutboxRepository;

    // Mock Darwin client (default: no delay found)
    mockDarwinClient = {
      getDelayInfo: vi.fn().mockResolvedValue({
        delay_minutes: 0,
        is_cancelled: false,
      }),
    } as unknown as DarwinIngestorClient;

    handler = new JourneyConfirmedHandler({
      journeyRepository: mockJourneyRepository,
      delayAlertRepository: mockDelayAlertRepository,
      outboxRepository: mockOutboxRepository,
      darwinClient: mockDarwinClient,
    });
  });

  describe('AC-1: Kafka Consumer Setup', () => {
    it('should subscribe to journey.confirmed topic', () => {
      // Verify handler exposes topic subscription metadata
      expect(handler.topic).toBe('journey.confirmed');
      expect(handler.groupId).toBe('delay-tracker-consumer-group');
    });
  });

  describe('AC-2: Payload Validation', () => {
    it('should accept valid payload with all required fields', async () => {
      await expect(handler.handle(validHistoricPayload)).resolves.not.toThrow();
    });

    it('should reject payload missing journey_id', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.journey_id;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/journey_id.*required/i);
    });

    it('should reject payload missing user_id', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.user_id;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/user_id.*required/i);
    });

    it('should reject payload missing origin_crs', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.origin_crs;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/origin_crs.*required/i);
    });

    it('should reject payload missing destination_crs', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.destination_crs;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/destination_crs.*required/i);
    });

    it('should reject payload missing departure_datetime', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.departure_datetime;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/departure_datetime.*required/i);
    });

    it('should reject payload with invalid departure_datetime format', async () => {
      const invalidPayload = {
        ...validHistoricPayload,
        departure_datetime: 'not-a-valid-iso-date',
      };

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/invalid.*datetime/i);
    });

    it('should reject payload missing segments array', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.segments;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/segments.*required/i);
    });

    it('should reject payload with empty segments array', async () => {
      const invalidPayload = {
        ...validHistoricPayload,
        segments: [],
      };

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/segments.*at least one/i);
    });

    it('should reject segment missing rid', async () => {
      const invalidPayload = {
        ...validHistoricPayload,
        segments: [
          {
            segment_order: 1,
            origin_crs: 'PAD',
            destination_crs: 'CDF',
            scheduled_departure: '2026-02-09T15:48:00.000Z',
            scheduled_arrival: '2026-02-09T17:37:00.000Z',
            // rid missing
            toc_code: 'GW',
          },
        ],
      };

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/rid.*required/i);
    });

    it('should reject payload missing correlation_id', async () => {
      const invalidPayload = { ...validHistoricPayload };
      delete invalidPayload.correlation_id;

      await expect(handler.handle(invalidPayload)).rejects.toThrow(/correlation_id.*required/i);
    });
  });

  describe('AC-3: Historic Path Routing (departure < now)', () => {
    beforeEach(() => {
      // Mock current time to 2026-02-10 (after validHistoricPayload departure)
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should route historic journey to immediate Darwin lookup', async () => {
      await handler.handle(validHistoricPayload);

      // Should query Darwin for delay info
      expect(mockDarwinClient.getDelayInfo).toHaveBeenCalledWith({
        rid: '202602091548001',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });
    });

    it('should NOT create monitored_journeys row for historic journey', async () => {
      await handler.handle(validHistoricPayload);

      // Historic journeys are processed immediately, not monitored
      expect(mockJourneyRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: Future Path Routing (departure >= now)', () => {
    beforeEach(() => {
      // Mock current time to 2026-02-10 (before validFuturePayload departure)
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should create monitored_journeys record for future journey', async () => {
      await handler.handle(validFuturePayload);

      expect(mockJourneyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          journey_id: '550e8400-e29b-41d4-a716-446655440001',
          user_id: '123e4567-e89b-12d3-a456-426614174000',
          rid: '202603150800456',
          service_date: '2026-03-15',
          origin_crs: 'KGX',
          destination_crs: 'EDN',
          scheduled_departure: expect.any(Date),
          scheduled_arrival: expect.any(Date),
          monitoring_status: 'active',
        })
      );
    });

    it('should set next_check_at to 1 hour before departure', async () => {
      await handler.handle(validFuturePayload);

      const createCall = mockJourneyRepository.create.mock.calls[0][0];
      const nextCheckAt = createCall.next_check_at;

      // Expected: 2026-03-15T07:00:00.000Z (1 hour before 08:00 departure)
      const expectedTime = new Date('2026-03-15T07:00:00.000Z');
      expect(nextCheckAt).toEqual(expectedTime);
    });

    it('should NOT query Darwin for future journey', async () => {
      await handler.handle(validFuturePayload);

      // Future journeys are NOT checked immediately
      expect(mockDarwinClient.getDelayInfo).not.toHaveBeenCalled();
    });

    it('should NOT create delay_alerts row for future journey', async () => {
      await handler.handle(validFuturePayload);

      // No delay check yet, so no alert
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('AC-5: Historic Path - Delay Calculation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should create delay_alerts row when delay >= 15 minutes', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 25,
        is_cancelled: false,
        delay_reasons: { reason: 'Signal failure' },
      });

      await handler.handle(validHistoricPayload);

      expect(mockDelayAlertRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          monitored_journey_id: expect.any(String),
          delay_minutes: 25,
          delay_reasons: { reason: 'Signal failure' },
          is_cancellation: false,
          threshold_exceeded: true,
        })
      );
    });

    it('should NOT create delay_alerts row when delay < 15 minutes', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 10,
        is_cancelled: false,
      });

      await handler.handle(validHistoricPayload);

      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
    });

    it('should create delay_alerts row for cancellations', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 0,
        is_cancelled: true,
        delay_reasons: { reason: 'Service cancelled' },
      });

      await handler.handle(validHistoricPayload);

      expect(mockDelayAlertRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          delay_minutes: 0,
          is_cancellation: true,
          threshold_exceeded: true, // Cancellations always exceed threshold
        })
      );
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

    it('should handle Darwin 404 (service not found)', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin service not found: 404')
      );

      await handler.handle(validHistoricPayload);

      // Should NOT throw - Darwin unavailability is expected
      expect(mockDelayAlertRepository.create).not.toHaveBeenCalled();
    });

    it('should publish delay.not-detected event with darwin_unavailable reason when Darwin 404', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(
        new Error('Darwin service not found: 404')
      );

      await handler.handle(validHistoricPayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          aggregate_type: 'journey',
          aggregate_id: '550e8400-e29b-41d4-a716-446655440000',
          payload: expect.objectContaining({
            journey_id: '550e8400-e29b-41d4-a716-446655440000',
            user_id: '123e4567-e89b-12d3-a456-426614174000',
            reason: 'darwin_unavailable',
          }),
          correlation_id: '660e9500-f39c-52e5-b827-557766551111',
        })
      );
    });

    it('should handle Darwin timeout', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockRejectedValue(new Error('Request timeout'));

      await handler.handle(validHistoricPayload);

      // Should publish delay.not-detected with darwin_unavailable reason
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          payload: expect.objectContaining({
            reason: 'darwin_unavailable',
          }),
        })
      );
    });
  });

  describe('AC-8: Outbox Event Publishing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should publish delay.detected event when delay >= 15 minutes', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 30,
        is_cancelled: false,
      });

      await handler.handle(validHistoricPayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          aggregate_type: 'journey',
          aggregate_id: '550e8400-e29b-41d4-a716-446655440000',
          payload: expect.objectContaining({
            journey_id: '550e8400-e29b-41d4-a716-446655440000',
            user_id: '123e4567-e89b-12d3-a456-426614174000',
            delay_minutes: 30,
            is_cancellation: false,
          }),
        })
      );
    });

    it('should publish delay.not-detected event when delay < 15 minutes', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 5,
        is_cancelled: false,
      });

      await handler.handle(validHistoricPayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
          aggregate_type: 'journey',
          aggregate_id: '550e8400-e29b-41d4-a716-446655440000',
          payload: expect.objectContaining({
            journey_id: '550e8400-e29b-41d4-a716-446655440000',
            user_id: '123e4567-e89b-12d3-a456-426614174000',
            reason: 'below_threshold',
          }),
        })
      );
    });

    it('should publish journey.monitoring-registered event for future journeys', async () => {
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

      await handler.handle(validFuturePayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'journey.monitoring-registered',
          aggregate_type: 'journey',
          aggregate_id: '550e8400-e29b-41d4-a716-446655440001',
          payload: expect.objectContaining({
            journey_id: '550e8400-e29b-41d4-a716-446655440001',
            user_id: '123e4567-e89b-12d3-a456-426614174000',
            monitoring_status: 'active',
            next_check_at: expect.any(String),
          }),
        })
      );
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

    it('should propagate correlation_id to outbox event', async () => {
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 20,
        is_cancelled: false,
      });

      await handler.handle(validHistoricPayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          correlation_id: '660e9500-f39c-52e5-b827-557766551111',
        })
      );
    });

    it('should propagate correlation_id for future journey events', async () => {
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

      await handler.handle(validFuturePayload);

      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          correlation_id: '660e9500-f39c-52e5-b827-557766551112',
        })
      );
    });
  });

  describe('AC-10: Idempotent Duplicate Handling', () => {
    it('should skip processing if journey_id already exists', async () => {
      // Mock: journey already exists in monitored_journeys
      mockJourneyRepository.findByJourneyId = vi.fn().mockResolvedValue({
        id: 'existing-id',
        journey_id: '550e8400-e29b-41d4-a716-446655440001',
        monitoring_status: 'active',
      });

      await handler.handle(validFuturePayload);

      // Should NOT create duplicate
      expect(mockJourneyRepository.create).not.toHaveBeenCalled();
      expect(mockDarwinClient.getDelayInfo).not.toHaveBeenCalled();
      expect(mockOutboxRepository.create).not.toHaveBeenCalled();
    });

    it('should allow re-processing if previous attempt failed (no DB record)', async () => {
      // Mock: no existing journey (first attempt failed before DB insert)
      mockJourneyRepository.findByJourneyId = vi.fn().mockResolvedValue(null);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

      await handler.handle(validFuturePayload);

      expect(mockJourneyRepository.create).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Edge Cases', () => {
    it('should handle multi-segment journey (use first segment RID)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

      const multiSegmentPayload = {
        ...validHistoricPayload,
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

      // Should use first segment RID for Darwin lookup
      expect(mockDarwinClient.getDelayInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          rid: '202602091548001',
        })
      );

      vi.useRealTimers();
    });

    it('should extract service_date from departure_datetime', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));

      await handler.handle(validFuturePayload);

      const createCall = mockJourneyRepository.create.mock.calls[0][0];
      expect(createCall.service_date).toBe('2026-03-15');

      vi.useRealTimers();
    });
  });
});
