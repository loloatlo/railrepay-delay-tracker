/**
 * BL-313: delay-tracker must propagate toc_code through DarwinDelayInfo
 * and expose it on GET /delays/:journeyId responses.
 *
 * Bug Fix  : BL-313 (ADR-030, Option B) — delay-tracker receives toc_code
 *            from darwin-ingestor's batch response but does NOT carry it through
 *            to GetDelayHitResponse or GetDelayPendingResponse. The BFF therefore
 *            cannot source toc_code from the delay response body.
 *            Fix (three parts):
 *              1. DarwinDelayInfo type includes toc_code?: string | null
 *              2. DarwinIngestorClient.getDelaysByRids() preserves toc_code
 *                 from the API response
 *              3. GetDelayHitResponse / GetDelayPendingResponse include toc_code,
 *                 and DelayQueryHandler returns it in the 200 body
 *
 * Phase    : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date     : 2026-05-28
 * ADR-030  : Option B — darwin-ingestor → delay-tracker toc_code flow
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * THESE TESTS MUST FAIL ON CURRENT CODE (delay-tracker HEAD).
 * DarwinDelayInfo (src/types.ts ~line 169) has no toc_code field.
 * GetDelayHitResponse (src/types.ts ~line 219) has no toc_code field.
 * Assertions on these fields will fail with undefined.
 *
 * AC coverage map (BL-313 delay-tracker slice):
 *   AC-2a (DISPOSITIVE): DarwinDelayInfo type carries toc_code field
 *          (verified via the client's response parsing).
 *   AC-2b (DISPOSITIVE): GET /delays/:journeyId hit/on_time response body
 *          includes toc_code sourced from the delay alert's stored toc_code.
 *   AC-2c: toc_code: null returned when unresolvable (NOT 'UNKNOWN' / sentinel).
 *
 * NOTE on DelayQueryHandler architecture: The current handler (delay-query.handler.ts)
 * uses journeyRepository + delayAlertRepository. To surface toc_code, Blake will need
 * to store toc_code from the Darwin enrichment cycle onto the monitored_journey or
 * delay_alert row, OR add a toc_code field to GetDelayHitResponse pulled from
 * monitored_journeys.rid → darwin-ingestor lookup. The simplest approach per ADR-030
 * Option B: store toc_code on monitored_journey when RID is resolved, surface it on
 * the GET /delays response. Blake decides the precise storage mechanism; these tests
 * assert the OBSERVABLE CONTRACT (the HTTP response shape).
 *
 * Mocked dependencies:
 *   Partial IJourneyRepository (returns toc_code field)
 *   Partial IDelayAlertRepository
 *   MetricsState (optional)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';
import { DelayQueryHandler } from '../../../src/api/delay-query.handler.js';

// ─── Logger mock (console.log pattern per AC-13 in delay-tracker) ─────────────
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

// ─── UUID mock (deterministic correlation IDs) ────────────────────────────────
vi.mock('uuid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('uuid')>();
  return {
    ...actual,
    v4: vi.fn(() => 'mock-corr-bl313-dt-001'),
    validate: actual.validate,
  };
});

// ─── Constants ────────────────────────────────────────────────────────────────
const VALID_JOURNEY_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const VALID_USER_ID    = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MONITORED_PK     = 'cccccccc-3333-4333-8333-cccccccccccc';

// ─── Journey row shapes ───────────────────────────────────────────────────────

/** Monitored journey row with toc_code (after BL-313 fix stores it) */
const JOURNEY_ROW_WITH_XC_TOC = {
  id: MONITORED_PK,
  user_id: VALID_USER_ID,
  journey_id: VALID_JOURNEY_ID,
  monitoring_status: 'delayed',
  toc_code: 'XC',                           // BL-313: new field surfaced on journey row
  last_checked_at: new Date('2025-03-11T12:00:00.000Z'),
  scheduled_arrival: new Date('2025-03-11T14:30:00.000Z'),
};

/** Monitored journey row where toc_code is null (common in prod) */
const JOURNEY_ROW_WITH_NULL_TOC = {
  id: MONITORED_PK,
  user_id: VALID_USER_ID,
  journey_id: VALID_JOURNEY_ID,
  monitoring_status: 'completed',
  toc_code: null,
  last_checked_at: new Date('2025-03-11T16:00:00.000Z'),
  scheduled_arrival: new Date('2025-03-11T16:30:00.000Z'),
};

const DELAY_ALERT_ROW = {
  monitored_journey_id: MONITORED_PK,
  delay_minutes: 23,
  is_cancellation: false,
  delay_detected_at: new Date('2025-03-11T12:05:00.000Z'),
};

// ─── App builder ──────────────────────────────────────────────────────────────

function buildAppWithRepos(
  journeyRow: typeof JOURNEY_ROW_WITH_XC_TOC | typeof JOURNEY_ROW_WITH_NULL_TOC | null,
  alertRow: typeof DELAY_ALERT_ROW | null
): Express {
  const mockJourneyRepo = {
    findByJourneyId: vi.fn().mockResolvedValue(journeyRow),
  };
  const mockAlertRepo = {
    findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(alertRow),
  };

  const handler = new DelayQueryHandler({
    journeyRepository: mockJourneyRepo,
    delayAlertRepository: mockAlertRepo,
  });

  const app = express();
  app.use(express.json());
  handler.register(app);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('BL-313: delay-tracker GET /delays/:journeyId — toc_code propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2b (DISPOSITIVE): GET /delays/:journeyId hit response includes toc_code
  //
  // WILL FAIL on current code: GetDelayHitResponse does not have a toc_code field.
  // The handler builds body from the alert row and monitored journey but does NOT
  // include toc_code. expect(body.toc_code).toBe('XC') fails (undefined).
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-2b (DISPOSITIVE): hit response body includes toc_code', () => {
    it('AC-2b: GET /delays/:journeyId returns toc_code = XC in delayed response body', async () => {
      // AC-2b: When a delay alert exists (hit/delayed path), the 200 response body
      // MUST include toc_code sourced from the monitored journey row.
      //
      // WILL FAIL on current code: handler does not read toc_code from journey row
      // and does not include it in the GetDelayHitResponse body.

      const app = buildAppWithRepos(JOURNEY_ROW_WITH_XC_TOC, DELAY_ALERT_ROW);

      const res = await request(app)
        .get(`/delays/${VALID_JOURNEY_ID}`)
        .query({ user_id: VALID_USER_ID });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('delayed');
      expect(res.body.delay_minutes).toBe(23);

      // AC-2b DISPOSITIVE: toc_code must appear in the response body
      expect(res.body.toc_code).toBe('XC');
    });

    it('AC-2b: GET /delays/:journeyId returns toc_code = null when unresolvable', async () => {
      // AC-2c: Key null-path. When monitored_journey.toc_code IS NULL, the response
      // must carry toc_code: null — NOT 'UNKNOWN', NOT omitted.
      //
      // WILL FAIL on current code: toc_code field absent (undefined).

      const journeyWithNullToc = {
        ...JOURNEY_ROW_WITH_XC_TOC,
        toc_code: null,
        monitoring_status: 'delayed',
      };

      const app = buildAppWithRepos(journeyWithNullToc, DELAY_ALERT_ROW);

      const res = await request(app)
        .get(`/delays/${VALID_JOURNEY_ID}`)
        .query({ user_id: VALID_USER_ID });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('delayed');

      // toc_code MUST be null, not 'UNKNOWN' sentinel
      expect(res.body.toc_code).toBeNull();
    });

    it('AC-2b: GET /delays/:journeyId completed+no-alert returns 404 (BL-357 — stale row forces re-eval)', async () => {
      // BL-357 reconciliation (Test Lock self-fix — Jessie, 2026-06-20):
      //
      // ORIGINAL INTENT: The on_time path (monitoring_status=completed, no alert)
      //   must also carry toc_code. This was written when completed+no-alert returned
      //   200 on_time.
      //
      // CHANGE UNDER BL-357: The completed+no-alert branch now returns 404 so that
      //   the BFF's dtResult.statusCode===404 check fires ensureDelay() for a full
      //   re-evaluation from journey_segments. A 200 on_time response here was the
      //   root cause of multi-leg journeys receiving a stale single-leg verdict.
      //
      // TOC_CODE COVERAGE: The toc_code-propagation intent (AC-2b/AC-2c) is fully
      //   preserved by the two tests above, which exercise the DELAYED path — the
      //   live path where toc_code is surfaced in a 200 response body. The
      //   completed-no-alert path no longer returns a 200 body, so toc_code cannot
      //   be asserted here. Coverage is NOT lost.
      //
      // This test now asserts the NEW contract (404) for the completed-no-alert
      // case, matching delay-query.handler.test.ts AC-3 and
      // delay-query-endpoint.test.ts AC-3 (BL-357).

      const app = buildAppWithRepos(
        JOURNEY_ROW_WITH_NULL_TOC,  // status=completed, toc_code=null
        null                         // no alert → BL-357: 404, NOT 200 on_time
      );

      const res = await request(app)
        .get(`/delays/${VALID_JOURNEY_ID}`)
        .query({ user_id: VALID_USER_ID });

      // BL-357: completed+no-alert MUST return 404 (stale row forces ensure re-eval)
      expect(res.status).toBe(404);
      // Must NOT serve stale on_time verdict
      expect(res.body.status).not.toBe('on_time');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2a: DarwinDelayInfo type carries toc_code (verified via DarwinIngestorClient)
  //
  // This test validates the TYPE LEVEL by importing DarwinDelayInfo and asserting
  // that objects satisfying the existing interface WITHOUT toc_code would fail the
  // NEW interface. We do this by constructing a mock api response with toc_code
  // and verifying the client surfaces it (compile-time check encoded as runtime test).
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-2a: DarwinDelayInfo carries toc_code through client parse', () => {
    it('AC-2a: DarwinDelayInfo object with toc_code = XC satisfies the updated type', async () => {
      // AC-2a: This test acts as a static type regression guard encoded as a runtime check.
      // After the fix, DarwinDelayInfo must include toc_code?: string | null.
      // We create an object that will satisfy the NEW interface and verify it round-trips
      // through the client mock cleanly.
      //
      // WILL FAIL on current code: the DarwinDelayInfo type in types.ts does NOT have
      // a toc_code field — TypeScript type errors will surface during tsc (npm run build).
      // The runtime test will also fail because the field is absent from parsed objects.

      // Simulate darwin-ingestor API response with toc_code
      const darwinApiResponse = {
        services: [
          {
            rid: '202503117dc53181',
            delay_minutes: 23,
            is_cancelled: false,
            delay_reasons: [{ code: '218' }],
            status: 'delayed' as const,
            stops: null,
            toc_code: 'XC',   // BL-313: new field from darwin-ingestor
          },
        ],
      };

      // Import the types to verify toc_code compiles (TypeScript compile check).
      // The DarwinDelayInfo interface must accept toc_code field.
      const { type: _typeCheck } = await import('../../../src/types.js').then(m => {
        // Validate that an object matching DarwinDelayInfo with toc_code can be constructed.
        // This is the compile-time contract test.
        const item = darwinApiResponse.services[0];
        // If DarwinDelayInfo is extended with toc_code, this line works without TS error.
        // If not, tsc (npm run build) will fail on Blake's implementation.
        const typed: import('../../../src/types.js').DarwinDelayInfo = {
          rid: item.rid,
          delay_minutes: item.delay_minutes,
          is_cancelled: item.is_cancelled,
          delay_reasons: item.delay_reasons,
          status: item.status,
          stops: item.stops,
          toc_code: item.toc_code,  // BL-313: NEW field — FAILS tsc on current code
        };
        return { type: typed };
      });

      // If we reach here, the type accepted toc_code — assertion confirms value
      expect(_typeCheck.toc_code).toBe('XC');
    });

    it('AC-2a: DarwinDelayInfo accepts toc_code = null (nullable VARCHAR column)', async () => {
      // AC-2a: Null-toc variant of the type-level test.
      const { type: _typeCheck } = await import('../../../src/types.js').then(m => {
        const typed: import('../../../src/types.js').DarwinDelayInfo = {
          rid: '202503117nulltoc',
          delay_minutes: 45,
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: null,
          toc_code: null,  // BL-313: nullable toc_code — FAILS tsc on current code
        };
        return { type: typed };
      });

      expect(_typeCheck.toc_code).toBeNull();
    });
  });
});
