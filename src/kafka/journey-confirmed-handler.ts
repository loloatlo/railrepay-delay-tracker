/**
 * Journey Confirmed Event Handler
 *
 * Kafka consumer handler for journey.confirmed events from journey-matcher service.
 * Routes journeys to either:
 * - HISTORIC path: Immediate Darwin delay lookup (departure < now)
 * - FUTURE path: Register for periodic monitoring (departure >= now)
 *
 * Per ADR-007: Transactional outbox pattern for event publishing
 * Per TD-DELAY-TRACKER-002: Event-driven journey registration
 */

import { JourneyRepository } from '../repositories/journey-repository.js';
import { DelayAlertRepository } from '../repositories/delay-alert-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { DarwinIngestorClient } from '../clients/darwin-ingestor.js';
import {
  SequentialLegWalk,
  type TiplocRepository,
  type DarwinClient,
  type OtpClient,
  type LegWalkResult,
} from '../services/sequential-leg-walk.js';

interface JourneySegment {
  segment_order: number;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  rid: string;
  toc_code: string;
}

export interface JourneyConfirmedPayload {
  journey_id: string;
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  departure_datetime: string;
  arrival_datetime: string;
  journey_type: string;
  toc_code: string;
  segments: JourneySegment[];
  correlation_id: string;
  ticket_fare_pence?: number | null;
  ticket_class?: string | null;
  ticket_type?: string | null;
}

// BL-181 AC-W6: SequentialLegWalk dependencies accepted by the handler.
// Two wiring options are supported:
//   a) Pass a pre-built SequentialLegWalk instance via `sequentialLegWalk`
//   b) Pass individual deps (tiplocRepository, darwinClient as DarwinClient, otpClient)
//      and the handler builds a SequentialLegWalk internally
interface JourneyConfirmedHandlerDeps {
  journeyRepository: JourneyRepository;
  delayAlertRepository: DelayAlertRepository;
  outboxRepository: OutboxRepository;
  darwinClient: DarwinIngestorClient & Partial<DarwinClient>;
  // Option a: pre-built SequentialLegWalk instance
  sequentialLegWalk?: { calculate(params: { legs: { rid: string; originCrs: string; destinationCrs: string; scheduledArrival: string; scheduledDeparture: string; connectionThresholdMinutes: null }[]; finalDestinationCrs: string; scheduledFinalArrival: string }): Promise<LegWalkResult> };
  // Option b: individual dependencies
  tiplocRepository?: TiplocRepository;
  otpClient?: OtpClient;
}

/**
 * Legacy consumer group id. Production does NOT set
 * KAFKA_JOURNEY_CONFIRMED_GROUP_ID, so it keeps exactly this group
 * (and its committed offsets). Do not change this literal.
 */
const DEFAULT_JOURNEY_CONFIRMED_GROUP_ID = 'delay-tracker-consumer-group';

/**
 * Resolve the journey.confirmed consumer group id.
 * Uses KAFKA_JOURNEY_CONFIRMED_GROUP_ID when set to a non-blank value;
 * empty/whitespace values are treated as absent, mirroring the
 * createConsumerConfig() validation pattern in src/consumers/config.ts.
 */
function resolveJourneyConfirmedGroupId(): string {
  const value = process.env.KAFKA_JOURNEY_CONFIRMED_GROUP_ID;
  if (!value || value.trim() === '') {
    return DEFAULT_JOURNEY_CONFIRMED_GROUP_ID;
  }
  return value;
}

export class JourneyConfirmedHandler {
  readonly topic = 'journey.confirmed';
  readonly groupId: string = resolveJourneyConfirmedGroupId();

  private journeyRepository: JourneyRepository;
  private delayAlertRepository: DelayAlertRepository;
  private outboxRepository: OutboxRepository;
  private darwinClient: DarwinIngestorClient & Partial<DarwinClient>;
  private sequentialLegWalk: { calculate(params: { legs: { rid: string; originCrs: string; destinationCrs: string; scheduledArrival: string; scheduledDeparture: string; connectionThresholdMinutes: null }[]; finalDestinationCrs: string; scheduledFinalArrival: string }): Promise<LegWalkResult> } | null;

  constructor(deps: JourneyConfirmedHandlerDeps) {
    this.journeyRepository = deps.journeyRepository;
    this.delayAlertRepository = deps.delayAlertRepository;
    this.outboxRepository = deps.outboxRepository;
    this.darwinClient = deps.darwinClient;

    // BL-181 AC-W6: wire SequentialLegWalk — accept pre-built instance or build from deps
    if (deps.sequentialLegWalk) {
      this.sequentialLegWalk = deps.sequentialLegWalk;
    } else if (deps.tiplocRepository && deps.otpClient) {
      // Build SequentialLegWalk from individual dependencies.
      // The darwinClient must satisfy the DarwinClient interface (getServiceWithStops).
      const darwinClientForSlw = deps.darwinClient as unknown as DarwinClient;
      this.sequentialLegWalk = new SequentialLegWalk({
        tiplocRepository: deps.tiplocRepository,
        darwinClient: darwinClientForSlw,
        otpClient: deps.otpClient,
      });
    } else {
      this.sequentialLegWalk = null;
    }
  }

  /**
   * Handle incoming journey.confirmed event
   */
  async handle(payload: JourneyConfirmedPayload): Promise<void> {
    // AC-2: Payload validation
    this.validatePayload(payload);

    // AC-10: Idempotent duplicate handling
    const existingJourney = await this.journeyRepository.findByJourneyId(payload.journey_id);
    if (existingJourney) {
      // Already processed - skip to maintain idempotency
      return;
    }

    // Determine routing based on departure time
    const departureDate = new Date(payload.departure_datetime);
    const now = new Date();
    const isHistoric = departureDate < now;

    if (isHistoric) {
      // AC-3: Historic path - immediate Darwin lookup
      await this.handleHistoricJourney(payload);
    } else {
      // AC-4: Future path - register for monitoring
      await this.handleFutureJourney(payload);
    }
  }

  /**
   * Validate incoming payload
   * AC-2: Payload validation
   */
  private validatePayload(payload: JourneyConfirmedPayload | Record<string, unknown>): void {
    // Required fields validation
    if (!payload.journey_id) {
      throw new Error('Validation error: journey_id is required');
    }
    if (!payload.user_id) {
      throw new Error('Validation error: user_id is required');
    }
    if (!payload.origin_crs) {
      throw new Error('Validation error: origin_crs is required');
    }
    if (!payload.destination_crs) {
      throw new Error('Validation error: destination_crs is required');
    }
    if (!payload.departure_datetime) {
      throw new Error('Validation error: departure_datetime is required');
    }
    if (!payload.correlation_id) {
      throw new Error('Validation error: correlation_id is required');
    }

    // Validate segments array
    if (!payload.segments || !Array.isArray(payload.segments)) {
      throw new Error('Validation error: segments array is required');
    }
    if ((payload.segments as unknown[]).length === 0) {
      throw new Error('Validation error: segments must contain at least one segment');
    }

    // Validate each segment has required fields
    for (const segment of payload.segments as Record<string, unknown>[]) {
      if (!segment.rid) {
        throw new Error('Validation error: segment rid is required');
      }
    }

    // Validate datetime format
    const departureDate = new Date(payload.departure_datetime as string);
    if (isNaN(departureDate.getTime())) {
      throw new Error('Validation error: departure_datetime has invalid datetime format');
    }
  }

  /**
   * Handle historic journey (departure < now)
   * AC-3: Historic path routing
   * AC-5: Delay calculation from Darwin
   * AC-7: darwin_unavailable status handling
   * BL-181 AC-W7: Call SequentialLegWalk.calculate() for accurate destination delay
   */
  private async handleHistoricJourney(payload: JourneyConfirmedPayload): Promise<void> {
    const firstSegment = payload.segments[0];
    const serviceDate = payload.departure_datetime.split('T')[0];

    // BL-181 AC-W7: Attempt SequentialLegWalk first when it is wired in.
    // SLW computes delay at the passenger's actual destination rather than the max-stop value.
    //
    // Darwin availability pre-check: call getServiceWithStops() before SLW.
    // This achieves two things:
    //   1. Detects Darwin unavailability early (AC-W10 regression: getServiceWithStops throws
    //      → darwin_unavailable, consistent with legacy getDelayInfo path).
    //   2. Ensures the handler can fall back to legacy getDelayInfo when SLW returns
    //      assessment_pending / needs_manual_review.
    if (this.sequentialLegWalk && this.darwinClient.getServiceWithStops) {
      // Check Darwin availability via getServiceWithStops
      try {
        await this.darwinClient.getServiceWithStops(firstSegment.rid);
      } catch (error) {
        // Darwin is unavailable — publish darwin_unavailable (AC-W10 regression guard)
        console.error('[delay-tracker] Darwin API call failed (getServiceWithStops) for historic journey', {
          journey_id: payload.journey_id,
          rid: firstSegment.rid,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.publishDelayNotDetected(payload, 'darwin_unavailable', firstSegment.rid, serviceDate);
        return;
      }

      // Darwin is reachable — invoke SequentialLegWalk with journey legs
      // Note: segment origin_crs/destination_crs may contain station NAMES (from OTP)
      // rather than CRS codes. Use payload-level CRS codes for first origin and last dest.
      const legs = payload.segments.map((seg, idx) => ({
        rid: seg.rid,
        originCrs: idx === 0 ? payload.origin_crs : seg.origin_crs,
        destinationCrs: idx === payload.segments.length - 1 ? payload.destination_crs : seg.destination_crs,
        scheduledArrival: seg.scheduled_arrival,
        scheduledDeparture: seg.scheduled_departure,
        connectionThresholdMinutes: null as null,
      }));

      let slwResult: LegWalkResult | null = null;
      try {
        slwResult = await this.sequentialLegWalk.calculate({
          legs,
          finalDestinationCrs: payload.destination_crs,
          scheduledFinalArrival: payload.arrival_datetime,
        });
      } catch (_slwError) {
        // SLW threw — treat as assessment_pending and fall through to legacy path
        slwResult = null;
      }

      // If SLW produced a definitive result (status: 'completed'), use it
      if (slwResult && slwResult.status === 'completed' && slwResult.delay_minutes !== null) {
        const delayMinutes = slwResult.delay_minutes;
        const exceedsThreshold = delayMinutes >= 15;
        if (exceedsThreshold) {
          await this.createDelayAlert(
            payload,
            { delay_minutes: delayMinutes, is_cancelled: false, delay_reasons: null },
            firstSegment.rid,
            'sequential_leg_walk'
          );
        } else {
          await this.publishDelayNotDetected(payload, 'below_threshold', firstSegment.rid, serviceDate);
        }
        return;
      }

      // SLW returned assessment_pending / needs_manual_review — fall through to legacy Darwin path
    }

    // Legacy path: use Darwin's total_delay_minutes directly
    let delayInfo;
    try {
      // AC-5: Query Darwin for delay info
      delayInfo = await this.darwinClient.getDelayInfo({
        rid: firstSegment.rid,
        service_date: serviceDate,
        origin_crs: payload.origin_crs,
        destination_crs: payload.destination_crs,
      });
    } catch (error) {
      // AC-7: Handle Darwin unavailability gracefully
      // Do NOT throw - publish delay.not-detected with darwin_unavailable reason
      console.error('[delay-tracker] Darwin API call failed for historic journey', {
        journey_id: payload.journey_id,
        rid: firstSegment.rid,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await this.publishDelayNotDetected(payload, 'darwin_unavailable', firstSegment.rid, serviceDate);
      return;
    }

    // Delay threshold: 15 minutes
    const delayMinutes = delayInfo.delay_minutes ?? 0;
    const isCancelled = delayInfo.is_cancelled;
    const exceedsThreshold = delayMinutes >= 15 || isCancelled;

    if (exceedsThreshold) {
      // Create delay alert and publish delay.detected event
      await this.createDelayAlert(payload, delayInfo, firstSegment.rid, 'total_delay_minutes');
    } else {
      // Publish delay.not-detected event (reason: below_threshold)
      await this.publishDelayNotDetected(payload, 'below_threshold', firstSegment.rid, serviceDate);
    }
  }

  /**
   * Handle future journey (departure >= now)
   * AC-4: Future path routing
   */
  private async handleFutureJourney(payload: JourneyConfirmedPayload): Promise<void> {
    const firstSegment = payload.segments[0];
    const serviceDate = payload.departure_datetime.split('T')[0];
    const scheduledDeparture = new Date(payload.departure_datetime);
    const scheduledArrival = new Date(payload.arrival_datetime);

    // Calculate next_check_at: 1 hour before departure
    const nextCheckAt = new Date(scheduledDeparture);
    nextCheckAt.setHours(nextCheckAt.getHours() - 1);

    // Create monitored_journeys record
    await this.journeyRepository.create({
      journey_id: payload.journey_id,
      user_id: payload.user_id,
      rid: firstSegment.rid,
      service_date: serviceDate,
      origin_crs: payload.origin_crs,
      destination_crs: payload.destination_crs,
      scheduled_departure: scheduledDeparture,
      scheduled_arrival: scheduledArrival,
      monitoring_status: 'active',
      next_check_at: nextCheckAt,
      toc_code: payload.toc_code ?? null, // BL-315: persist toc_code from event payload
    });

    // AC-8: Publish journey.monitoring-registered event
    await this.outboxRepository.create({
      event_type: 'journey.monitoring-registered',
      aggregate_type: 'journey',
      aggregate_id: payload.journey_id,
      payload: {
        journey_id: payload.journey_id,
        user_id: payload.user_id,
        monitoring_status: 'active',
        next_check_at: nextCheckAt.toISOString(),
      },
      correlation_id: payload.correlation_id,
    });
  }

  /**
   * Create delay alert and publish delay.detected event
   * AC-6: delay_alerts row creation
   * AC-8: Outbox event publishing
   * BL-181 AC-W8: resolution_method field added to delay.detected payload
   */
  private async createDelayAlert(
    payload: JourneyConfirmedPayload,
    delayInfo: { delay_minutes: number | null; is_cancelled: boolean; delay_reasons?: Record<string, unknown> | null },
    rid: string | undefined,
    resolutionMethod: 'sequential_leg_walk' | 'total_delay_minutes' | 'darwin_unavailable' = 'total_delay_minutes'
  ): Promise<void> {
    const serviceDate = payload.departure_datetime.split('T')[0];
    const scheduledDeparture = new Date(payload.departure_datetime);
    const scheduledArrival = new Date(payload.arrival_datetime);

    // Create monitored_journeys row with monitoring_status='completed'
    // This is required for the FK constraint on delay_alerts.monitored_journey_id
    const monitoredJourney = await this.journeyRepository.create({
      journey_id: payload.journey_id,
      user_id: payload.user_id,
      rid: rid || 'UNKNOWN',
      service_date: serviceDate,
      origin_crs: payload.origin_crs,
      destination_crs: payload.destination_crs,
      scheduled_departure: scheduledDeparture,
      scheduled_arrival: scheduledArrival,
      monitoring_status: 'completed',
      last_checked_at: null,
      next_check_at: null,
      toc_code: payload.toc_code ?? null, // BL-315: persist toc_code from event payload
    });

    // Create delay alert with real monitored_journey_id
    if (!monitoredJourney.id) {
      throw new Error('Failed to create monitored_journey: no ID returned');
    }

    await this.delayAlertRepository.create({
      monitored_journey_id: monitoredJourney.id,
      delay_minutes: delayInfo.delay_minutes ?? 0,
      delay_reasons: delayInfo.delay_reasons || null,
      is_cancellation: delayInfo.is_cancelled,
      threshold_exceeded: true,
      claim_triggered: false,
      notification_sent: false,
    });

    // AC-8 / BL-181 AC-W8: Publish delay.detected event with resolution_method
    await this.outboxRepository.create({
      event_type: 'delay.detected',
      aggregate_type: 'journey',
      aggregate_id: payload.journey_id,
      payload: {
        journey_id: payload.journey_id,
        user_id: payload.user_id,
        delay_minutes: delayInfo.delay_minutes,
        is_cancellation: delayInfo.is_cancelled,
        toc_code: payload.toc_code, // AC-10: Add toc_code to delay.detected payload
        ticket_fare_pence: payload.ticket_fare_pence !== undefined ? payload.ticket_fare_pence : null,
        ticket_class: payload.ticket_class ?? null,
        ticket_type: payload.ticket_type ?? null,
        resolution_method: resolutionMethod, // BL-181 AC-W8
      },
      correlation_id: payload.correlation_id,
    });
  }

  /**
   * Publish delay.not-detected event
   * AC-8: Outbox event publishing
   * BL-315: Also creates a monitored_journeys row with monitoring_status='completed'
   *   so that GET /delays/:journeyId returns status:'on_time' (not 404) after this path.
   *   Mirrors the createDelayAlert() path (~lines 354-367) which always creates a row.
   *   No delay_alert is created here — the no-delay-alert invariant is preserved.
   */
  private async publishDelayNotDetected(
    payload: JourneyConfirmedPayload,
    reason: 'below_threshold' | 'darwin_unavailable',
    rid: string,
    serviceDate: string
  ): Promise<void> {
    // BL-315: Create monitored_journeys row with monitoring_status='completed' so the
    // query endpoint can return on_time instead of 404-ing on every poll.
    await this.journeyRepository.create({
      journey_id: payload.journey_id,
      user_id: payload.user_id,
      rid,
      service_date: serviceDate,
      origin_crs: payload.origin_crs,
      destination_crs: payload.destination_crs,
      scheduled_departure: new Date(payload.departure_datetime),
      scheduled_arrival: new Date(payload.arrival_datetime),
      monitoring_status: 'completed',
      last_checked_at: null,
      next_check_at: null,
      toc_code: payload.toc_code ?? null,
    });

    await this.outboxRepository.create({
      event_type: 'delay.not-detected',
      aggregate_type: 'journey',
      aggregate_id: payload.journey_id,
      payload: {
        journey_id: payload.journey_id,
        user_id: payload.user_id,
        reason,
      },
      correlation_id: payload.correlation_id,
    });
  }
}
