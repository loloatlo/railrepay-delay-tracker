/**
 * Delay Query Handler — GET /delays/:journeyId
 *
 * DT-001: Synchronous delay-query endpoint.
 *
 * Per human-locked decisions (Quinn spec):
 *   - Validates journeyId and user_id as UUID v4 BEFORE any DB call
 *   - Two-step join: journeyId (external) → monitored_journeys.id → delay_alerts
 *   - Status mapping: cancelled > delayed > on_time > pending
 *   - 403 body: ONLY { error: 'forbidden' } — no journey_id echoed (AC-7)
 *   - Logging: console.log with structured second arg (AC-13, existing pattern)
 *   - Metrics: MetricsState.record(outcome, durationMs) (AC-14)
 *
 * Per AC-13: uses console.log (existing delay-tracker pattern).
 * TD-DELAY-TRACKER-006 tracks future migration to @railrepay/winston-logger.
 */

import { type Express, type Request, type Response } from 'express';
import { validate as uuidValidate, v4 as uuidv4 } from 'uuid';
import { OutcomeKind, GetDelayHitResponse, GetDelayPendingResponse } from '../types.js';
import { MetricsState } from '../metrics/sync-query-metrics.js';

// Minimal interface so tests can pass partial mock objects
interface IJourneyRepository {
  findByJourneyId(journeyId: string): Promise<{
    id?: string;
    user_id: string;
    journey_id: string;
    monitoring_status: string;
    last_checked_at?: Date | null;
    scheduled_arrival?: string | Date;
  } | null>;
}

interface IDelayAlertRepository {
  findLatestByMonitoredJourneyId(monitoredJourneyId: string): Promise<{
    monitored_journey_id: string;
    delay_minutes: number;
    is_cancellation?: boolean;
    delay_detected_at?: Date;
  } | null>;
}

interface DelayQueryHandlerConfig {
  journeyRepository: IJourneyRepository | Partial<IJourneyRepository>;
  delayAlertRepository: IDelayAlertRepository | Partial<IDelayAlertRepository>;
  metricsState?: MetricsState;
}

export class DelayQueryHandler {
  private journeyRepo: IJourneyRepository;
  private alertRepo: IDelayAlertRepository;
  private metricsState: MetricsState | null;

  constructor(config: DelayQueryHandlerConfig) {
    this.journeyRepo = config.journeyRepository as IJourneyRepository;
    this.alertRepo = config.delayAlertRepository as IDelayAlertRepository;
    this.metricsState = config.metricsState ?? null;
  }

  /**
   * Register GET /delays/:journeyId on the provided Express app.
   */
  register(app: Express): void {
    app.get('/delays/:journeyId', (req: Request, res: Response) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[delay-tracker] Unhandled error in delay-query handler', { error: errMsg });
        res.status(500).json({ error: 'internal_error' });
      });
    });
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    const startMs = Date.now();

    // Correlation ID — read from header or generate
    const correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? uuidv4();

    const { journeyId } = req.params;
    const userId = req.query['user_id'] as string | undefined;

    // -------------------------------------------------------------------
    // AC-8: Validate journeyId is UUID v4 BEFORE any DB call
    // -------------------------------------------------------------------
    if (!journeyId || !uuidValidate(journeyId)) {
      const durationMs = Date.now() - startMs;
      this.emitLog('GET /delays/:journeyId validation failed: bad journeyId', {
        correlation_id: correlationId,
        journey_id: journeyId ?? null,
        user_id: userId ?? null,
        outcome: 'bad_request' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
      });
      this.recordMetrics('bad_request', durationMs);
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    // -------------------------------------------------------------------
    // AC-9: Validate user_id query param is UUID v4 BEFORE any DB call
    // -------------------------------------------------------------------
    if (!userId || !uuidValidate(userId)) {
      const durationMs = Date.now() - startMs;
      this.emitLog('GET /delays/:journeyId validation failed: bad user_id', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId ?? null,
        outcome: 'bad_request' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
      });
      this.recordMetrics('bad_request', durationMs);
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    // -------------------------------------------------------------------
    // Step 1: Look up monitored_journeys by external journey_id
    // -------------------------------------------------------------------
    let monitoredJourney: Awaited<ReturnType<IJourneyRepository['findByJourneyId']>>;
    try {
      monitoredJourney = await this.journeyRepo.findByJourneyId(journeyId);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emitLog('GET /delays/:journeyId DB error (findByJourneyId)', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId,
        outcome: 'error' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
        error: errMsg,
      });
      this.recordMetrics('error', durationMs);
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    // -------------------------------------------------------------------
    // AC-6: Journey not found → 404
    // -------------------------------------------------------------------
    if (!monitoredJourney) {
      const durationMs = Date.now() - startMs;
      this.emitLog('GET /delays/:journeyId journey not found', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId,
        outcome: 'unknown' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
      });
      this.recordMetrics('unknown', durationMs);
      res.status(404).json({ error: 'unknown_journey' });
      return;
    }

    // -------------------------------------------------------------------
    // AC-7: User ownership check → 403 (body MUST NOT echo journey_id)
    // -------------------------------------------------------------------
    if (monitoredJourney.user_id !== userId) {
      const durationMs = Date.now() - startMs;
      this.emitLog('GET /delays/:journeyId forbidden', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId,
        outcome: 'forbidden' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
      });
      this.recordMetrics('forbidden', durationMs);
      // AC-7 CRITICAL: ONLY the error key — no journey_id
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // -------------------------------------------------------------------
    // Step 2: Look up latest delay alert by monitored_journey PK (not journey_id)
    // -------------------------------------------------------------------
    const monitoredId = monitoredJourney.id as string;
    let latestAlert: Awaited<ReturnType<IDelayAlertRepository['findLatestByMonitoredJourneyId']>>;
    try {
      latestAlert = await this.alertRepo.findLatestByMonitoredJourneyId(monitoredId);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emitLog('GET /delays/:journeyId DB error (findLatestByMonitoredJourneyId)', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId,
        outcome: 'error' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
        error: errMsg,
      });
      this.recordMetrics('error', durationMs);
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    const durationMs = Date.now() - startMs;

    // -------------------------------------------------------------------
    // Status mapping
    // -------------------------------------------------------------------
    if (latestAlert) {
      // AC-2: cancellation check first
      const cancelled = latestAlert.is_cancellation === true;
      const status: 'cancelled' | 'delayed' = cancelled ? 'cancelled' : 'delayed';
      const outcome: OutcomeKind = 'hit';

      const body: GetDelayHitResponse = {
        journey_id: journeyId,
        delay_minutes: latestAlert.delay_minutes,
        cancelled,
        last_observed_at: (latestAlert.delay_detected_at ?? new Date()).toISOString(),
        status,
      };

      this.emitLog('GET /delays/:journeyId hit', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId,
        outcome,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
      });
      this.recordMetrics(outcome, durationMs);
      res.status(200).json(body);
      return;
    }

    // No alert row — determine on_time vs pending from monitoring_status
    const monitoringStatus = monitoredJourney.monitoring_status;

    if (monitoringStatus === 'completed') {
      // AC-3: on_time — last_observed_at = last_checked_at ?? scheduled_arrival
      const lastCheckedAt = monitoredJourney.last_checked_at;
      const scheduledArrival = monitoredJourney.scheduled_arrival;

      let lastObservedAt: string;
      if (lastCheckedAt) {
        lastObservedAt = lastCheckedAt.toISOString();
      } else {
        // Fall back to scheduled_arrival (may be Date or string from DB)
        const arrival = scheduledArrival ?? new Date();
        lastObservedAt = arrival instanceof Date
          ? arrival.toISOString()
          : new Date(arrival).toISOString();
      }

      const body: GetDelayHitResponse = {
        journey_id: journeyId,
        delay_minutes: 0,
        cancelled: false,
        last_observed_at: lastObservedAt,
        status: 'on_time',
      };

      this.emitLog('GET /delays/:journeyId on_time', {
        correlation_id: correlationId,
        journey_id: journeyId,
        user_id: userId,
        outcome: 'on_time' as OutcomeKind,
        duration_ms: durationMs,
        component: 'delay-tracker',
        route: '/delays/:journeyId',
      });
      this.recordMetrics('on_time', durationMs);
      res.status(200).json(body);
      return;
    }

    // AC-4: pending — monitoring_status in (pending_rid, active, darwin_unavailable)
    const body: GetDelayPendingResponse = {
      journey_id: journeyId,
      status: 'pending',
      message: 'no delay data yet',
    };

    this.emitLog('GET /delays/:journeyId pending', {
      correlation_id: correlationId,
      journey_id: journeyId,
      user_id: userId,
      outcome: 'pending' as OutcomeKind,
      duration_ms: durationMs,
      component: 'delay-tracker',
      route: '/delays/:journeyId',
    });
    this.recordMetrics('pending', durationMs);
    res.status(200).json(body);
  }

  /**
   * Structured log per request — matches existing delay-tracker console.log pattern.
   * First arg: human-readable message. Second arg: JSON-serialisable metadata.
   */
  private emitLog(message: string, meta: Record<string, unknown>): void {
    console.log(message, meta);
  }

  /**
   * Record metrics if metricsState is configured.
   * Extracted to avoid repeated optional chaining branches.
   */
  private recordMetrics(outcome: OutcomeKind, durationMs: number): void {
    if (this.metricsState) {
      this.metricsState.record(outcome, durationMs);
    }
  }
}
