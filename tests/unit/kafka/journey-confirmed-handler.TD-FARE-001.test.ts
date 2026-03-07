/**
 * TD-TICKET-FARE-001: Ticket Fare Data Propagation — delay-tracker Tests
 *
 * BL-160 | Severity: BLOCKING | Domain: Eligibility & Compensation
 *
 * TD CONTEXT: delay-tracker receives journey.confirmed events but
 * JourneyConfirmedPayload lacks ticket fields. The delay.detected outbox
 * event also omits ticket fields, breaking fare propagation to eligibility-engine.
 *
 * REQUIRED FIXES (this service):
 *   AC-3: JourneyConfirmedPayload interface extended with optional
 *         ticket_fare_pence, ticket_class, ticket_type fields
 *   AC-3: delay.detected outbox event payload forwards those ticket fields
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially (RED phase).
 * Blake will make them GREEN in Phase TD-2.
 *
 * Test Lock Rule (ADR-014): Blake MUST NOT modify these tests.
 * If Blake believes a test is wrong, hand back to Jessie with explanation.
 *
 * Test framework: Vitest (ADR-004). NEVER use Jest equivalents.
 *
 * Verified: delay-tracker/src/kafka/journey-confirmed-handler.ts exposes
 *   JourneyConfirmedHandler class (already exists from TD-DELAY-TRACKER-002)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JourneyConfirmedHandler } from '../../../src/kafka/journey-confirmed-handler.js';
import type { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import type { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';
import type { OutboxRepository } from '../../../src/repositories/outbox-repository.js';
import type { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';

// ─── Shared test data ─────────────────────────────────────────────────────────

// All departure datetimes are in 2024 (the past) so the handler takes the
// HISTORIC path and reaches delay.detected publishing without needing a
// monitored_journeys row. Time is fixed per describe block where needed.

const HISTORIC_DEPARTURE = '2024-06-15T09:00:00.000Z';
const HISTORIC_ARRIVAL   = '2024-06-15T10:38:00.000Z';

const basePayload = {
  journey_id:          '770e8400-e29b-41d4-a716-446655440000',
  user_id:             '880e8400-e29b-41d4-a716-446655440001',
  origin_crs:          'PAD',
  destination_crs:     'BRI',
  departure_datetime:  HISTORIC_DEPARTURE,
  arrival_datetime:    HISTORIC_ARRIVAL,
  journey_type:        'single',
  toc_code:            'GW',
  segments: [
    {
      segment_order:       1,
      origin_crs:          'PAD',
      destination_crs:     'BRI',
      scheduled_departure: HISTORIC_DEPARTURE,
      scheduled_arrival:   HISTORIC_ARRIVAL,
      rid:                 '202406150900001',
      toc_code:            'GW',
    },
  ],
  correlation_id: 'corr-fare-dt-001',
};

// Darwin response that triggers delay.detected (38-min delay >= 15-min threshold)
const DELAY_RESPONSE_38_MIN = {
  delay_minutes: 38,
  is_cancelled:  false,
};

describe('TD-TICKET-FARE-001 (BL-160): delay-tracker — ticket fare propagation', () => {
  let handler:                 JourneyConfirmedHandler;
  let mockJourneyRepository:   Partial<JourneyRepository> & { create: ReturnType<typeof vi.fn>; findByJourneyId: ReturnType<typeof vi.fn> };
  let mockDelayAlertRepository: Partial<DelayAlertRepository> & { create: ReturnType<typeof vi.fn> };
  let mockOutboxRepository:    Partial<OutboxRepository> & { create: ReturnType<typeof vi.fn> };
  let mockDarwinClient:        Partial<DarwinIngestorClient> & { getDelayInfo: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockJourneyRepository = {
      create:          vi.fn().mockResolvedValue({ id: 'monitored-journey-fare-001', journey_id: basePayload.journey_id }),
      findByJourneyId: vi.fn().mockResolvedValue(null), // No duplicate
    };

    mockDelayAlertRepository = {
      create: vi.fn().mockResolvedValue({ id: 'delay-alert-fare-001' }),
    };

    mockOutboxRepository = {
      create: vi.fn().mockResolvedValue({ id: 'outbox-fare-001' }),
    };

    mockDarwinClient = {
      getDelayInfo: vi.fn().mockResolvedValue(DELAY_RESPONSE_38_MIN),
    };

    handler = new JourneyConfirmedHandler({
      journeyRepository:    mockJourneyRepository  as JourneyRepository,
      delayAlertRepository: mockDelayAlertRepository as DelayAlertRepository,
      outboxRepository:     mockOutboxRepository   as OutboxRepository,
      darwinClient:         mockDarwinClient        as DarwinIngestorClient,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-3: delay.detected outbox event forwards ticket fields ───────────────

  describe('AC-3: delay.detected outbox payload includes ticket fare fields', () => {
    it('should include ticket_fare_pence in delay.detected payload when provided in journey.confirmed', async () => {
      // Arrange: journey.confirmed event carries £45.50 fare
      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440010',
        ticket_fare_pence: 4550,
        ticket_class:      'standard',
        ticket_type:       'off_peak',
        correlation_id:    'corr-fare-dt-ac3-a',
      };

      // Act
      await handler.handle(payload);

      // Assert: outbox event published for delay.detected
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          payload:    expect.objectContaining({
            ticket_fare_pence: 4550,
          }),
        })
      );
    });

    it('should include ticket_class in delay.detected payload when provided', async () => {
      // Arrange: first-class ticket to differentiate from previous test
      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440011',
        ticket_fare_pence: 9800,
        ticket_class:      'first',
        ticket_type:       'anytime',
        correlation_id:    'corr-fare-dt-ac3-b',
      };

      // Act
      await handler.handle(payload);

      // Assert
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          payload:    expect.objectContaining({
            ticket_class: 'first',
          }),
        })
      );
    });

    it('should include ticket_type in delay.detected payload when provided', async () => {
      // Arrange
      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440012',
        ticket_fare_pence: 2800,
        ticket_class:      'standard',
        ticket_type:       'advance',
        correlation_id:    'corr-fare-dt-ac3-c',
      };

      // Act
      await handler.handle(payload);

      // Assert
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          payload:    expect.objectContaining({
            ticket_type: 'advance',
          }),
        })
      );
    });

    it('should include all three ticket fields in delay.detected payload — full E2E scenario', async () => {
      // AC-3 + AC-6 (E2E): £45.50 standard off-peak GWR, 38-min delay
      // This mirrors the BL-160 AC-6 E2E scenario from delay-tracker's perspective
      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440013',
        ticket_fare_pence: 4550,
        ticket_class:      'standard',
        ticket_type:       'off_peak',
        correlation_id:    'corr-fare-dt-ac3-full',
      };

      // Act
      await handler.handle(payload);

      // Assert: delay.detected outbox event has all three ticket fields
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type:      'delay.detected',
          aggregate_type:  'journey',
          aggregate_id:    payload.journey_id,
          correlation_id:  payload.correlation_id,
          payload:         expect.objectContaining({
            journey_id:        payload.journey_id,
            user_id:           payload.user_id,
            delay_minutes:     38,
            is_cancellation:   false,
            toc_code:          'GW',
            ticket_fare_pence: 4550,
            ticket_class:      'standard',
            ticket_type:       'off_peak',
          }),
        })
      );
    });

    it('should set ticket_fare_pence to null in delay.detected when not present in journey.confirmed', async () => {
      // AC-7: null/missing ticket data handled gracefully
      // Arrange: no ticket fields in the incoming event
      const payload = {
        ...basePayload,
        journey_id:     '770e8400-e29b-41d4-a716-446655440014',
        correlation_id: 'corr-fare-dt-ac3-null',
        // ticket_fare_pence, ticket_class, ticket_type all absent
      };

      // Act
      await handler.handle(payload);

      // Assert: delay.detected is still published (system continues)
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          payload:    expect.objectContaining({
            // Fields must be present as null (not omitted) so downstream can
            // distinguish "not collected" from "not forwarded"
            ticket_fare_pence: null,
          }),
        })
      );
    });

    it('should forward ticket_fare_pence = 0 correctly (not treat zero as falsy/null)', async () => {
      // AC-7: zero fare is valid — must not be coerced to null
      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440015',
        ticket_fare_pence: 0,
        ticket_class:      'standard',
        ticket_type:       'free_pass',
        correlation_id:    'corr-fare-dt-ac3-zero',
      };

      // Act
      await handler.handle(payload);

      // Assert: 0 forwarded explicitly, not null
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.detected',
          payload:    expect.objectContaining({
            ticket_fare_pence: 0,
          }),
        })
      );
    });
  });

  // ─── AC-3: JourneyConfirmedPayload interface accepts ticket fields ───────────

  describe('AC-3: JourneyConfirmedPayload interface accepts ticket fields without validation error', () => {
    it('should accept payload with ticket fields and not throw on validation', async () => {
      // Arrange: payload with all ticket fields — should pass validation
      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440020',
        ticket_fare_pence: 4550,
        ticket_class:      'standard',
        ticket_type:       'off_peak',
        correlation_id:    'corr-fare-dt-iface',
      };

      // Act & Assert: must not throw
      await expect(handler.handle(payload)).resolves.not.toThrow();
    });

    it('should accept payload without ticket fields (backward compatibility)', async () => {
      // Ticket fields are optional — existing events without them must still work
      const payload = {
        ...basePayload,
        journey_id:     '770e8400-e29b-41d4-a716-446655440021',
        correlation_id: 'corr-fare-dt-backcompat',
      };

      // Act & Assert: must not throw
      await expect(handler.handle(payload)).resolves.not.toThrow();
    });
  });

  // ─── AC-3: ticket fields NOT included in delay.not-detected (no blocker) ────

  describe('AC-3: delay.not-detected events are unaffected (below-threshold path)', () => {
    it('should NOT block processing when delay is below threshold and ticket fields are present', async () => {
      // Arrange: small delay — handler takes below_threshold path
      mockDarwinClient.getDelayInfo = vi.fn().mockResolvedValue({
        delay_minutes: 5,
        is_cancelled:  false,
      });

      const payload = {
        ...basePayload,
        journey_id:        '770e8400-e29b-41d4-a716-446655440030',
        ticket_fare_pence: 4550,
        ticket_class:      'standard',
        ticket_type:       'off_peak',
        correlation_id:    'corr-fare-dt-notdetected',
      };

      // Act
      await handler.handle(payload);

      // Assert: delay.not-detected published (not delay.detected)
      expect(mockOutboxRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'delay.not-detected',
        })
      );

      // delay.detected must NOT have been published
      const detectedCall = mockOutboxRepository.create.mock.calls.find(
        (c) => c[0].event_type === 'delay.detected'
      );
      expect(detectedCall).toBeUndefined();
    });
  });
});
