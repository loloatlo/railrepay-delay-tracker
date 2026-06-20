/**
 * DelayEnsureHandler — POST /delays/ensure
 *
 * ADR-031: Synchronous ensure-on-404.
 *
 * Accepts a journey context body, idempotently creates the monitored_journeys row
 * if absent, runs DelayEvaluationService.evaluate(), and returns a TERMINAL response
 * — never 'pending'.
 *
 * Terminal outcomes: delayed | on_time | no_data
 *
 * AC-1 : POST /delays/ensure exists and accepts body with journey_id + context
 * AC-2 : Idempotent — 2nd call with same journey_id does not duplicate or error
 * AC-3 : Delegates to DelayEvaluationService.evaluate() (shared evaluation path)
 * AC-4 : Returns TERMINAL response (never pending)
 *
 * BL   : BL-315
 * ADR  : ADR-031 — Option (f) synchronous ensure-on-404
 */

import { type Express, type Request, type Response } from 'express';
import {
  DelayEvaluationService,
  type EvaluationInput,
  type EvaluationSegment,
} from '../services/delay-evaluation.service.js';

// ─── Deps interface ───────────────────────────────────────────────────────────

interface IJourneyRepository {
  findByJourneyId(journeyId: string): Promise<unknown>;
  // Return type is deliberately `unknown` — DelayEnsureHandler never uses the returned value
  // directly; it delegates all persistence to DelayEvaluationService. Using `unknown` avoids
  // a structural incompatibility with JourneyRepository.create() → Promise<MonitoredJourney>
  // (which lacks an index signature).
  create(data: unknown): Promise<unknown>;
  // BL-315: load segments from journey_matcher when body has none (ADR-031 BFF contract)
  findSegmentsByJourneyId(journeyId: string): Promise<EvaluationSegment[]>;
}

interface DelayEnsureHandlerConfig {
  journeyRepository: IJourneyRepository;
  delayEvaluationService: DelayEvaluationService;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export class DelayEnsureHandler {
  private journeyRepository: IJourneyRepository;
  private delayEvaluationService: DelayEvaluationService;

  constructor(config: DelayEnsureHandlerConfig) {
    this.journeyRepository = config.journeyRepository;
    this.delayEvaluationService = config.delayEvaluationService;
  }

  /**
   * Register POST /delays/ensure on the provided Express app.
   */
  register(app: Express): void {
    app.post('/delays/ensure', (req: Request, res: Response) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[delay-tracker] Unhandled error in delay-ensure handler', { error: errMsg });
        res.status(500).json({ error: 'internal_error' });
      });
    });
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    const body = req.body as Record<string, unknown>;

    // ── AC-1: Body validation ─────────────────────────────────────────────────
    if (!body.journey_id || typeof body.journey_id !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'journey_id is required' });
      return;
    }
    if (!body.user_id || typeof body.user_id !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'user_id is required' });
      return;
    }

    // ── AC-2: Idempotency guard — check if row already exists ─────────────────
    // If the row already exists AND we have the journey context, we still run
    // DelayEvaluationService.evaluate() to return a terminal result.
    // The service itself guards against double-create via findByJourneyId check.

    // ── AC-3: Build EvaluationInput and delegate to shared service ────────────
    // BL-315: ADR-031 BFF contract sends ONLY journey_id + user_id (no segments).
    // If segments are absent/empty in the body, load them from journey_matcher.journey_segments.
    // If still empty after DB lookup (genuine no-journey), return early no_data without a row.
    let segments: EvaluationSegment[] = Array.isArray(body.segments) ? body.segments as EvaluationSegment[] : [];

    if (segments.length === 0) {
      // Load from journey_matcher.journey_segments (cross-schema read — ADR-001)
      segments = await this.journeyRepository.findSegmentsByJourneyId(body.journey_id as string);
    }

    // Genuine empty journey (no DB segments either) — return no_data without creating a row
    if (segments.length === 0) {
      res.status(200).json({ status: 'no_data' });
      return;
    }

    // Derive top-level journey fields from segments when not supplied in body.
    // BL-356: origin fields come from seg0 (first segment); destination fields come from the
    // LAST segment so that multi-leg journeys use the real final destination, not an interchange.
    const seg0 = segments[0];
    const lastSeg = segments[segments.length - 1];
    const input: EvaluationInput = {
      journey_id: body.journey_id as string,
      user_id: body.user_id as string,
      origin_crs: typeof body.origin_crs === 'string' ? body.origin_crs : seg0.origin_crs,
      destination_crs: typeof body.destination_crs === 'string' ? body.destination_crs : lastSeg.destination_crs,
      departure_datetime: typeof body.departure_datetime === 'string' ? body.departure_datetime : seg0.scheduled_departure,
      arrival_datetime: typeof body.arrival_datetime === 'string' ? body.arrival_datetime : lastSeg.scheduled_arrival,
      toc_code: typeof body.toc_code === 'string' ? body.toc_code : (seg0.toc_code ?? null),
      segments,
      correlation_id: (body.correlation_id as string) ?? undefined,
      ticket_fare_pence: typeof body.ticket_fare_pence === 'number' ? body.ticket_fare_pence : null,
      ticket_class: typeof body.ticket_class === 'string' ? body.ticket_class : null,
      ticket_type: typeof body.ticket_type === 'string' ? body.ticket_type : null,
    };

    // ── Run shared evaluation (AC-3) ──────────────────────────────────────────
    const evaluationResult = await this.delayEvaluationService.evaluate(input);

    // ── AC-4: Map to terminal HTTP response ───────────────────────────────────
    // NEVER return 'pending'
    switch (evaluationResult.outcome) {
      case 'delayed':
        res.status(200).json({
          status: evaluationResult.cancelled ? 'cancelled' : 'delayed',
          delay_minutes: evaluationResult.delay_minutes,
          cancelled: evaluationResult.cancelled,
          toc_code: evaluationResult.toc_code,
          last_observed_at: evaluationResult.last_observed_at,
        });
        return;

      case 'on_time':
        res.status(200).json({
          status: 'on_time',
          delay_minutes: evaluationResult.delay_minutes,
          cancelled: false,
          toc_code: evaluationResult.toc_code,
          last_observed_at: evaluationResult.last_observed_at,
        });
        return;

      case 'no_data':
        res.status(200).json({ status: 'no_data' });
        return;

      default:
        res.status(200).json({ status: 'no_data' });
    }
  }
}
