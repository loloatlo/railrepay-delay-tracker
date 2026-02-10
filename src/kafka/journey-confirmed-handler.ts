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
}

interface JourneyConfirmedHandlerDeps {
  journeyRepository: JourneyRepository;
  delayAlertRepository: DelayAlertRepository;
  outboxRepository: OutboxRepository;
  darwinClient: DarwinIngestorClient;
}

export class JourneyConfirmedHandler {
  readonly topic = 'journey.confirmed';
  readonly groupId = 'delay-tracker-consumer-group';

  private journeyRepository: JourneyRepository;
  private delayAlertRepository: DelayAlertRepository;
  private outboxRepository: OutboxRepository;
  private darwinClient: DarwinIngestorClient;

  constructor(deps: JourneyConfirmedHandlerDeps) {
    this.journeyRepository = deps.journeyRepository;
    this.delayAlertRepository = deps.delayAlertRepository;
    this.outboxRepository = deps.outboxRepository;
    this.darwinClient = deps.darwinClient;
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
   */
  private async handleHistoricJourney(payload: JourneyConfirmedPayload): Promise<void> {
    const firstSegment = payload.segments[0];
    const serviceDate = payload.departure_datetime.split('T')[0];

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
      await this.publishDelayNotDetected(payload, 'darwin_unavailable');
      return;
    }

    // Delay threshold: 15 minutes
    const delayMinutes = delayInfo.delay_minutes;
    const isCancelled = delayInfo.is_cancelled;
    const exceedsThreshold = delayMinutes >= 15 || isCancelled;

    if (exceedsThreshold) {
      // Create delay alert and publish delay.detected event
      await this.createDelayAlert(payload, delayInfo, firstSegment.rid);
    } else {
      // Publish delay.not-detected event (reason: below_threshold)
      await this.publishDelayNotDetected(payload, 'below_threshold');
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
   */
  private async createDelayAlert(
    payload: JourneyConfirmedPayload,
    delayInfo: { delay_minutes: number; is_cancelled: boolean; delay_reasons?: Record<string, unknown> | null },
    rid: string | undefined
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
    });

    // Create delay alert with real monitored_journey_id
    if (!monitoredJourney.id) {
      throw new Error('Failed to create monitored_journey: no ID returned');
    }

    await this.delayAlertRepository.create({
      monitored_journey_id: monitoredJourney.id,
      delay_minutes: delayInfo.delay_minutes,
      delay_reasons: delayInfo.delay_reasons || null,
      is_cancellation: delayInfo.is_cancelled,
      threshold_exceeded: true,
      claim_triggered: false,
      notification_sent: false,
    });

    // AC-8: Publish delay.detected event
    await this.outboxRepository.create({
      event_type: 'delay.detected',
      aggregate_type: 'journey',
      aggregate_id: payload.journey_id,
      payload: {
        journey_id: payload.journey_id,
        user_id: payload.user_id,
        delay_minutes: delayInfo.delay_minutes,
        is_cancellation: delayInfo.is_cancelled,
      },
      correlation_id: payload.correlation_id,
    });
  }

  /**
   * Publish delay.not-detected event
   * AC-8: Outbox event publishing
   */
  private async publishDelayNotDetected(
    payload: JourneyConfirmedPayload,
    reason: 'below_threshold' | 'darwin_unavailable'
  ): Promise<void> {
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
