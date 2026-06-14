/**
 * RED Tests: BL-337 / TD-DELAY-MULTILEG-001
 * Wire SequentialLegWalk into DelayEvaluationService.evaluate()
 *
 * Phase   : TD-1 (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-337
 * TD ID   : TD-DELAY-MULTILEG-001
 * ADR     : ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 * ADR     : ADR-031 — Synchronous ensure-on-404 (evaluate() is the ensure path)
 * Date    : 2026-06-14
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * ─── THE BUG ──────────────────────────────────────────────────────────────────
 * DelayEvaluationService.evaluate() uses ONLY input.segments[0] for the Darwin
 * lookup (line 98). Multi-leg journeys are therefore judged on leg-1's delay, not
 * the final-destination delay ADR-021 requires. BL-181's SequentialLegWalk is
 * built and tested but never wired into evaluate().
 *
 * ─── WHAT BLAKE MUST DO (TD-2) ───────────────────────────────────────────────
 * 1. Extend DelayEvaluationServiceDeps to accept:
 *      sequentialLegWalk?: SequentialLegWalk
 *    (or: tiplocRepository + otpClient so evaluate() can instantiate SLW itself)
 *    The consumer wiring pattern (event-consumer.ts:126-151) is the reference —
 *    mirror it: TiplocRepository wrapping Pool.query + stub OtpClient → null.
 *
 * 2. evaluate() MUST call sequentialLegWalk.calculate() with:
 *      legs    : segments mapped to JourneyLeg[]
 *                (rid, originCrs, destinationCrs, scheduledArrival, scheduledDeparture,
 *                 connectionThresholdMinutes: null for all legs — not provided by EvaluationInput)
 *      finalDestinationCrs    : input.destination_crs
 *      scheduledFinalArrival  : input.arrival_datetime
 *
 * 3. Use the SLW result (LegWalkResult) to determine terminal outcome:
 *      status='completed' + delay_minutes >= 15  → delayed
 *      status='completed' + delay_minutes < 15   → on_time
 *      status='assessment_pending'               → no_data (Darwin unavailable)
 *      status='needs_manual_review'              → no_data (OTP found nothing)
 *      delay_minutes === null                    → no_data
 *
 * 4. Darwin availability pre-check: keep existing getServiceWithStops guard
 *    UNCHANGED — Blake MUST NOT remove it. It still runs on segments[0].rid.
 *
 * 5. Single-leg (N=1) MUST produce byte-for-byte identical outcomes as today.
 *
 * 6. Wiring in index.ts (lines 152-163): add TiplocRepository + stub OtpClient +
 *    SequentialLegWalk to the DelayEvaluationService constructor call, mirroring
 *    the pattern at event-consumer.ts:126-151.
 *
 * ─── SLW INTERFACE (for Blake's reference) ───────────────────────────────────
 * class SequentialLegWalk {
 *   constructor(deps: { tiplocRepository: TiplocRepository; darwinClient: DarwinClient; otpClient: OtpClient })
 *   async calculate(params: {
 *     legs: JourneyLeg[];
 *     finalDestinationCrs: string;
 *     scheduledFinalArrival: string;
 *   }): Promise<LegWalkResult>
 * }
 * type LegWalkResult = {
 *   delay_minutes: number | null;
 *   actual_final_arrival: string | null;
 *   scheduled_final_arrival: string;
 *   status: 'completed' | 'assessment_pending' | 'needs_manual_review';
 * }
 *
 * ─── AC COVERAGE MAP ──────────────────────────────────────────────────────────
 * AC-1 : Multi-leg evaluate() uses SLW and returns final-destination delay
 * AC-2 : Single-leg parity — N=1 terminal outcomes unchanged (4 terminals)
 * AC-3 : DISPOSITIVE — leg-1 on-time but leg-2 delayed → evaluate() reports leg-2 delay
 * AC-4 : Stub OtpClient (null) degrades gracefully — no crash, no fabricated zero
 * AC-5 : /delays/ensure with multi-leg segments returns correct final-destination verdict
 *
 * ─── BL-181 OTP-BRANCH FAILURES (6 pre-existing) ─────────────────────────────
 * The 6 failing BL-181 tests (AC-11, AC-12, AC-14, AC-16-partial, AC-17, AC-18)
 * are in the OTP-replacement branch of SequentialLegWalk itself.
 * DECISION: leave them failing and explicitly quarantine them here.
 * Rationale: they test the SLW OTP-replacement path which is deferred pending a
 * working OTP client (the stub returns null). Fixing them requires real OTP routing —
 * that is tracked as a follow-on TD item (TD-OTP-REPLACEMENT-001, to be created at
 * TD-5 close). They are NOT blocked by this TD (BL-337) and are NOT silently skipped.
 * See: services/delay-tracker/tests/unit/services/BL-181-sequential-leg-walk.test.ts
 *      services/delay-tracker/tests/unit/services/BL-181-regression-scenarios.test.ts
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-021 — Fundamental Delay Equation
 *   ADR-031 — Synchronous ensure-on-404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Shared logger mock (Guideline #11: outside factory) ─────────────────────

const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── Module imports ───────────────────────────────────────────────────────────

import {
  DelayEvaluationService,
  type EvaluationInput,
  type EvaluationSegment,
} from '../../../src/services/delay-evaluation.service.js';

import { DelayEnsureHandler } from '../../../src/api/delay-ensure.handler.js';

// ─── Journey & station constants ──────────────────────────────────────────────

// Journey IDs (UUID v4)
const JOURNEY_MULTI  = 'b3370000-0001-4000-8000-000000000001';
const JOURNEY_SINGLE = 'b3370000-0002-4000-8000-000000000002';
const JOURNEY_DISP   = 'b3370000-0003-4000-8000-000000000003';  // AC-3 dispositive
const JOURNEY_STUB   = 'b3370000-0004-4000-8000-000000000004';  // AC-4 stub OTP
const JOURNEY_ENSURE = 'b3370000-0005-4000-8000-000000000005';  // AC-5 ensure endpoint
const USER_A = 'b3370000-0001-4000-8001-000000000001';

// Real TIPLOC / CRS pairs (from tiploc-crs-mapping.fixtures.ts)
const YORK_CRS      = 'YRK';  // tiploc: YORK
const YORK_TIPLOC   = 'YORK';
const KGX_CRS       = 'KGX';  // tiploc: KNGSCRS
const KGX_TIPLOC    = 'KNGSCRS';
const LEEDS_CRS     = 'LDS';  // tiploc: LEEDS
const LEEDS_TIPLOC  = 'LEEDS';

// Travel date for AC-3 dispositive scenario
const TRAVEL_DATE = '2026-06-20';

// ─── Realistic EvaluationSegment helpers ─────────────────────────────────────

function makeSingleSegment(): EvaluationSegment[] {
  return [
    {
      segment_order: 0,
      origin_crs: YORK_CRS,
      destination_crs: KGX_CRS,
      scheduled_departure: `${TRAVEL_DATE}T08:30:00.000Z`,
      scheduled_arrival:   `${TRAVEL_DATE}T10:30:00.000Z`,
      rid: '202606207108175',
      toc_code: 'GR',
    },
  ];
}

/**
 * 2-leg journey: York → Leeds (leg 1) then Leeds → KGX (leg 2).
 * Leg 1 RID: 202606207201000  Leg 2 RID: 202606207202000
 */
function makeTwoLegSegments(): EvaluationSegment[] {
  return [
    {
      segment_order: 0,
      origin_crs: YORK_CRS,
      destination_crs: LEEDS_CRS,
      scheduled_departure: `${TRAVEL_DATE}T08:00:00.000Z`,
      scheduled_arrival:   `${TRAVEL_DATE}T08:30:00.000Z`,
      rid: '202606207201000',
      toc_code: 'TP',
    },
    {
      segment_order: 1,
      origin_crs: LEEDS_CRS,
      destination_crs: KGX_CRS,
      scheduled_departure: `${TRAVEL_DATE}T08:45:00.000Z`,
      scheduled_arrival:   `${TRAVEL_DATE}T10:30:00.000Z`,
      rid: '202606207202000',
      toc_code: 'GR',
    },
  ];
}

function makeEvaluationInput(
  journeyId: string,
  segments: EvaluationSegment[],
): EvaluationInput {
  const first = segments[0];
  const last  = segments[segments.length - 1];
  return {
    journey_id: journeyId,
    user_id: USER_A,
    origin_crs: first.origin_crs,
    destination_crs: last.destination_crs,
    departure_datetime: first.scheduled_departure,
    arrival_datetime: last.scheduled_arrival,
    toc_code: first.toc_code,
    segments,
    correlation_id: `corr-bl337-${journeyId.slice(-4)}`,
    ticket_fare_pence: 7467,
    ticket_class: 'standard',
    ticket_type: 'anytime',
  };
}

// ─── Shared mock builder ──────────────────────────────────────────────────────

function buildMocks() {
  const mockJourneyRepo = {
    findByJourneyId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'monitored-uuid-bl337-001' }),
    findSegmentsByJourneyId: vi.fn().mockResolvedValue([]),
  };

  const mockDelayAlertRepo = {
    findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'alert-uuid-bl337-001' }),
  };

  const mockOutboxRepo = {
    create: vi.fn().mockResolvedValue(undefined),
  };

  // Darwin client mock — getServiceWithStops + getDelayInfo both present
  const mockDarwinClient = {
    getDelayInfo: vi.fn(),
    getServiceWithStops: vi.fn(),
  };

  // SequentialLegWalk mock — calculate() is the call we assert SLW was used
  const mockSequentialLegWalk = {
    calculate: vi.fn(),
  };

  // TiplocRepository mock (needed if Blake wires deps individually)
  const mockTiplocRepo = {
    getCrsByTiploc: vi.fn(),
    getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
      if (crs === YORK_CRS)  return [YORK_TIPLOC];
      if (crs === KGX_CRS)   return [KGX_TIPLOC];
      if (crs === LEEDS_CRS) return [LEEDS_TIPLOC];
      return [];
    }),
  };

  // Stub OtpClient — mirrors event-consumer.ts:137-141; always returns null
  const stubOtpClient = {
    findReplacementRoute: vi.fn().mockResolvedValue(null),
  };

  return {
    mockJourneyRepo,
    mockDelayAlertRepo,
    mockOutboxRepo,
    mockDarwinClient,
    mockSequentialLegWalk,
    mockTiplocRepo,
    stubOtpClient,
  };
}

/**
 * Build a DelayEvaluationService wired with a mock SequentialLegWalk.
 * Blake MUST accept `sequentialLegWalk` in DelayEvaluationServiceDeps.
 * This is the PRIMARY wiring assertion — test will fail at construction if Blake
 * has not extended the deps interface.
 */
function buildServiceWithSLW(
  mocks: ReturnType<typeof buildMocks>,
) {
  // FAILS TODAY: DelayEvaluationServiceDeps does not include sequentialLegWalk.
  // Blake must extend the interface. Cast to `any` to let the test run against
  // today's code and report the right failure (assertion error, not compile error).
  return new DelayEvaluationService({
    journeyRepository: mocks.mockJourneyRepo as any,
    delayAlertRepository: mocks.mockDelayAlertRepo as any,
    outboxRepository: mocks.mockOutboxRepo as any,
    darwinClient: mocks.mockDarwinClient as any,
    // AC-1: Blake must wire SLW here — today DelayEvaluationServiceDeps ignores this field
    sequentialLegWalk: mocks.mockSequentialLegWalk as any,
  } as any);
}

// ─── Express app builder for AC-5 ────────────────────────────────────────────

function buildEnsureApp(mocks: ReturnType<typeof buildMocks>): Express {
  const app = express();
  app.use(express.json());

  const evalService = buildServiceWithSLW(mocks);
  const handler = new DelayEnsureHandler({
    journeyRepository: mocks.mockJourneyRepo as any,
    delayEvaluationService: evalService,
  });
  handler.register(app);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Multi-leg journey uses SequentialLegWalk and returns final-destination delay
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-337 AC-1: Multi-leg evaluate() invokes SequentialLegWalk and returns final-destination delay', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    vi.clearAllMocks();
  });

  it('AC-1: should call sequentialLegWalk.calculate() for a 2-leg journey', async () => {
    // AC-1: FAILS TODAY — evaluate() ignores sequentialLegWalk and uses segments[0] only.
    // After Blake's fix, evaluate() MUST call slw.calculate() when segments.length >= 1.
    const service = buildServiceWithSLW(mocks);

    // SLW returns a 20-minute delay at final destination (KGX)
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 20,
      actual_final_arrival: `${TRAVEL_DATE}T10:50:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    // Darwin availability pre-check still runs (getServiceWithStops on leg-1 RID)
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: 5, // leg-1 delay — NOT what evaluate() should return for multi-leg
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [],
    });

    const input = makeEvaluationInput(JOURNEY_MULTI, makeTwoLegSegments());
    await service.evaluate(input);

    // Assert: SLW was called for the multi-leg journey
    expect(mocks.mockSequentialLegWalk.calculate).toHaveBeenCalledTimes(1);
  });

  it('AC-1: should call calculate() with all legs mapped from segments', async () => {
    // AC-1: The SLW calculate() call must receive legs derived from ALL segments,
    // not just segments[0].
    const service = buildServiceWithSLW(mocks);
    const segments = makeTwoLegSegments();

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 20,
      actual_final_arrival: `${TRAVEL_DATE}T10:50:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    const input = makeEvaluationInput(JOURNEY_MULTI, segments);
    await service.evaluate(input);

    const calculateCall = mocks.mockSequentialLegWalk.calculate.mock.calls[0][0];
    expect(calculateCall).toHaveProperty('legs');
    // Both segments must appear as legs
    expect(calculateCall.legs).toHaveLength(2);
    expect(calculateCall.legs[0].rid).toBe('202606207201000');
    expect(calculateCall.legs[0].originCrs).toBe(YORK_CRS);
    expect(calculateCall.legs[0].destinationCrs).toBe(LEEDS_CRS);
    expect(calculateCall.legs[1].rid).toBe('202606207202000');
    expect(calculateCall.legs[1].originCrs).toBe(LEEDS_CRS);
    expect(calculateCall.legs[1].destinationCrs).toBe(KGX_CRS);
  });

  it('AC-1: should pass finalDestinationCrs and scheduledFinalArrival to calculate()', async () => {
    // AC-1: calculate() params must include the journey-level final destination,
    // NOT just the first segment destination.
    const service = buildServiceWithSLW(mocks);
    const segments = makeTwoLegSegments();

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 20,
      actual_final_arrival: `${TRAVEL_DATE}T10:50:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    const input = makeEvaluationInput(JOURNEY_MULTI, segments);
    await service.evaluate(input);

    const calculateCall = mocks.mockSequentialLegWalk.calculate.mock.calls[0][0];
    // finalDestinationCrs must be KGX (input.destination_crs), NOT LEEDS (segments[0].destination_crs)
    expect(calculateCall.finalDestinationCrs).toBe(KGX_CRS);
    // scheduledFinalArrival must be input.arrival_datetime
    expect(calculateCall.scheduledFinalArrival).toBe(`${TRAVEL_DATE}T10:30:00.000Z`);
  });

  it('AC-1: should return delayed outcome with the final-destination delay from SLW (20 min)', async () => {
    // AC-1: The returned outcome must use delay_minutes from SLW.calculate() result,
    // NOT the legacy getDelayInfo() or segments[0] Darwin lookup.
    const service = buildServiceWithSLW(mocks);

    // SLW reports 20-minute delay at KGX (final destination)
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 20,
      actual_final_arrival: `${TRAVEL_DATE}T10:50:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: 0, // leg-1 was ON TIME — must NOT be used as the result
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    const input = makeEvaluationInput(JOURNEY_MULTI, makeTwoLegSegments());
    const result = await service.evaluate(input);

    // FAILS TODAY: evaluate() would use segments[0] delay (0 min) → on_time
    // After fix: SLW delay_minutes=20 >= 15 threshold → delayed
    expect(result.outcome).toBe('delayed');
    expect((result as { delay_minutes: number }).delay_minutes).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: Single-leg parity — N=1 terminal outcomes UNCHANGED
// These are PARITY tests via the new SLW path. They will be RED until Blake
// wires SLW and the SLW single-leg path returns the same results as the old code.
// The EXISTING single-leg tests (in other files) must stay GREEN now.
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-337 AC-2: Single-leg parity — N=1 outcomes unchanged across all terminals', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    vi.clearAllMocks();
  });

  it('AC-2 [delayed]: single-leg journey with 30-min delay → outcome=delayed, delay_minutes=30', async () => {
    // AC-2: Single-leg journey where SLW reports 30 min delay.
    // Must produce the same terminal as the legacy segments[0] path.
    // FAILS TODAY: SLW is not called; if it were, evaluate() doesn't use its result.
    const service = buildServiceWithSLW(mocks);

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 30,
      actual_final_arrival: `${TRAVEL_DATE}T11:00:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207108175',
      delay_minutes: 30,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [],
    });

    const input = makeEvaluationInput(JOURNEY_SINGLE, makeSingleSegment());
    const result = await service.evaluate(input);

    expect(result.outcome).toBe('delayed');
    expect((result as { delay_minutes: number }).delay_minutes).toBe(30);
    expect((result as { cancelled: boolean }).cancelled).toBe(false);
  });

  it('AC-2 [on_time / 0 delay]: single-leg journey with 0-min delay → outcome=on_time', async () => {
    // AC-2: The deployed £74.67/£149.35 eligible path depends on accurate on_time detection.
    // SLW reports 0 min → on_time terminal must be preserved.
    // FAILS TODAY: SLW is not called or its result is ignored.
    const service = buildServiceWithSLW(mocks);

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 0,
      actual_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207108175',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    const input = makeEvaluationInput(JOURNEY_SINGLE, makeSingleSegment());
    const result = await service.evaluate(input);

    expect(result.outcome).toBe('on_time');
    expect((result as { delay_minutes: number }).delay_minutes).toBe(0);
  });

  it('AC-2 [no_data / Darwin unavailable]: SLW returns assessment_pending → outcome=no_data', async () => {
    // AC-2: When Darwin has no data (getServiceWithStops throws OR SLW returns assessment_pending),
    // outcome must be no_data. This terminal is unchanged from today.
    // FAILS TODAY: SLW not called; but the Darwin-unavailable path still fires via getServiceWithStops throw.
    // After fix: the SLW assessment_pending path must also produce no_data.
    const service = buildServiceWithSLW(mocks);

    // Scenario: Darwin availability check passes but SLW cannot get stop data
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207108175',
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'assessment_pending', // Darwin had no stop data for this leg
    });

    const input = makeEvaluationInput(JOURNEY_SINGLE, makeSingleSegment());
    const result = await service.evaluate(input);

    // FAILS TODAY: evaluate() doesn't call SLW; assessment_pending path doesn't exist
    expect(result.outcome).toBe('no_data');
  });

  it('AC-2 [no_data / Darwin throws]: getServiceWithStops throws → outcome=no_data (unchanged)', async () => {
    // AC-2: Darwin availability pre-check still fires on segments[0].rid.
    // If getServiceWithStops throws, evaluate() MUST still return no_data immediately
    // (without calling SLW). This path is UNCHANGED from today — parity guard.
    const service = buildServiceWithSLW(mocks);

    mocks.mockDarwinClient.getServiceWithStops.mockRejectedValue(
      new Error('darwin-ingestor: 503 Service Unavailable'),
    );

    const input = makeEvaluationInput(JOURNEY_SINGLE, makeSingleSegment());
    const result = await service.evaluate(input);

    // TODAY: this already passes (no_data from getServiceWithStops throw).
    // AFTER FIX: must still pass — the Darwin throw guard is preserved.
    expect(result.outcome).toBe('no_data');
    // SLW must NOT be called when Darwin pre-check fails (no point walking legs)
    expect(mocks.mockSequentialLegWalk.calculate).not.toHaveBeenCalled();
  });

  it('AC-2 [cancelled]: single-leg cancellation → outcome=delayed, cancelled=true', async () => {
    // AC-2: Cancellation is a special delayed terminal. Parity guard for the deployed
    // £74.67 eligible flow where some services are cancelled.
    // After fix: SLW returns needs_manual_review for a cancelled-only service with stub OTP.
    // Blake must handle: SLW needs_manual_review → no_data OR SLW returns delay=0 for cancelled legs.
    // The MINIMUM correctness: a true cancellation must NOT silently return on_time (delay=0).
    const service = buildServiceWithSLW(mocks);

    // Darwin pre-check: service is cancelled
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207108175',
      delay_minutes: null,
      is_cancelled: true,
      delay_reasons: [{ reason: 'operational' }],
      status: 'cancelled',
      stops: null,
    });

    // SLW with stub OTP (returns null) will hit handleCancelledOrMissed → needs_manual_review
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'needs_manual_review', // stub OTP returned null — no replacement found
    });

    const input = makeEvaluationInput(JOURNEY_SINGLE, makeSingleSegment());
    const result = await service.evaluate(input);

    // After fix: needs_manual_review (null delay) → no_data (defensible terminal per AC-4)
    // MUST NOT return on_time — a cancelled service is not on_time.
    expect(result.outcome).not.toBe('on_time');
    // Acceptable terminals: no_data OR delayed/cancelled
    expect(['no_data', 'delayed']).toContain(result.outcome);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: DISPOSITIVE — leg-1 on-time, leg-2 delayed → evaluate() reports leg-2 delay
// This is the single most important test for BL-337. It encodes the exact bug.
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-337 AC-3 (DISPOSITIVE): leg-1 on-time (0 delay) but leg-2 delayed (30 min) → evaluate() must report ~30 min', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    vi.clearAllMocks();
  });

  it('AC-3: DISPOSITIVE — 2-leg York→Leeds→KGX: leg-1 on time, leg-2 30-min delayed → result=delayed(30)', async () => {
    /**
     * AC-3: THE BUG. This test encodes it exactly.
     *
     * Journey: York → Leeds (leg 1, on time) → Kings Cross (leg 2, 30 min late)
     *   Leg 1 RID: 202606207201000  — TransPennine, arrives Leeds on schedule
     *   Leg 2 RID: 202606207202000  — LNER, arrives KGX 30 minutes late
     *
     * TODAY (BROKEN): evaluate() uses segments[0] only → leg-1 delay = 0 → outcome=on_time
     * AFTER FIX:      SLW walks both legs → final destination KGX = 30 min late → outcome=delayed(30)
     *
     * FAILS TODAY: evaluate() returns on_time (0 delay from leg-1), not delayed(30).
     */
    const service = buildServiceWithSLW(mocks);
    const segments = makeTwoLegSegments();

    // Darwin pre-check on segments[0].rid (leg-1) — passes (service exists, not cancelled)
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0, // leg-1 is on time — this is the value the OLD code would use
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: LEEDS_TIPLOC,
          scheduled_arrival: `${TRAVEL_DATE}T08:30:00.000Z`,
          actual_arrival: `${TRAVEL_DATE}T08:30:00.000Z`,
          delay_minutes: 0,
        },
      ],
    });

    // SLW walks both legs: leg-1 on time at Leeds, leg-2 arrives KGX 30 min late
    // delay_minutes at KGX = 30 (the correct final-destination delay per ADR-021)
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 30,
      actual_final_arrival: `${TRAVEL_DATE}T11:00:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    const input = makeEvaluationInput(JOURNEY_DISP, segments);
    const result = await service.evaluate(input);

    // FAILS TODAY: returns { outcome: 'on_time', delay_minutes: 0 } because evaluate()
    // only queries leg-1 (segments[0]) which was on time.
    // AFTER FIX: SLW reports 30 min at KGX → delayed
    expect(result.outcome).toBe('delayed');
    expect((result as { delay_minutes: number }).delay_minutes).toBe(30);
    expect((result as { cancelled: boolean }).cancelled).toBe(false);
  });

  it('AC-3: confirms SLW was called (not the legacy segments[0] path) in the dispositive scenario', async () => {
    // AC-3: Additional assertion — SLW.calculate() MUST have been invoked.
    // If it wasn't called, the fix isn't wired.
    const service = buildServiceWithSLW(mocks);
    const segments = makeTwoLegSegments();

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 30,
      actual_final_arrival: `${TRAVEL_DATE}T11:00:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    const input = makeEvaluationInput(JOURNEY_DISP, segments);
    await service.evaluate(input);

    // FAILS TODAY: SLW is never instantiated in evaluate(); this will be 0 calls
    expect(mocks.mockSequentialLegWalk.calculate).toHaveBeenCalledTimes(1);
  });

  it('AC-3: result must NOT be on_time when leg-1 delay=0 but leg-2 delay=30 (regression guard)', async () => {
    // AC-3: Explicit regression guard — the exact bug case must not produce on_time.
    // TODAY: evaluate() → segments[0].delay = 0 → on_time (WRONG)
    // AFTER FIX: SLW → delay_minutes=30 → delayed (CORRECT)
    const service = buildServiceWithSLW(mocks);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 30,
      actual_final_arrival: `${TRAVEL_DATE}T11:00:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    const input = makeEvaluationInput(JOURNEY_DISP, makeTwoLegSegments());
    const result = await service.evaluate(input);

    // The bug: old code returns on_time. After fix: must be delayed.
    expect(result.outcome).not.toBe('on_time');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Stub OtpClient (returns null) — graceful degradation, no crash, no fabricated zero
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-337 AC-4: Stub OtpClient (null) — graceful degradation on missed-connection/cancellation', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    vi.clearAllMocks();
  });

  it('AC-4: should NOT throw when SLW returns needs_manual_review (stub OTP returned null)', async () => {
    // AC-4: With the stub OtpClient, a cancelled leg or missed connection triggers
    // handleCancelledOrMissed → OTP returns null → needs_manual_review.
    // evaluate() MUST NOT crash on this result.
    const service = buildServiceWithSLW(mocks);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: null,
      is_cancelled: true, // leg is cancelled
      delay_reasons: [{ reason: 'operational' }],
      status: 'cancelled',
      stops: null,
    });

    // SLW: stub OTP returned null → needs_manual_review
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'needs_manual_review',
    });

    const input = makeEvaluationInput(JOURNEY_STUB, makeTwoLegSegments());

    // MUST NOT throw
    await expect(service.evaluate(input)).resolves.not.toThrow();
  });

  it('AC-4: should return no_data (not on_time/0) when SLW returns needs_manual_review with null delay', async () => {
    // AC-4: needs_manual_review + null delay MUST NOT produce on_time (delay_minutes=0).
    // Reporting 0 minutes delay for a cancelled service would fraudulently deny eligibility.
    // Correct defensible terminal: no_data.
    const service = buildServiceWithSLW(mocks);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    // SLW: missed connection, stub OTP null → needs_manual_review, delay=null
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'needs_manual_review',
    });

    const input = makeEvaluationInput(JOURNEY_STUB, makeTwoLegSegments());
    const result = await service.evaluate(input);

    // Must NOT fabricate a zero delay (would silently deny eligibility)
    expect(result.outcome).not.toBe('on_time');
    // Correct: defensible no_data terminal
    expect(result.outcome).toBe('no_data');
  });

  it('AC-4: should return no_data when SLW returns assessment_pending (Darwin had no stop data)', async () => {
    // AC-4: assessment_pending means Darwin returned no usable stop data.
    // This maps to no_data — "we looked, we couldn't determine the delay".
    // Must NOT be confused with on_time (delay=0).
    const service = buildServiceWithSLW(mocks);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'assessment_pending', // Darwin had no stop data for this leg
    });

    const input = makeEvaluationInput(JOURNEY_STUB, makeTwoLegSegments());
    const result = await service.evaluate(input);

    expect(result.outcome).toBe('no_data');
  });

  it('AC-4: should NOT fabricate a zero delay (no false on_time) when delay data is absent', async () => {
    // AC-4: Anti-fraud guard. If SLW returns null delay_minutes for ANY reason,
    // evaluate() must NEVER coerce null → 0 and return on_time.
    // A false on_time would deny a legitimate claim.
    const service = buildServiceWithSLW(mocks);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: '202606207201000',
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null, // null — no data
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'assessment_pending',
    });

    const input = makeEvaluationInput(JOURNEY_STUB, makeTwoLegSegments());
    const result = await service.evaluate(input);

    // No fabricated zero
    expect(result.outcome).not.toBe('on_time');
    // No fabricated delay
    if (result.outcome !== 'no_data') {
      expect((result as { delay_minutes: number }).delay_minutes).not.toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: POST /delays/ensure with multi-leg segments → correct final-destination verdict
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-337 AC-5: POST /delays/ensure with multi-leg journey_id returns final-destination delay', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    vi.clearAllMocks();
  });

  it('AC-5: should return delayed verdict when multi-leg journey has a delayed final leg (ensure endpoint)', async () => {
    /**
     * AC-5: Mirrors the real ensure path (ADR-031 Option f).
     * BFF sends journey_id + user_id (no segments). Handler loads segments from DB.
     * evaluate() walks both legs via SLW and returns the final-destination delay.
     *
     * FAILS TODAY: evaluate() uses segments[0] only → returns on_time (leg-1 delay=0).
     */
    const segments = makeTwoLegSegments();

    // Mock: DB returns 2 segments for this journey (BFF didn't send them)
    mocks.mockJourneyRepo.findSegmentsByJourneyId.mockResolvedValue(segments);

    // Darwin pre-check: passes for leg-1 (on time)
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0, // leg-1 is on time — old code would call this the result
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });

    // SLW walks both legs: leg-2 arrives KGX 25 min late
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 25,
      actual_final_arrival: `${TRAVEL_DATE}T10:55:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    const app = buildEnsureApp(mocks);

    const res = await request(app)
      .post('/delays/ensure')
      .send({
        journey_id: JOURNEY_ENSURE,
        user_id: USER_A,
        // Intentionally no segments — handler loads them from DB (BFF contract)
      });

    expect(res.status).toBe(200);
    // FAILS TODAY: status would be 'on_time' (leg-1 delay=0) or 'no_data' (empty body segments)
    // AFTER FIX: SLW reports 25 min → delayed
    expect(res.body.status).toBe('delayed');
    expect(res.body.delay_minutes).toBe(25);
  });

  it('AC-5: should NOT return on_time when the final leg (not first leg) carries the qualifying delay', async () => {
    // AC-5: Regression guard. The exact bug at the ensure-endpoint boundary.
    // leg-1 delay = 0, leg-2 delay = 25 → old code returns on_time, correct code returns delayed.
    const segments = makeTwoLegSegments();

    mocks.mockJourneyRepo.findSegmentsByJourneyId.mockResolvedValue(segments);
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 25,
      actual_final_arrival: `${TRAVEL_DATE}T10:55:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    const app = buildEnsureApp(mocks);

    const res = await request(app)
      .post('/delays/ensure')
      .send({ journey_id: JOURNEY_ENSURE, user_id: USER_A });

    expect(res.status).toBe(200);
    // Must NOT be on_time — the final leg had a qualifying 25-min delay
    expect(res.body.status).not.toBe('on_time');
  });

  it('AC-5: should call sequentialLegWalk.calculate() via the ensure endpoint path', async () => {
    // AC-5: End-to-end wiring assertion — SLW must be invoked through the HTTP handler.
    const segments = makeTwoLegSegments();

    mocks.mockJourneyRepo.findSegmentsByJourneyId.mockResolvedValue(segments);
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: 25,
      actual_final_arrival: `${TRAVEL_DATE}T10:55:00.000Z`,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'completed',
    });

    const app = buildEnsureApp(mocks);

    await request(app)
      .post('/delays/ensure')
      .send({ journey_id: JOURNEY_ENSURE, user_id: USER_A });

    // SLW MUST have been called via the ensure handler → evaluate() chain
    expect(mocks.mockSequentialLegWalk.calculate).toHaveBeenCalledTimes(1);
  });

  it('AC-5: no_data returned when SLW assessment_pending (Darwin unavailable via ensure path)', async () => {
    // AC-5: Ensure endpoint correctly propagates no_data when SLW cannot assess.
    // This is the same no_data terminal as the existing ensure tests — regression guard.
    const segments = makeTwoLegSegments();

    mocks.mockJourneyRepo.findSegmentsByJourneyId.mockResolvedValue(segments);
    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: segments[0].rid,
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    });
    mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: `${TRAVEL_DATE}T10:30:00.000Z`,
      status: 'assessment_pending',
    });

    const app = buildEnsureApp(mocks);

    const res = await request(app)
      .post('/delays/ensure')
      .send({ journey_id: JOURNEY_ENSURE, user_id: USER_A });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('no_data');
  });
});
