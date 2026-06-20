/**
 * BL-357: GET /delays/:journeyId — stale completed+no-alert row MUST return 404
 *
 * Phase  : T2-test (Jessie — Test Specification)
 * Bug    : A monitored_journeys row with monitoring_status='completed' AND no
 *          delay_alert → handler returns 200 on_time. When this row is stale
 *          (from a prior incomplete single-leg evaluation), the BFF sees 200 and
 *          does NOT trigger the ADR-031 ensure path (dtResult.statusCode === 404
 *          check in check-delay.handler.ts:468). Multi-leg re-runs receive the
 *          stale leg-1-only on_time verdict.
 *
 * Fix    : Blake changes the completed+no-alert branch (~lines 250-287 of
 *          delay-query.handler.ts) to return 404 { error: 'unknown_journey' }
 *          instead of 200 on_time. The BFF's `dtResult.statusCode === 404` branch
 *          then fires ensureDelay(), which re-evaluates from full journey_segments.
 *
 * Delayed journeys are UNAFFECTED: the latestAlert branch (~line 217) fires first
 * (before the completed-no-alert branch is ever reached) and returns 200 delayed.
 *
 * NOTE on AC-2 (end-to-end): AC-2 of BL-357 spec (GET→BFF→ensure→SLW→27min
 * delayed) is an E2E/deploy gate, NOT unit-testable here. It is covered by the
 * real-browser replay gate after Blake's fix is deployed.
 *
 * RECONCILIATION NOTICE (Test Lock Rule):
 *   These existing Jessie-owned tests will become STALE after Blake's BL-357 fix
 *   and MUST be updated by Jessie at T2-verify time (NOT by Blake):
 *
 *   1. tests/unit/api/delay-query.handler.test.ts
 *      - AC-3 block (lines ~207-248): two tests assert completed+no-alert → 200
 *        on_time. After fix these must assert 404.
 *      - AC-13 block (lines ~567-583): "should log outcome=on_time for a completed
 *        journey with no alerts" — after fix the outcome will be 'unknown' (404 path
 *        uses the unknown_journey log branch). Must be updated.
 *
 *   2. tests/integration/api/delay-query-endpoint.test.ts
 *      - AC-3 block (lines ~230-248): seeds completed journey + no alerts → asserts
 *        200 on_time. After fix must assert 404.
 *
 *   These are listed here for Jessie's T2-verify checklist. Blake MUST NOT touch
 *   the above files.
 *
 * IMPORTANT (Test Lock Rule): Blake MUST NOT modify these tests.
 * If a test appears wrong Blake must return it to Jessie with reasoning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

import { DelayQueryHandler } from '../../../src/api/delay-query.handler.js';
import { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';

// ---------------------------------------------------------------------------
// UUID constants — unique per scenario (ADR-017 / Guideline #6)
// ---------------------------------------------------------------------------

// BL-357 AC-1 / AC-4: completed + NO alert → stale row → must be 404
const BL357_USER_STALE = 'aa357001-0000-4000-8000-000000000001';
const BL357_JOURNEY_STALE = 'bb357001-0000-4000-8000-000000000001';
const BL357_MONITORED_STALE = 'cc357001-0000-4000-8000-000000000001';

// BL-357 AC-3a no-regression: completed + WITH delay alert → must still 200 delayed
const BL357_USER_DELAYED_COMPLETED = 'aa357002-0000-4000-8000-000000000002';
const BL357_JOURNEY_DELAYED_COMPLETED = 'bb357002-0000-4000-8000-000000000002';
const BL357_MONITORED_DELAYED_COMPLETED = 'cc357002-0000-4000-8000-000000000002';

// BL-357 AC-3b no-regression: active + NO alert → still pending (not affected by fix)
const BL357_USER_ACTIVE_NO_ALERT = 'aa357003-0000-4000-8000-000000000003';
const BL357_JOURNEY_ACTIVE_NO_ALERT = 'bb357003-0000-4000-8000-000000000003';
const BL357_MONITORED_ACTIVE_NO_ALERT = 'cc357003-0000-4000-8000-000000000003';

// BL-357 AC-3c no-regression: journey not found (no row) → still 404 unknown_journey
const BL357_JOURNEY_NOT_FOUND = 'bb357004-0000-4000-8000-000000000004';
const BL357_USER_NOT_FOUND = 'aa357004-0000-4000-8000-000000000004';

// Realistic timestamps
const LAST_CHECKED_AT = new Date('2026-06-20T10:00:00.000Z');
const SCHEDULED_ARRIVAL = new Date('2026-06-20T12:00:00.000Z');
const ALERT_DETECTED_AT = new Date('2026-06-20T11:30:00.000Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMonitoredJourney(
  journeyId: string,
  userId: string,
  monitoredId: string,
  status: string,
  lastCheckedAt: Date | null = LAST_CHECKED_AT,
) {
  return {
    id: monitoredId,
    user_id: userId,
    journey_id: journeyId,
    monitoring_status: status,
    last_checked_at: lastCheckedAt,
    scheduled_arrival: SCHEDULED_ARRIVAL,
    toc_code: null,
  };
}

function buildDelayAlert(
  monitoredJourneyId: string,
  delayMinutes: number,
  isCancellation = false,
  detectedAt: Date = ALERT_DETECTED_AT,
) {
  return {
    monitored_journey_id: monitoredJourneyId,
    delay_minutes: delayMinutes,
    is_cancellation: isCancellation,
    delay_detected_at: detectedAt,
  };
}

function buildApp(
  journeyRepo: Partial<InstanceType<typeof JourneyRepository>>,
  alertRepo: Partial<InstanceType<typeof DelayAlertRepository>>,
): Express {
  const app = express();
  app.use(express.json());
  const handler = new DelayQueryHandler({
    journeyRepository: journeyRepo,
    delayAlertRepository: alertRepo,
  });
  handler.register(app);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BL-357: GET /delays/:journeyId — stale completed+no-alert row forces ensure re-eval', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC-1 (primary): completed + no delay_alert → 404
  // -------------------------------------------------------------------------
  describe('AC-1: monitoring_status=completed with NO delay_alert row returns 404', () => {
    it('should return 404 (not 200 on_time) when monitoring_status=completed and no delay alert exists', async () => {
      // This is the STALE case: a prior incomplete evaluation left a 'completed'
      // row but no alert. The handler currently returns 200 on_time — that is the
      // BUG. After Blake's fix it must return 404 so the BFF calls ensureDelay().

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_STALE,
            BL357_USER_STALE,
            BL357_MONITORED_STALE,
            'completed',
            LAST_CHECKED_AT,
          ),
        ),
      };
      // No alert row — returns null
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${BL357_JOURNEY_STALE}?user_id=${BL357_USER_STALE}`);

      // MUST be 404 after Blake's fix
      // (Currently returns 200 — this test FAILS in RED state, proving the gap)
      expect(res.status).toBe(404);
    });

    it('should return 404 body compatible with BFF ensure branch (error=unknown_journey or similar 404 body)', async () => {
      // The BFF keys on dtResult.statusCode === 404 (check-delay.handler.ts:468).
      // The exact body is secondary — but must be a well-formed JSON object.
      // The existing not-found path already returns { error: 'unknown_journey' },
      // which is the natural body shape for this 404 to match.

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_STALE,
            BL357_USER_STALE,
            BL357_MONITORED_STALE,
            'completed',
            null, // last_checked_at = null (edge case: no check timestamp)
          ),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${BL357_JOURNEY_STALE}?user_id=${BL357_USER_STALE}`);

      expect(res.status).toBe(404);
      // Body must be a JSON object (BFF will receive it)
      expect(typeof res.body).toBe('object');
      expect(res.body).not.toBeNull();
    });

    it('should NOT return 200 with status=on_time when completed+no-alert (anti-stale cache assertion)', async () => {
      // AC-4 anti-stale intent: the system must not serve a cached on_time verdict
      // for a row that represents an incomplete prior single-leg evaluation.
      // After Blake's fix, this path 404s → BFF calls ensure → full re-eval.

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_STALE,
            BL357_USER_STALE,
            BL357_MONITORED_STALE,
            'completed',
            LAST_CHECKED_AT,
          ),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${BL357_JOURNEY_STALE}?user_id=${BL357_USER_STALE}`);

      // Must NOT be 200 on_time (the stale verdict)
      expect(res.status).not.toBe(200);
      // Must NOT have on_time in body (defensive; after fix the response is 404)
      if (res.body && typeof res.body === 'object') {
        expect(res.body.status).not.toBe('on_time');
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC-3a no-regression: completed + WITH delay alert → still 200 delayed
  // -------------------------------------------------------------------------
  describe('AC-3a no-regression: completed + WITH delay alert still returns 200 delayed', () => {
    it('should return 200 delayed (not 404) when monitoring_status=completed AND delay alert exists', async () => {
      // The latestAlert branch (~line 217) fires BEFORE the completed-no-alert
      // branch. A completed row with an alert must remain on the 200-delayed path.
      // This confirms the fix is scoped ONLY to the completed+no-alert case.

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_DELAYED_COMPLETED,
            BL357_USER_DELAYED_COMPLETED,
            BL357_MONITORED_DELAYED_COMPLETED,
            'completed', // completed — but HAS an alert
            LAST_CHECKED_AT,
          ),
        ),
      };
      // Alert exists — 27-minute delay (representative of the LDS→NQY leg-3 scenario)
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          buildDelayAlert(BL357_MONITORED_DELAYED_COMPLETED, 27, false),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(
        `/delays/${BL357_JOURNEY_DELAYED_COMPLETED}?user_id=${BL357_USER_DELAYED_COMPLETED}`,
      );

      // Must still be 200 delayed (latestAlert branch fires first, fix MUST NOT affect this)
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('delayed');
      expect(res.body.delay_minutes).toBe(27);
      expect(res.body.cancelled).toBe(false);
      // Critically: must NOT be 404
      expect(res.status).not.toBe(404);
    });

    it('should return 200 cancelled when completed + cancellation alert exists', async () => {
      // Cancellation variant: completed row + cancellation alert → still 200 cancelled
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_DELAYED_COMPLETED,
            BL357_USER_DELAYED_COMPLETED,
            BL357_MONITORED_DELAYED_COMPLETED,
            'completed',
            LAST_CHECKED_AT,
          ),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          buildDelayAlert(BL357_MONITORED_DELAYED_COMPLETED, 0, true /* isCancellation */),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(
        `/delays/${BL357_JOURNEY_DELAYED_COMPLETED}?user_id=${BL357_USER_DELAYED_COMPLETED}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.cancelled).toBe(true);
      expect(res.status).not.toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // AC-3b no-regression: active + no alert → still 200 pending (unchanged)
  // -------------------------------------------------------------------------
  describe('AC-3b no-regression: active+no-alert still returns 200 pending (fix is scoped to completed only)', () => {
    it('should return 200 pending for monitoring_status=active with no alert (unchanged by fix)', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_ACTIVE_NO_ALERT,
            BL357_USER_ACTIVE_NO_ALERT,
            BL357_MONITORED_ACTIVE_NO_ALERT,
            'active',
            null,
          ),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(
        `/delays/${BL357_JOURNEY_ACTIVE_NO_ALERT}?user_id=${BL357_USER_ACTIVE_NO_ALERT}`,
      );

      // Must still be 200 pending — fix MUST NOT widen the 404 to non-completed statuses
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.message).toBe('no delay data yet');
    });

    it('should return 200 pending for monitoring_status=pending_rid with no alert (unchanged)', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_ACTIVE_NO_ALERT,
            BL357_USER_ACTIVE_NO_ALERT,
            BL357_MONITORED_ACTIVE_NO_ALERT,
            'pending_rid',
            null,
          ),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(
        `/delays/${BL357_JOURNEY_ACTIVE_NO_ALERT}?user_id=${BL357_USER_ACTIVE_NO_ALERT}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });

    it('should return 200 pending for monitoring_status=darwin_unavailable with no alert (unchanged)', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(
            BL357_JOURNEY_ACTIVE_NO_ALERT,
            BL357_USER_ACTIVE_NO_ALERT,
            BL357_MONITORED_ACTIVE_NO_ALERT,
            'darwin_unavailable',
            null,
          ),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(
        `/delays/${BL357_JOURNEY_ACTIVE_NO_ALERT}?user_id=${BL357_USER_ACTIVE_NO_ALERT}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // AC-3c no-regression: journey not found (no row) → still 404 unknown_journey
  // -------------------------------------------------------------------------
  describe('AC-3c no-regression: journey-not-found still returns 404 (existing behaviour unchanged)', () => {
    it('should return 404 unknown_journey when no monitored_journeys row exists (pre-existing behaviour)', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(null),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn(),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${BL357_JOURNEY_NOT_FOUND}?user_id=${BL357_USER_NOT_FOUND}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('unknown_journey');
      // Alert repo must not be called (no row to look up)
      expect(mockAlertRepo.findLatestByMonitoredJourneyId).not.toHaveBeenCalled();
    });
  });
});
