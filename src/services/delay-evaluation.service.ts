/**
 * DelayEvaluationService — ADR-031 shared evaluation logic
 *
 * Extracts the historic-journey evaluation steps from JourneyConfirmedHandler
 * so that BOTH the Kafka consumer path and the new POST /delays/ensure HTTP path
 * call a single implementation.
 *
 * AC-3 of ADR-031-ensure-endpoint.test.ts: The ensure endpoint MUST delegate to
 * DelayEvaluationService.evaluate() which encapsulates:
 *   1. Darwin availability pre-check (getServiceWithStops on segments[0].rid)
 *   2. SequentialLegWalk.calculate() across ALL legs (BL-337 / ADR-021)
 *   3. Persist delay_alerts row OR record not-detected (monitored_journeys row)
 *
 * Returns a terminal EvaluationOutcome — one of:
 *   { outcome: 'delayed', delay_minutes, cancelled, toc_code, last_observed_at }
 *   { outcome: 'on_time',  delay_minutes, cancelled, toc_code, last_observed_at }
 *   { outcome: 'no_data' }
 *
 * BL   : BL-315, BL-337
 * ADR  : ADR-031 — Option (f) synchronous ensure-on-404
 * ADR  : ADR-021 — Fundamental Delay Equation (final-destination delay via SLW)
 */

import { JourneyRepository } from '../repositories/journey-repository.js';
import { DelayAlertRepository } from '../repositories/delay-alert-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { DarwinIngestorClient } from '../clients/darwin-ingestor.js';
import type { SequentialLegWalk, LegWalkResult } from './sequential-leg-walk.js';

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
  delayAlertRepository: DelayAlertRepository | { findLatestByMonitoredJourneyId?: (id: string) => Promise<unknown>; create: (data: unknown) => Promise<unknown>; update?: (id: string, data: unknown) => Promise<unknown> };
  outboxRepository: OutboxRepository | { create: (data: unknown) => Promise<unknown> };
  darwinClient: DarwinIngestorClient | { getDelayInfo: (params: unknown) => Promise<{ delay_minutes: number | null; is_cancelled: boolean; delay_reasons?: Record<string, unknown> | null }>; getServiceWithStops?: (rid: string) => Promise<unknown> };
  /**
   * BL-337 / ADR-021: SequentialLegWalk instance for multi-leg final-destination delay.
   * When provided, evaluate() uses SLW.calculate() instead of the legacy getDelayInfo path.
   * The stub OtpClient (returns null) is wired in index.ts; OTP replacement routing is deferred.
   */
  sequentialLegWalk?: SequentialLegWalk | { calculate: (params: unknown) => Promise<LegWalkResult> };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class DelayEvaluationService {
  private journeyRepository: DelayEvaluationServiceDeps['journeyRepository'];
  private delayAlertRepository: DelayEvaluationServiceDeps['delayAlertRepository'];
  private outboxRepository: DelayEvaluationServiceDeps['outboxRepository'];
  private darwinClient: DelayEvaluationServiceDeps['darwinClient'];
  private sequentialLegWalk: DelayEvaluationServiceDeps['sequentialLegWalk'];

  constructor(deps: DelayEvaluationServiceDeps) {
    this.journeyRepository = deps.journeyRepository;
    this.delayAlertRepository = deps.delayAlertRepository;
    this.outboxRepository = deps.outboxRepository;
    this.darwinClient = deps.darwinClient;
    this.sequentialLegWalk = deps.sequentialLegWalk;
  }

  /**
   * Evaluate delay for a historic journey.
   *
   * BL-337 / ADR-021: Uses SequentialLegWalk to compute final-destination delay
   * across ALL journey legs (not just leg-1 as the legacy path did).
   *
   * Performs:
   *   1. Darwin availability pre-check (getServiceWithStops on segments[0].rid — PRESERVED)
   *   2. Build JourneyLeg[] from input.segments and call sequentialLegWalk.calculate()
   *   3. Map LegWalkResult → terminal outcome:
   *        completed + delay_minutes >= 15 → delayed
   *        completed + delay_minutes < 15  → on_time
   *        assessment_pending | needs_manual_review | delay_minutes === null → no_data
   *   4. Persist delay_alerts row (delayed) OR monitored_journeys completed row (on_time / no_data)
   *
   * Returns a TERMINAL EvaluationOutcome — never 'pending'.
   */
  async evaluate(input: EvaluationInput): Promise<EvaluationOutcome> {
    const firstSegment = input.segments[0];
    const serviceDate = input.departure_datetime.split('T')[0];
    const now = new Date().toISOString();

    // ── Darwin availability pre-check (segments[0].rid — PRESERVED per test AC-2/AC-4) ──
    if (this.darwinClient.getServiceWithStops) {
      try {
        await this.darwinClient.getServiceWithStops(firstSegment.rid);
      } catch {
        // Darwin unavailable — persist completed row (so GET returns on_time not 404)
        await this.persistCompletedRow(input, firstSegment.rid, serviceDate);
        return { outcome: 'no_data' };
      }
    }

    // ── BL-337: SequentialLegWalk path (ADR-021 fundamental delay equation) ──
    if (this.sequentialLegWalk) {
      // Map EvaluationSegment[] → JourneyLeg[] for SLW
      const legs = input.segments.map((seg) => ({
        rid: seg.rid,
        originCrs: seg.origin_crs,
        destinationCrs: seg.destination_crs,
        scheduledArrival: seg.scheduled_arrival,
        scheduledDeparture: seg.scheduled_departure,
        connectionThresholdMinutes: null as null,
      }));

      const slwResult = await this.sequentialLegWalk.calculate({
        legs,
        finalDestinationCrs: input.destination_crs,
        scheduledFinalArrival: input.arrival_datetime,
      });

      return this.terminalFromSlwResult(slwResult, input, firstSegment.rid, serviceDate, now);
    }

    // ── Legacy getDelayInfo fallback (no SLW wired — preserved for backward compat) ──
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

      return {
        outcome: 'delayed',
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
   * BL-337: Map a LegWalkResult from SequentialLegWalk to a terminal EvaluationOutcome.
   *
   * Mapping table (per Jessie's test spec):
   *   completed + delay_minutes >= 15  → delayed  (persist alert + outbox)
   *   completed + delay_minutes < 15   → on_time  (persist completed row + outbox)
   *   assessment_pending               → no_data  (Darwin had no stop data)
   *   needs_manual_review              → no_data  (OTP stub returned null — deferred)
   *   delay_minutes === null           → no_data  (AC-4 anti-fraud guard: never coerce null→0)
   */
  private async terminalFromSlwResult(
    slwResult: LegWalkResult,
    input: EvaluationInput,
    rid: string,
    serviceDate: string,
    now: string,
  ): Promise<EvaluationOutcome> {
    const { status, delay_minutes } = slwResult;

    // AC-4: null delay_minutes → no_data (never coerce to 0 — anti-fraud guard)
    if (delay_minutes === null || status === 'assessment_pending' || status === 'needs_manual_review') {
      await this.persistCompletedRow(input, rid, serviceDate);
      return { outcome: 'no_data' };
    }

    // status === 'completed' from here
    const exceedsThreshold = delay_minutes >= 15;

    if (exceedsThreshold) {
      // ── delayed terminal ────────────────────────────────────────────────
      const monitoredJourney = await this.persistCompletedRow(input, rid, serviceDate);

      if (monitoredJourney?.id) {
        // BL-359 AC-1: upsert — check for existing alert before creating a duplicate.
        // If a stale alert row already exists for this monitored_journey, UPDATE it
        // (so there is always exactly ONE canonical alert per monitored_journey).
        const existingAlert = this.delayAlertRepository.findLatestByMonitoredJourneyId
          ? await this.delayAlertRepository.findLatestByMonitoredJourneyId(monitoredJourney.id as string)
          : null;

        if (existingAlert && (existingAlert as { id?: unknown }).id && this.delayAlertRepository.update) {
          await this.delayAlertRepository.update(
            (existingAlert as { id: string }).id,
            {
              delay_minutes,
              threshold_exceeded: true,
            },
          );
        } else {
          await this.delayAlertRepository.create({
            monitored_journey_id: monitoredJourney.id,
            delay_minutes,
            delay_reasons: null,
            is_cancellation: false,
            threshold_exceeded: true,
            claim_triggered: false,
            notification_sent: false,
          });
        }
      }

      try {
        await this.outboxRepository.create({
          event_type: 'delay.detected',
          aggregate_type: 'journey',
          aggregate_id: input.journey_id,
          payload: {
            journey_id: input.journey_id,
            user_id: input.user_id,
            delay_minutes,
            is_cancellation: false,
            toc_code: input.toc_code ?? null,
            ticket_fare_pence: input.ticket_fare_pence ?? null,
            ticket_class: input.ticket_class ?? null,
            ticket_type: input.ticket_type ?? null,
            resolution_method: 'total_delay_minutes',
          },
          correlation_id: input.correlation_id,
        });
      } catch {
        // Non-fatal
      }

      return {
        outcome: 'delayed',
        delay_minutes,
        cancelled: false,
        toc_code: input.toc_code ?? null,
        last_observed_at: now,
      };
    } else {
      // ── on_time terminal (delay_minutes < 15, including 0) ─────────────
      await this.persistCompletedRow(input, rid, serviceDate);

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
        delay_minutes,
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
