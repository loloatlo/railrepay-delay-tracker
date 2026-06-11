/**
 * DelayEvaluationService — ADR-031 shared evaluation logic
 *
 * Extracts the historic-journey evaluation steps from JourneyConfirmedHandler
 * so that BOTH the Kafka consumer path and the new POST /delays/ensure HTTP path
 * call a single implementation.
 *
 * AC-3 of ADR-031-ensure-endpoint.test.ts: The ensure endpoint MUST delegate to
 * DelayEvaluationService.evaluate() which encapsulates:
 *   1. Darwin availability pre-check (getServiceWithStops if SLW is wired)
 *   2. SequentialLegWalk / legacy getDelayInfo Darwin lookup
 *   3. Persist delay_alerts row OR record not-detected (monitored_journeys row)
 *
 * Returns a terminal EvaluationOutcome — one of:
 *   { outcome: 'delayed', delay_minutes, cancelled, toc_code, last_observed_at }
 *   { outcome: 'on_time',  delay_minutes, cancelled, toc_code, last_observed_at }
 *   { outcome: 'no_data' }
 *
 * BL   : BL-315
 * ADR  : ADR-031 — Option (f) synchronous ensure-on-404
 */

import { JourneyRepository } from '../repositories/journey-repository.js';
import { DelayAlertRepository } from '../repositories/delay-alert-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { DarwinIngestorClient } from '../clients/darwin-ingestor.js';

// ─── Public types ──────────────────────────────────────────────────────────────

export interface EvaluationSegment {
  segment_order: number;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  rid: string;
  toc_code: string;
}

export interface EvaluationInput {
  journey_id: string;
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  departure_datetime: string;
  arrival_datetime: string;
  toc_code?: string | null;
  segments: EvaluationSegment[];
  correlation_id?: string;
  ticket_fare_pence?: number | null;
  ticket_class?: string | null;
  ticket_type?: string | null;
}

export type EvaluationOutcome =
  | { outcome: 'delayed'; delay_minutes: number; cancelled: boolean; toc_code: string | null; last_observed_at: string }
  | { outcome: 'on_time';  delay_minutes: number; cancelled: boolean; toc_code: string | null; last_observed_at: string }
  | { outcome: 'no_data' };

// ─── Deps interface ───────────────────────────────────────────────────────────

export interface DelayEvaluationServiceDeps {
  // `create` is typed as `Promise<unknown>` to remain structurally compatible with the real
  // JourneyRepository.create() → Promise<MonitoredJourney>, which lacks an index signature
  // and cannot be directly assigned to `Promise<{ id?: string; [k: string]: unknown }>`.
  journeyRepository: JourneyRepository | { findByJourneyId: (id: string) => Promise<unknown>; create: (data: unknown) => Promise<unknown> };
  delayAlertRepository: DelayAlertRepository | { findLatestByMonitoredJourneyId?: (id: string) => Promise<unknown>; create: (data: unknown) => Promise<unknown> };
  outboxRepository: OutboxRepository | { create: (data: unknown) => Promise<unknown> };
  darwinClient: DarwinIngestorClient | { getDelayInfo: (params: unknown) => Promise<{ delay_minutes: number | null; is_cancelled: boolean; delay_reasons?: Record<string, unknown> | null }>; getServiceWithStops?: (rid: string) => Promise<unknown> };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class DelayEvaluationService {
  private journeyRepository: DelayEvaluationServiceDeps['journeyRepository'];
  private delayAlertRepository: DelayEvaluationServiceDeps['delayAlertRepository'];
  private outboxRepository: DelayEvaluationServiceDeps['outboxRepository'];
  private darwinClient: DelayEvaluationServiceDeps['darwinClient'];

  constructor(deps: DelayEvaluationServiceDeps) {
    this.journeyRepository = deps.journeyRepository;
    this.delayAlertRepository = deps.delayAlertRepository;
    this.outboxRepository = deps.outboxRepository;
    this.darwinClient = deps.darwinClient;
  }

  /**
   * Evaluate delay for a historic journey.
   *
   * Performs:
   *   1. Darwin availability pre-check (getServiceWithStops when available)
   *   2. Legacy getDelayInfo Darwin lookup
   *   3. Persist delay_alerts row (delayed) OR monitored_journeys completed row (on_time / darwin_unavailable)
   *
   * Returns a TERMINAL EvaluationOutcome — never 'pending'.
   */
  async evaluate(input: EvaluationInput): Promise<EvaluationOutcome> {
    const firstSegment = input.segments[0];
    const serviceDate = input.departure_datetime.split('T')[0];
    const now = new Date().toISOString();

    // ── Darwin availability check (getServiceWithStops if available) ──────────
    if (this.darwinClient.getServiceWithStops) {
      try {
        await this.darwinClient.getServiceWithStops(firstSegment.rid);
      } catch {
        // Darwin unavailable — persist completed row (so GET returns on_time not 404)
        await this.persistCompletedRow(input, firstSegment.rid, serviceDate);
        return { outcome: 'no_data' };
      }
    }

    // ── Legacy getDelayInfo path ───────────────────────────────────────────────
    let delayInfo: { delay_minutes: number | null; is_cancelled: boolean; delay_reasons?: Record<string, unknown> | null };
    try {
      delayInfo = await this.darwinClient.getDelayInfo({
        rid: firstSegment.rid,
        service_date: serviceDate,
        origin_crs: input.origin_crs,
        destination_crs: input.destination_crs,
      });
    } catch {
      // Darwin unavailable — persist completed row
      await this.persistCompletedRow(input, firstSegment.rid, serviceDate);
      return { outcome: 'no_data' };
    }

    const delayMinutes = delayInfo.delay_minutes ?? 0;
    const isCancelled = delayInfo.is_cancelled;
    const exceedsThreshold = delayMinutes >= 15 || isCancelled;

    if (exceedsThreshold) {
      // ── Persist delay alert ────────────────────────────────────────────────
      const monitoredJourney = await this.persistCompletedRow(input, firstSegment.rid, serviceDate);

      if (monitoredJourney?.id) {
        await this.delayAlertRepository.create({
          monitored_journey_id: monitoredJourney.id,
          delay_minutes: delayMinutes,
          delay_reasons: delayInfo.delay_reasons ?? null,
          is_cancellation: isCancelled,
          threshold_exceeded: true,
          claim_triggered: false,
          notification_sent: false,
        });
      }

      // Publish outbox event (non-fatal if fails)
      try {
        await this.outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'journey',
          aggregate_id: input.journey_id,
          payload: {
            journey_id: input.journey_id,
            user_id: input.user_id,
            delay_minutes: delayMinutes,
            is_cancellation: isCancelled,
            toc_code: input.toc_code ?? null,
            ticket_fare_pence: input.ticket_fare_pence ?? null,
            ticket_class: input.ticket_class ?? null,
            ticket_type: input.ticket_type ?? null,
            resolution_method: 'total_delay_minutes',
          },
          correlation_id: input.correlation_id,
        });
      } catch {
        // Non-fatal — ensure returns terminal outcome regardless
      }

      const outcome = isCancelled ? 'delayed' as const : 'delayed' as const;
      return {
        outcome,
        delay_minutes: delayMinutes,
        cancelled: isCancelled,
        toc_code: input.toc_code ?? null,
        last_observed_at: now,
      };
    } else {
      // ── Not detected — persist completed row + outbox event ───────────────
      await this.persistCompletedRow(input, firstSegment.rid, serviceDate);

      try {
        await this.outboxRepository.create({
          event_type: 'delay.not-detected',
          aggregate_type: 'journey',
          aggregate_id: input.journey_id,
          payload: {
            journey_id: input.journey_id,
            user_id: input.user_id,
            reason: 'below_threshold',
          },
          correlation_id: input.correlation_id,
        });
      } catch {
        // Non-fatal
      }

      return {
        outcome: 'on_time',
        delay_minutes: delayMinutes,
        cancelled: false,
        toc_code: input.toc_code ?? null,
        last_observed_at: now,
      };
    }
  }

  /**
   * Persist a completed monitored_journeys row idempotently.
   * Uses ON CONFLICT DO NOTHING semantics via findByJourneyId guard.
   */
  private async persistCompletedRow(
    input: EvaluationInput,
    rid: string,
    serviceDate: string
  ): Promise<{ id?: string; [k: string]: unknown } | null> {
    // Idempotency: check if row already exists
    const existing = await this.journeyRepository.findByJourneyId(input.journey_id);
    if (existing) {
      return existing as { id?: string; [k: string]: unknown };
    }

    const created = await this.journeyRepository.create({
      journey_id: input.journey_id,
      user_id: input.user_id,
      rid,
      service_date: serviceDate,
      origin_crs: input.origin_crs,
      destination_crs: input.destination_crs,
      scheduled_departure: new Date(input.departure_datetime),
      scheduled_arrival: new Date(input.arrival_datetime),
      monitoring_status: 'completed',
      last_checked_at: null,
      next_check_at: null,
      toc_code: input.toc_code ?? null,
    });
    return created as { id?: string; [k: string]: unknown } | null;
  }
}
