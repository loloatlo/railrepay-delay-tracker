/**
 * Unit tests for JourneyConfirmedHandler - toc_code Enrichment (BL-146)
 *
 * Phase: TD-1 Test Specification (Jessie)
 * Author: Jessie (QA Engineer)
 * Date: 2026-02-15
 *
 * PURPOSE:
 * Tests for the ENRICHED delay.detected outbox event payload that includes toc_code.
 * This is a surgical change to delay-tracker to support evaluation-coordinator.
 *
 * ACCEPTANCE CRITERIA COVERAGE:
 * - AC-10: delay.detected event enriched with toc_code (delay-tracker change)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JourneyConfirmedHandler } from '../../../src/kafka/journey-confirmed-handler.js';
import type { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import type { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';
import type { OutboxRepository } from '../../../src/repositories/outbox-repository.js';
import type { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';

describe('BL-146: JourneyConfirmedHandler - toc_code Enrichment', () => {
  let handler: JourneyConfirmedHandler;
  let mockJourneyRepository: jest.Mocked<JourneyRepository>;
  let mockDelayAlertRepository: jest.Mocked<DelayAlertRepository>;
  let mockOutboxRepository: jest.Mocked<OutboxRepository>;
  let mockDarwinClient: jest.Mocked<DarwinIngestorClient>;

  const journeyId = '550e8400-e29b-41d4-a716-446655440000';
  const userId = '660e8400-e29b-41d4-a716-446655440001';
  const correlationId = '123e4567-e89b-42d3-a456-426614174000';

  beforeEach(() => {
    // Create mock dependencies
    mockJourneyRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'monitored-journey-123',
        journey_id: journeyId,
        status: 'pending'
      }),
      findById: vi.fn(),
      findByJourneyId: vi.fn().mockResolvedValue(null), // No existing journey (idempotency check passes)
      updateStatus: vi.fn()
    } as any;

    mockDelayAlertRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'delay-alert-123',
        journey_id: journeyId,
        delay_minutes: 45
      }),
      findByJourneyId: vi.fn()
    } as any;

    mockOutboxRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'outbox-event-123'
      })
    } as any;

    mockDarwinClient = {
      getDelayInfo: vi.fn()
    } as any;

    // Create handler with mocked dependencies
    handler = new JourneyConfirmedHandler({
      journeyRepository: mockJourneyRepository,
      delayAlertRepository: mockDelayAlertRepository,
      outboxRepository: mockOutboxRepository,
      darwinClient: mockDarwinClient
    });

    vi.clearAllMocks();
  });

  /**
   * AC-10: delay.detected outbox event includes toc_code from payload
   */
  it('should include toc_code in delay.detected outbox event payload', async () => {
    // Arrange
    const payload = {
      journey_id: journeyId,
      user_id: userId,
      origin_crs: 'PAD',
      destination_crs: 'OXF',
      departure_datetime: '2026-02-15T08:00:00Z',
      arrival_datetime: '2026-02-15T09:00:00Z',
      journey_type: 'single',
      toc_code: 'GW', // Great Western Railway
      segments: [
        {
          segment_order: 1,
          origin_crs: 'PAD',
          destination_crs: 'OXF',
          scheduled_departure: '2026-02-15T08:00:00Z',
          scheduled_arrival: '2026-02-15T09:00:00Z',
          rid: '202602150001',
          toc_code: 'GW'
        }
      ],
      correlation_id: correlationId
    };

    // Mock Darwin client returns delay info (45-minute delay)
    mockDarwinClient.getDelayInfo.mockResolvedValue({
      delay_minutes: 45,
      is_cancelled: false,
      actual_arrival: '2026-02-15T09:45:00Z'
    });

    // Act
    await handler.handle(payload);

    // Assert - AC-10: Outbox event for delay.detected includes toc_code
    expect(mockOutboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'delay.detected',
        aggregate_type: 'journey',
        aggregate_id: journeyId,
        payload: expect.objectContaining({
          journey_id: journeyId,
          user_id: userId,
          delay_minutes: 45,
          is_cancellation: false,
          toc_code: 'GW' // AC-10: toc_code MUST be included
        }),
        correlation_id: correlationId
      })
    );
  });

  /**
   * AC-10: toc_code from different TOC (Avanti West Coast)
   */
  it('should include toc_code for different TOC operators', async () => {
    // Arrange
    const payload = {
      journey_id: journeyId,
      user_id: userId,
      origin_crs: 'EUS',
      destination_crs: 'MAN',
      departure_datetime: '2024-01-01T10:00:00Z', // Past timestamp to trigger historic path
      arrival_datetime: '2024-01-01T12:30:00Z',
      journey_type: 'single',
      toc_code: 'VT', // Avanti West Coast
      segments: [
        {
          segment_order: 1,
          origin_crs: 'EUS',
          destination_crs: 'MAN',
          scheduled_departure: '2024-01-01T10:00:00Z', // Past timestamp
          scheduled_arrival: '2024-01-01T12:30:00Z',
          rid: '202602150002',
          toc_code: 'VT'
        }
      ],
      correlation_id: correlationId
    };

    // Mock Darwin client returns delay info (60-minute delay)
    mockDarwinClient.getDelayInfo.mockResolvedValue({
      delay_minutes: 60,
      is_cancelled: false,
      actual_arrival: '2026-02-15T13:30:00Z'
    });

    // Act
    await handler.handle(payload);

    // Assert - AC-10: toc_code is 'VT' in outbox event
    expect(mockOutboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'delay.detected',
        payload: expect.objectContaining({
          journey_id: journeyId,
          user_id: userId,
          delay_minutes: 60,
          is_cancellation: false,
          toc_code: 'VT' // AC-10: Avanti West Coast TOC code
        }),
        correlation_id: correlationId
      })
    );
  });

  /**
   * AC-10: toc_code included even for cancellations
   */
  it('should include toc_code in delay.detected event for cancellations', async () => {
    // Arrange
    const payload = {
      journey_id: journeyId,
      user_id: userId,
      origin_crs: 'PAD',
      destination_crs: 'OXF',
      departure_datetime: '2026-02-15T08:00:00Z',
      arrival_datetime: '2026-02-15T09:00:00Z',
      journey_type: 'single',
      toc_code: 'GW',
      segments: [
        {
          segment_order: 1,
          origin_crs: 'PAD',
          destination_crs: 'OXF',
          scheduled_departure: '2026-02-15T08:00:00Z',
          scheduled_arrival: '2026-02-15T09:00:00Z',
          rid: '202602150001',
          toc_code: 'GW'
        }
      ],
      correlation_id: correlationId
    };

    // Mock Darwin client returns cancellation
    mockDarwinClient.getDelayInfo.mockResolvedValue({
      delay_minutes: 0,
      is_cancelled: true,
      actual_arrival: null
    });

    // Act
    await handler.handle(payload);

    // Assert - AC-10: toc_code included for cancellations too
    expect(mockOutboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'delay.detected',
        payload: expect.objectContaining({
          journey_id: journeyId,
          user_id: userId,
          delay_minutes: 0,
          is_cancellation: true,
          toc_code: 'GW' // AC-10: toc_code present even for cancellations
        }),
        correlation_id: correlationId
      })
    );
  });

  /**
   * Edge Case: Multi-segment journey (should use journey-level toc_code)
   */
  it('should use journey-level toc_code for multi-segment journeys', async () => {
    // Arrange
    const payload = {
      journey_id: journeyId,
      user_id: userId,
      origin_crs: 'PAD',
      destination_crs: 'BHM',
      departure_datetime: '2026-02-15T08:00:00Z',
      arrival_datetime: '2026-02-15T11:00:00Z',
      journey_type: 'multi-segment',
      toc_code: 'GW', // Journey-level TOC code
      segments: [
        {
          segment_order: 1,
          origin_crs: 'PAD',
          destination_crs: 'OXF',
          scheduled_departure: '2026-02-15T08:00:00Z',
          scheduled_arrival: '2026-02-15T09:00:00Z',
          rid: '202602150001',
          toc_code: 'GW'
        },
        {
          segment_order: 2,
          origin_crs: 'OXF',
          destination_crs: 'BHM',
          scheduled_departure: '2026-02-15T09:30:00Z',
          scheduled_arrival: '2026-02-15T11:00:00Z',
          rid: '202602150002',
          toc_code: 'XC' // Different TOC for segment 2
        }
      ],
      correlation_id: correlationId
    };

    // Mock Darwin client returns delay info (30-minute delay)
    mockDarwinClient.getDelayInfo.mockResolvedValue({
      delay_minutes: 30,
      is_cancelled: false,
      actual_arrival: '2026-02-15T11:30:00Z'
    });

    // Act
    await handler.handle(payload);

    // Assert - AC-10: Uses journey-level toc_code, not segment-level
    expect(mockOutboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'delay.detected',
        payload: expect.objectContaining({
          journey_id: journeyId,
          user_id: userId,
          delay_minutes: 30,
          is_cancellation: false,
          toc_code: 'GW' // AC-10: Journey-level toc_code used
        }),
        correlation_id: correlationId
      })
    );
  });

  /**
   * Verification: delay.not-detected event does NOT need toc_code
   * (AC-10 only applies to delay.detected)
   */
  it('should NOT include toc_code in delay.not-detected event (below threshold)', async () => {
    // Arrange
    const payload = {
      journey_id: journeyId,
      user_id: userId,
      origin_crs: 'PAD',
      destination_crs: 'OXF',
      departure_datetime: '2026-02-15T08:00:00Z',
      arrival_datetime: '2026-02-15T09:00:00Z',
      journey_type: 'single',
      toc_code: 'GW',
      segments: [
        {
          segment_order: 1,
          origin_crs: 'PAD',
          destination_crs: 'OXF',
          scheduled_departure: '2026-02-15T08:00:00Z',
          scheduled_arrival: '2026-02-15T09:00:00Z',
          rid: '202602150001',
          toc_code: 'GW'
        }
      ],
      correlation_id: correlationId
    };

    // Mock Darwin client returns delay below threshold (10 minutes)
    mockDarwinClient.getDelayInfo.mockResolvedValue({
      delay_minutes: 10, // Below 15-minute threshold
      is_cancelled: false,
      actual_arrival: '2026-02-15T09:10:00Z'
    });

    // Act
    await handler.handle(payload);

    // Assert - delay.not-detected event written (no toc_code required)
    expect(mockOutboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'delay.not-detected',
        aggregate_type: 'journey',
        aggregate_id: journeyId,
        payload: expect.objectContaining({
          journey_id: journeyId,
          user_id: userId,
          reason: 'below_threshold'
          // NOTE: toc_code NOT required for delay.not-detected
        }),
        correlation_id: correlationId
      })
    );
  });
});
