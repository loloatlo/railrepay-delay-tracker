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
} from '../services/delay-evaluation.service.js';

// ─── Deps interface ───────────────────────────────────────────────────────────

interface IJourneyRepository {
  findByJourneyId(journeyId: string): Promise<unknown>;
  // Return type is deliberately `unknown` — DelayEnsureHandler never uses the returned value
  // directly; it delegates all persistence to DelayEvaluationService. Using `unknown` avoids
  // a structural incompatibility with JourneyRepository.create() → Promise<MonitoredJourney>
  // (which lacks an index signature).
  create(data: unknown): Promise<unknown>;
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
    const segments = Array.isArray(body.segments) ? body.segments : [];

    // If no segments provided, we cannot do a Darwin lookup — return no_data
    if (segments.length === 0) {
      res.status(200).json({ status: 'no_data' });
      return;
    }

    const input: EvaluationInput = {
      journey_id: body.journey_id as string,
      user_id: body.user_id as string,
      origin_crs: (body.origin_crs as string) ?? '',
      destination_crs: (body.destination_crs as string) ?? '',
      departure_datetime: (body.departure_datetime as string) ?? new Date().toISOString(),
      arrival_datetime: (body.arrival_datetime as string) ?? new Date().toISOString(),
      toc_code: (body.toc_code as string | null) ?? null,
      segments: segments as EvaluationInput['segments'],
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
