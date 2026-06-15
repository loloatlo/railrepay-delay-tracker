/**
 * RED Tests: BL-338 / TD-OTP-REPLACEMENT-001
 * Real OtpClient + SLW on-time-through fix
 *
 * Phase   : TD-1 (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-338
 * TD ID   : TD-OTP-REPLACEMENT-001
 * ADR     : ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 * Date    : 2026-06-15
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * ─── WHAT THIS SPEC COVERS ────────────────────────────────────────────────────
 * Two changes required TOGETHER to make a genuine multi-leg journey evaluate ELIGIBLE:
 *
 * Change 1 — SLW on-time-through (sequential-leg-walk.ts:~182-190):
 *   Split the `if (!destinationStop || destinationStop.actual_arrival === null)` branch.
 *   NON-FINAL leg, destination stop ABSENT from Darwin, Darwin status NOT no_data AND
 *   NOT cancelled → treat as on-time-through (delay 0, continue to next leg).
 *   AC-3 ANTI-FRAUD (IMMUTABLE): FINAL leg, destination ABSENT → STILL no_data.
 *   Never fabricate a 0-delay for the final leg.
 *
 * Change 2 — Real OtpClient (index.ts + event-consumer.ts):
 *   Replace stub OtpClient (returns null) with a real otp-router GraphQL client.
 *   Adapts journey-matcher/src/services/otp-client.ts pattern.
 *   Interface: OtpClient.findReplacementRoute({fromCrs,toCrs,departAfter}) → OtpLeg[]|null
 *   Maps trip.gtfsId ("1:RID") → OtpLeg.rid (strip "1:").
 *   Injected via env OTP_ROUTER_URL.
 *
 * ─── NOT→PLY CORRECTED FIXTURE (Blake-verified) ───────────────────────────────
 *   seg 1: { rid:'202606136721613', NOT→DBY,
 *            scheduled_departure:'2026-06-13T17:17:00Z',
 *            scheduled_arrival:'2026-06-13T17:46:00Z' }
 *          Darwin has NO Derby stop for this RID (coverage gap; service ran, not cancelled).
 *   seg 2: { rid:'202606137101164', DBY→PLY,
 *            scheduled_departure:'2026-06-13T19:09:00Z',
 *            scheduled_arrival:'2026-06-13T22:48:00Z' }
 *          Darwin PLYMTH stop = actual 23:44, delay 56 min.
 *   scheduledFinalArrival='2026-06-13T22:48:00Z'
 *   Expected SLW output: { status:'completed', delay_minutes:56 } → ELIGIBLE.
 *
 * ─── AC COVERAGE MAP ──────────────────────────────────────────────────────────
 * AC-1 : Real OtpClient — interface-based unit tests: CRS→plan HTTP mock, mapping, gtfsId strip, null/error
 * AC-2 : SLW on-time-through — non-final leg, destination absent, service ran → on-time-through + no OTP call
 * AC-3 : ANTI-FRAUD (IMMUTABLE) — final leg, destination absent → no_data (never fabricate 0)
 * AC-4 : NOT→PLY end-to-end through evaluate() → ELIGIBLE, delay_minutes 56
 * AC-5 : Genuine cancelled/missed still routes to real OTP (regression: OTP IS called)
 * AC-6 : Single-leg regression unchanged (LNER £74.67 style path still correct)
 * AC-7 : Un-quarantine 6 BL-181 OTP-branch tests — they are now RED for the right reason
 *         (the 6 tests in BL-181-sequential-leg-walk.test.ts AC-11/12/14 cancelled+replacement
 *          that fail today because stub returns null should be GREEN after Blake's change,
 *          so they are NOT re-written here — AC-7 is verified by the 6 pre-existing failing
 *          tests BECOMING GREEN when Blake implements. The file header for those tests
 *          already has the correct intent; no skip/quarantine markers to remove there.)
 *         NOTE: Those 6 tests already lack skip/quarantine. The AC-7 obligation here is
 *         to leave NO new it.skip/quarantine markers in THIS file and to confirm no
 *         skip exists in the BL-181 files (verified: zero skip/quarantine found).
 * AC-8 : Never fabricate 0 — null delay_minutes → no_data across ALL paths
 * SOP-011: At least one test feeds RAW OTP response strings at gtfsId/CRS boundary
 *
 * ─── CROSS-SERVICE SMOKE NOTE (SOP-IMPROVEMENT-009) ──────────────────────────
 * A live delay-tracker → otp-router cross-service smoke test is required at TD-3/TD-4
 * gate (real POST to otp-router GraphQL endpoint, verify OtpLeg[] returned with
 * real RIDs). That is NOT a unit test and is NOT included here. Blake gates TD-3 on it.
 *
 * ─── MOCK PATTERN (project memory) ───────────────────────────────────────────
 * vi.clearAllMocks() does NOT clear mockResolvedValueOnce queues.
 * Reset with individual .mockReset() + re-establish permanent .mockResolvedValue().
 * Do NOT use vi.resetAllMocks() globally (broke factory mocks before).
 *
 * ─── IMPORTS (may reference modules that DO NOT EXIST YET) ────────────────────
 * src/clients/otp-router.ts — new file Blake creates (AC-1 impl)
 * The import uses @ts-expect-error where the module is new; existing modules import cleanly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Existing module — must import cleanly (no ts-expect-error)
import {
  SequentialLegWalk,
  type JourneyLeg,
  type DarwinServiceWithStops,
  type OtpClient,
  type OtpLeg,
} from '../../../src/services/sequential-leg-walk.js';

import {
  DelayEvaluationService,
  type EvaluationInput,
  type EvaluationSegment,
} from '../../../src/services/delay-evaluation.service.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function ts(date: string, time: string): string {
  return `${date}T${time}:00Z`;
}

// ─── NOT→PLY corrected fixture constants (Blake-verified against timetable) ──

const NOT_PLY_DATE = '2026-06-13';

/** Seg 1: NOT→DBY. Darwin has NO Derby stop for this RID (coverage gap; service ran). */
const SEG1_NOT_DBY: EvaluationSegment = {
  segment_order: 0,
  origin_crs: 'NOT',
  destination_crs: 'DBY',
  scheduled_departure: '2026-06-13T17:17:00Z',
  scheduled_arrival: '2026-06-13T17:46:00Z',
  rid: '202606136721613',
  toc_code: 'EM',
};

/** Seg 2: DBY→PLY. Darwin PLYMTH stop = actual 23:44, delay 56 min. */
const SEG2_DBY_PLY: EvaluationSegment = {
  segment_order: 1,
  origin_crs: 'DBY',
  destination_crs: 'PLY',
  scheduled_departure: '2026-06-13T19:09:00Z',
  scheduled_arrival: '2026-06-13T22:48:00Z',
  rid: '202606137101164',
  toc_code: 'GW',
};

const NOT_PLY_SCHEDULED_FINAL_ARRIVAL = '2026-06-13T22:48:00Z';

/** Darwin response for seg 1 (202606136721613): service ran (status:'delayed'/on-time), NO Derby stop. */
const DARWIN_SEG1_NO_DERBY_STOP: DarwinServiceWithStops = {
  rid: '202606136721613',
  delay_minutes: null,
  is_cancelled: false,
  delay_reasons: null,
  status: 'delayed', // service ran — not no_data, not cancelled
  stops: [
    // Derby (DBY) is completely absent from this list (coverage gap)
    {
      tiploc_code: 'NTNBSH', // Nottingham — origin stop, present
      scheduled_arrival: null,
      actual_arrival: null,
      delay_minutes: 0,
    },
    {
      tiploc_code: 'BEESTON', // An intermediate stop, NOT Derby
      scheduled_arrival: '2026-06-13T17:28:00Z',
      actual_arrival: '2026-06-13T17:30:00Z',
      delay_minutes: 2,
    },
    // DBY/DRBY tiploc is intentionally absent to simulate coverage gap
  ],
};

/** Darwin response for seg 2 (202606137101164): Plymouth delayed 56 min. */
const DARWIN_SEG2_PLY_DELAYED: DarwinServiceWithStops = {
  rid: '202606137101164',
  delay_minutes: 56,
  is_cancelled: false,
  delay_reasons: [{ code: '576', description: 'Track problem' }],
  status: 'delayed',
  stops: [
    {
      tiploc_code: 'DRBY',   // Derby — origin of this leg (present, departure)
      scheduled_arrival: null,
      actual_arrival: null,
      delay_minutes: 0,
    },
    {
      tiploc_code: 'PLYMTH', // Plymouth — final destination
      scheduled_arrival: '2026-06-13T22:48:00Z',
      actual_arrival: '2026-06-13T23:44:00Z', // 56 min late
      delay_minutes: 56,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1: OtpRouterClient tests are in a SEPARATE file:
//   BL-338-AC1-otp-router-client.test.ts
// Reason: AC-1 imports src/clients/otp-router.ts which does not exist yet.
// Vitest module-load errors kill the entire test file; AC-1 must be isolated
// so AC-2 through AC-8 can load, run, and FAIL for behavioral reasons (RED).
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-1 PLACEHOLDER: OtpRouterClient — see BL-338-AC1-otp-router-client.test.ts', () => {
  /**
   * AC-1 tests are in BL-338-AC1-otp-router-client.test.ts which imports
   * src/clients/otp-router.ts — a file that does not exist yet (TDD RED).
   * That file will fail with module-load-error (the correct RED for AC-1).
   * Tests here (AC-2 through AC-8) test SLW + evaluate() which already exist,
   * and fail for behavioral reasons: the on-time-through branch is not implemented.
   */

  it('AC-1 tests are isolated in BL-338-AC1-otp-router-client.test.ts (module-load RED)', () => {
    // This placeholder test passes to confirm the file loaded correctly.
    // The real AC-1 tests are in the companion file which fails with:
    //   "Failed to load url ../../../src/clients/otp-router.js. Does the file exist?"
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2: SLW on-time-through
// Non-final leg, destination stop ABSENT from Darwin, service ran (not no_data,
// not cancelled) → treat as on-time-through (delay 0), continue to next leg.
// OTP must NOT be called for this leg.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-2: SLW on-time-through — non-final leg, destination absent, service ran', () => {
  /**
   * Scenario: NOT→DBY (leg 1, non-final) — Darwin has NO Derby stop.
   * Darwin status: 'delayed' (service ran — not cancelled, not no_data).
   * Current bug: SLW routes to handleCancelledOrMissed() → calls OTP → stub returns null
   *              → needs_manual_review → evaluate() returns no_data.
   * Fix required: detect "absent stop + service ran + NOT final leg" → on-time-through.
   * After fix: SLW skips the absent stop as delay=0, continues to leg 2 (DBY→PLY).
   *
   * Differentiating data:
   *   - NOT final leg (isLastLeg=false)
   *   - Darwin status='delayed' (service ran)
   *   - Destination (DBY) ABSENT from stops array
   */

  let mockDarwinClient: { getServiceWithStops: ReturnType<typeof vi.fn> };
  let mockTiplocRepo: { getCrsByTiploc: ReturnType<typeof vi.fn>; getTiplocsByCrs: ReturnType<typeof vi.fn> };
  let mockOtpClient: { findReplacementRoute: ReturnType<typeof vi.fn> };
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = { getServiceWithStops: vi.fn() };
    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn(),
    };
    mockOtpClient = { findReplacementRoute: vi.fn() };
  });

  it('AC-2a: should NOT call OTP when non-final leg destination is absent but service ran', async () => {
    // Leg 1 (NOT→DBY, non-final): Darwin has no Derby stop, service ran
    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(DARWIN_SEG1_NO_DERBY_STOP);
    // Leg 2 (DBY→PLY, final): Plymouth delayed 56 min
    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(DARWIN_SEG2_PLY_DELAYED);

    // DRBY tiploc for DBY lookup — no match found in stop list (the point of the test)
    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'DBY') return ['DRBY'];    // DBY resolves to DRBY (absent from seg1 stops)
      if (crs === 'PLY') return ['PLYMTH'];  // PLY resolves to PLYMTH (present in seg2 stops)
      return [];
    });

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const legs: JourneyLeg[] = [
      {
        rid: SEG1_NOT_DBY.rid,
        originCrs: 'NOT',
        destinationCrs: 'DBY',
        scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
        scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
        connectionThresholdMinutes: null, // no explicit threshold between legs
      },
      {
        rid: SEG2_DBY_PLY.rid,
        originCrs: 'DBY',
        destinationCrs: 'PLY',
        scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
        scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
        connectionThresholdMinutes: null, // final leg
      },
    ];

    await walk.calculate({
      legs,
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // KEY ASSERTION: OTP must NOT be called for the on-time-through leg
    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
  });

  it('AC-2b: should treat absent non-final leg destination as on-time-through (delay=0) and continue to leg 2', async () => {
    // After on-time-through fix: leg 2 is evaluated and its delay is 56 min
    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(DARWIN_SEG1_NO_DERBY_STOP);
    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(DARWIN_SEG2_PLY_DELAYED);

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'DBY') return ['DRBY'];
      if (crs === 'PLY') return ['PLYMTH'];
      return [];
    });

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const legs: JourneyLeg[] = [
      {
        rid: SEG1_NOT_DBY.rid,
        originCrs: 'NOT',
        destinationCrs: 'DBY',
        scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
        scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
        connectionThresholdMinutes: null,
      },
      {
        rid: SEG2_DBY_PLY.rid,
        originCrs: 'DBY',
        destinationCrs: 'PLY',
        scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
        scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
        connectionThresholdMinutes: null,
      },
    ];

    const result = await walk.calculate({
      legs,
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // After the on-time-through fix, SLW proceeds to leg 2 and reports the REAL final delay
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(56);
    // BOTH Darwin clients were called (leg 1 AND leg 2)
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(2);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(1, SEG1_NOT_DBY.rid);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(2, SEG2_DBY_PLY.rid);
  });

  it('AC-2c: on-time-through does NOT apply when Darwin status is no_data (service unknown) — must return assessment_pending', async () => {
    // When Darwin returns no_data for a NON-FINAL leg, it is genuinely unknown.
    // This must NOT be treated as on-time-through — status must be assessment_pending.
    const darwinNoData: DarwinServiceWithStops = {
      rid: SEG1_NOT_DBY.rid,
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'no_data', // <-- key: no_data is different from delayed/on_time with absent stop
      stops: null,
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(darwinNoData);
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['DRBY']);

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_NOT_DBY.rid,
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_DBY_PLY.rid,
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
          scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // no_data status must NOT be treated as on-time-through
    expect(result.status).toBe('assessment_pending');
    expect(result.delay_minutes).toBeNull();
    // Leg 2 must NOT have been evaluated (walk exits early on no_data)
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(1);
  });

  it('AC-2d: on-time-through does NOT apply when Darwin reports is_cancelled=true — must call OTP', async () => {
    // Cancelled service: OTP IS called (this is the genuine cancelled/missed path)
    const darwinCancelled: DarwinServiceWithStops = {
      rid: SEG1_NOT_DBY.rid,
      delay_minutes: null,
      is_cancelled: true, // <-- genuine cancellation: OTP must be called
      delay_reasons: null,
      status: 'cancelled',
      stops: null,
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(darwinCancelled);
    // OTP returns null (stub not yet wired; will return null until real OTP is wired)
    mockOtpClient.findReplacementRoute.mockResolvedValueOnce(null);
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['DRBY']);

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    await walk.calculate({
      legs: [
        {
          rid: SEG1_NOT_DBY.rid,
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_DBY_PLY.rid,
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
          scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // OTP MUST be called when is_cancelled=true (genuine cancellation — on-time-through does not apply)
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCrs: 'NOT',
        toCrs: 'PLY',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-3: ANTI-FRAUD guard (IMMUTABLE)
// FINAL leg, destination stop ABSENT → must return no_data.
// Never fabricate a 0-delay for the final leg.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-3: ANTI-FRAUD — final leg absent destination must NOT be on-time-through', () => {
  /**
   * IMMUTABLE constraint: on-time-through applies ONLY to non-final legs.
   * If the FINAL leg's destination stop is absent from Darwin, the delay
   * is genuinely unknown. Must return assessment_pending / needs_manual_review —
   * NEVER delay_minutes=0.
   *
   * This is the dispositive anti-fraud guard. If Blake accidentally applies
   * on-time-through to the final leg, a passenger who never reached their
   * destination would show as 0-delay, blocking a legitimate claim.
   *
   * Differentiating data:
   *   - Single-leg journey (isLastLeg=true for the only leg)
   *   - Darwin status='delayed' (service ran)
   *   - Destination ABSENT from stops array
   */

  let mockDarwinClient: { getServiceWithStops: ReturnType<typeof vi.fn> };
  let mockTiplocRepo: { getCrsByTiploc: ReturnType<typeof vi.fn>; getTiplocsByCrs: ReturnType<typeof vi.fn> };
  let mockOtpClient: { findReplacementRoute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDarwinClient = { getServiceWithStops: vi.fn() };
    mockTiplocRepo = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn() };
    mockOtpClient = { findReplacementRoute: vi.fn() };
  });

  it('AC-3a: single-leg journey, final destination absent from Darwin, service ran — must NOT return delay_minutes:0', async () => {
    // Single leg (final leg): destination absent, service ran
    const darwinFinalLegMissingDest: DarwinServiceWithStops = {
      rid: '202606137101164', // DBY→PLY
      delay_minutes: 5, // service has some delay but PLY stop is absent
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed', // service ran
      stops: [
        {
          tiploc_code: 'DRBY', // Derby — origin only
          scheduled_arrival: null,
          actual_arrival: null,
          delay_minutes: 0,
        },
        // PLY/PLYMTH is intentionally ABSENT (this is the final leg scenario)
      ],
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(darwinFinalLegMissingDest);
    // PLYMTH not found (empty array) — simulates absent final stop
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['PLYMTH']);
    // OTP returns null (stub; real OTP path tested in AC-5)
    mockOtpClient.findReplacementRoute.mockResolvedValueOnce(null);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: '202606137101164',
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: '2026-06-13T19:09:00Z',
          scheduledArrival: '2026-06-13T22:48:00Z',
          connectionThresholdMinutes: null, // FINAL leg
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: '2026-06-13T22:48:00Z',
    });

    // CRITICAL: must NOT be 0 — absent final stop means unknown delay
    expect(result.delay_minutes).not.toBe(0);
    // Must be null (unknown/not assessable)
    expect(result.delay_minutes).toBeNull();
    // Status must reflect inability to assess — either assessment_pending or needs_manual_review
    expect(['assessment_pending', 'needs_manual_review']).toContain(result.status);
  });

  it('AC-3b: two-leg journey, final leg (leg 2) destination absent — delay_minutes must be null, not 0', async () => {
    // Leg 1: on time, connection made
    const darwinLeg1OnTime: DarwinServiceWithStops = {
      rid: '202606136721613',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'DRBY', // DBY — leg 1 destination present
          scheduled_arrival: '2026-06-13T17:46:00Z',
          actual_arrival: '2026-06-13T17:46:00Z',
          delay_minutes: 0,
        },
      ],
    };

    // Leg 2: FINAL leg — PLY stop is absent, service ran
    const darwinLeg2FinalMissingPLY: DarwinServiceWithStops = {
      rid: '202606137101164',
      delay_minutes: 30, // service has delay but PLY stop absent
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'EXETERSTD', // intermediate stop — not PLY
          scheduled_arrival: '2026-06-13T21:00:00Z',
          actual_arrival: '2026-06-13T21:30:00Z',
          delay_minutes: 30,
        },
        // PLYMTH intentionally absent from final leg stops
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(darwinLeg1OnTime)    // leg 1
      .mockResolvedValueOnce(darwinLeg2FinalMissingPLY); // leg 2 (final, missing PLY)

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'DBY') return ['DRBY'];   // leg 1 destination — present
      if (crs === 'PLY') return ['PLYMTH']; // final destination — absent from leg2 stops
      return [];
    });

    mockOtpClient.findReplacementRoute.mockResolvedValueOnce(null);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_NOT_DBY.rid,
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_DBY_PLY.rid,
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
          scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
          connectionThresholdMinutes: null, // FINAL leg
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // AC-3 ANTI-FRAUD: final leg missing destination → delay must be null
    expect(result.delay_minutes).toBeNull();
    expect(result.delay_minutes).not.toBe(0); // Explicitly not fabricated 0
    expect(['assessment_pending', 'needs_manual_review']).toContain(result.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-4: NOT→PLY end-to-end through DelayEvaluationService.evaluate()
// Corrected 2-segment fixture — expected: ELIGIBLE, delay_minutes 56
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-4: NOT→PLY end-to-end → ELIGIBLE delay_minutes 56', () => {
  /**
   * The FULL pipeline: EvaluationInput → evaluate() → SLW → Darwin mocks → EvaluationOutcome.
   * On-time-through fix for seg 1 (NOT→DBY, absent Derby stop, service ran).
   * Seg 2 (DBY→PLY): Plymouth delayed 56 min.
   * Expected: outcome='delayed', delay_minutes=56.
   *
   * Mock fare: 7467p (£74.67) — mock DR band to prove ELIGIBLE.
   */

  function buildMocks() {
    const mockJourneyRepo = {
      findByJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'mj-bl338-not-ply-001' }),
      findSegmentsByJourneyId: vi.fn().mockResolvedValue([SEG1_NOT_DBY, SEG2_DBY_PLY]),
    };

    const mockDelayAlertRepo = {
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'alert-bl338-001' }),
    };

    const mockOutboxRepo = {
      create: vi.fn().mockResolvedValue(undefined),
    };

    const mockDarwinClient = {
      getDelayInfo: vi.fn(),
      // Pre-check on seg1.rid (segments[0]) — must succeed
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(DARWIN_SEG1_NO_DERBY_STOP) // pre-check for seg1
        // SLW will then call getServiceWithStops for each leg:
        .mockResolvedValueOnce(DARWIN_SEG1_NO_DERBY_STOP) // SLW leg 1
        .mockResolvedValueOnce(DARWIN_SEG2_PLY_DELAYED),  // SLW leg 2
    };

    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'DBY') return ['DRBY'];
        if (crs === 'PLY') return ['PLYMTH'];
        return [];
      }),
    };

    const mockOtpClient: OtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue(null),
    };

    const slw = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient as any,
      otpClient: mockOtpClient,
    });

    const svc = new DelayEvaluationService({
      journeyRepository: mockJourneyRepo as any,
      delayAlertRepository: mockDelayAlertRepo as any,
      outboxRepository: mockOutboxRepo as any,
      darwinClient: mockDarwinClient as any,
      sequentialLegWalk: slw as any,
    });

    return { svc, mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockOtpClient };
  }

  it('AC-4a: evaluate() returns outcome:delayed, delay_minutes:56 for NOT→PLY 2-seg journey', async () => {
    const { svc } = buildMocks();

    const input: EvaluationInput = {
      journey_id: 'bl338-not-ply-001-aaaa-bbbbbbbbbbbb',
      user_id: 'user-bl338-not-ply-001',
      origin_crs: 'NOT',
      destination_crs: 'PLY',
      departure_datetime: SEG1_NOT_DBY.scheduled_departure,
      arrival_datetime: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
      toc_code: 'EM',
      segments: [SEG1_NOT_DBY, SEG2_DBY_PLY],
      correlation_id: 'corr-bl338-not-ply',
      ticket_fare_pence: 7467, // mock £74.67 fare
      ticket_class: 'standard',
      ticket_type: 'anytime',
    };

    const result = await svc.evaluate(input);

    // AC-4 core assertion: ELIGIBLE outcome with 56-min delay
    expect(result.outcome).toBe('delayed');
    if (result.outcome === 'delayed') {
      expect(result.delay_minutes).toBe(56);
    }
  });

  it('AC-4b: evaluate() does NOT return no_data for NOT→PLY (regression against stub-OTP behaviour)', async () => {
    // Before this fix: stub OTP returned null → needs_manual_review → no_data
    // After fix: on-time-through for seg1 → real delay from seg2 → delayed
    const { svc } = buildMocks();

    const input: EvaluationInput = {
      journey_id: 'bl338-not-ply-002-aaaa-bbbbbbbbbbbb',
      user_id: 'user-bl338-not-ply-002',
      origin_crs: 'NOT',
      destination_crs: 'PLY',
      departure_datetime: SEG1_NOT_DBY.scheduled_departure,
      arrival_datetime: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
      toc_code: 'EM',
      segments: [SEG1_NOT_DBY, SEG2_DBY_PLY],
      correlation_id: 'corr-bl338-not-ply-02',
      ticket_fare_pence: 7467,
      ticket_class: 'standard',
      ticket_type: 'anytime',
    };

    const result = await svc.evaluate(input);

    // Must NOT be no_data (which was the broken behaviour)
    expect(result.outcome).not.toBe('no_data');
    expect(result.outcome).toBe('delayed');
  });

  it('AC-4c: evaluate() persists a delay_alert row when NOT→PLY result is delayed', async () => {
    const { svc, mockDelayAlertRepo } = buildMocks();

    const input: EvaluationInput = {
      journey_id: 'bl338-not-ply-003-aaaa-bbbbbbbbbbbb',
      user_id: 'user-bl338-not-ply-003',
      origin_crs: 'NOT',
      destination_crs: 'PLY',
      departure_datetime: SEG1_NOT_DBY.scheduled_departure,
      arrival_datetime: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
      toc_code: 'EM',
      segments: [SEG1_NOT_DBY, SEG2_DBY_PLY],
      correlation_id: 'corr-bl338-not-ply-03',
      ticket_fare_pence: 7467,
      ticket_class: 'standard',
      ticket_type: 'anytime',
    };

    await svc.evaluate(input);

    // A delay_alert must be persisted with the correct delay_minutes
    expect(mockDelayAlertRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        delay_minutes: 56,
        threshold_exceeded: true,
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5: Genuine cancelled/missed still routes to real OTP (regression)
// When a leg IS cancelled or connection IS missed, OTP MUST still be called.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-5: genuine cancelled/missed still routes to real OTP', () => {
  /**
   * The on-time-through fix must NOT accidentally suppress OTP calls for
   * genuinely cancelled services or missed connections.
   *
   * Differentiating data:
   *   - is_cancelled:true → OTP IS called (not on-time-through)
   *   - actual delay > connectionThreshold → OTP IS called (missed connection)
   */

  let mockDarwinClient: { getServiceWithStops: ReturnType<typeof vi.fn> };
  let mockTiplocRepo: { getCrsByTiploc: ReturnType<typeof vi.fn>; getTiplocsByCrs: ReturnType<typeof vi.fn> };
  let mockOtpClient: { findReplacementRoute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDarwinClient = { getServiceWithStops: vi.fn() };
    mockTiplocRepo = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn() };
    mockOtpClient = { findReplacementRoute: vi.fn() };
  });

  it('AC-5a: cancelled non-final leg routes to OTP findReplacementRoute (not on-time-through)', async () => {
    const cancelledLeg1: DarwinServiceWithStops = {
      rid: '202606136721613',
      delay_minutes: null,
      is_cancelled: true,       // GENUINE cancellation
      delay_reasons: [{ code: '101' }],
      status: 'cancelled',
      stops: null,
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(cancelledLeg1);
    mockOtpClient.findReplacementRoute.mockResolvedValueOnce(null);
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['DRBY']);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    await walk.calculate({
      legs: [
        {
          rid: '202606136721613',
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_DBY_PLY.rid,
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
          scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // OTP MUST be called for genuine cancellation (not suppressed by on-time-through)
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCrs: 'NOT',
        toCrs: 'PLY',
      }),
    );
  });

  it('AC-5b: OTP is called when real OtpRouterClient returns replacement legs for a cancelled leg', async () => {
    // AC-5b: when the REAL client is wired and OTP returns replacement legs,
    // SLW uses them (this test mocks the OtpClient interface with a real replacement response)
    const cancelledLeg: DarwinServiceWithStops = {
      rid: '202606136721613',
      delay_minutes: null,
      is_cancelled: true,
      delay_reasons: null,
      status: 'cancelled',
      stops: null,
    };

    const replacementViaOtp: OtpLeg[] = [
      {
        rid: '202606136721700', // different RID — the next available service
        originCrs: 'NOT',
        destinationCrs: 'DBY',
        scheduledDeparture: '2026-06-13T18:05:00Z',
        scheduledArrival: '2026-06-13T18:34:00Z',
        connectionThresholdMinutes: null,
      },
    ];

    const darwinReplacementLeg: DarwinServiceWithStops = {
      rid: '202606136721700',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'DRBY',
          scheduled_arrival: '2026-06-13T18:34:00Z',
          actual_arrival: '2026-06-13T18:34:00Z',
          delay_minutes: 0,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(cancelledLeg)           // original leg (cancelled)
      .mockResolvedValueOnce(darwinReplacementLeg);  // OTP replacement leg

    mockOtpClient.findReplacementRoute.mockResolvedValueOnce(replacementViaOtp);

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'DBY') return ['DRBY'];
      return [];
    });

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    // Single-leg journey: NOT→DBY cancelled, OTP returns replacement NOT→DBY
    const result = await walk.calculate({
      legs: [
        {
          rid: '202606136721613',
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'DBY',
      scheduledFinalArrival: SEG1_NOT_DBY.scheduled_arrival,
    });

    // OTP was called, replacement used, result is completed (on-time via replacement)
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    // Delay from replacement leg (on-time): scheduled '17:46', actual '18:34' = 48 min
    // but the replacement itself arrived on schedule, so delay = actual - original scheduled
    // original scheduled: 17:46 | replacement actual: 18:34 = 48 min late
    expect(result.delay_minutes).toBe(48);
  });

  it('AC-5c: missed connection (delay > threshold) routes to OTP — NOT treated as on-time-through', async () => {
    // Leg 1: destination PRESENT, but 45 min late > 30 min threshold
    const darwinLeg1MissedConnection: DarwinServiceWithStops = {
      rid: '202606136721613',
      delay_minutes: 45,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'DRBY',            // DBY destination IS present (not absent stop!)
          scheduled_arrival: SEG1_NOT_DBY.scheduled_arrival,
          actual_arrival: '2026-06-13T18:31:00Z', // 45 min late
          delay_minutes: 45,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(darwinLeg1MissedConnection);
    mockOtpClient.findReplacementRoute.mockResolvedValueOnce(null);
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['DRBY']);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    await walk.calculate({
      legs: [
        {
          rid: SEG1_NOT_DBY.rid,
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: 30, // 45 min delay > 30 min → missed connection
        },
        {
          rid: SEG2_DBY_PLY.rid,
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
          scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // Missed connection (delay > threshold) must call OTP
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-6: Single-leg regression — existing paths unchanged
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-6: Single-leg regression — LNER YRK→KGX style path unchanged', () => {
  /**
   * The on-time-through fix must NOT affect single-leg journeys where the
   * destination IS present in Darwin. These paths must continue to work as before.
   *
   * Reference: the real 2026-06-13 LNER 12:55 journey used in E2E (£74.67 fare).
   * Differentiating data: destination (KGX/KNGSCRS) IS present in Darwin stops.
   */

  it('AC-6a: single-leg, destination present, 30 min delay → completed delay_minutes:30', async () => {
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['KNGSCRS']), // KGX present
    };

    const darwinLNER: DarwinServiceWithStops = {
      rid: '202606137108175',
      delay_minutes: 30,
      is_cancelled: false,
      delay_reasons: [{ code: '573' }],
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'KNGSCRS', // KGX — present
          scheduled_arrival: ts('2026-06-13', '14:30'),
          actual_arrival: ts('2026-06-13', '15:00'),
          delay_minutes: 30,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValue(darwinLNER);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: '202606137108175',
          originCrs: 'YRK',
          destinationCrs: 'KGX',
          scheduledDeparture: ts('2026-06-13', '12:55'),
          scheduledArrival: ts('2026-06-13', '14:30'),
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts('2026-06-13', '14:30'),
    });

    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(30);
  });

  it('AC-6b: single-leg, on time, destination present → completed delay_minutes:0', async () => {
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['KNGSCRS']),
    };

    const darwinOnTime: DarwinServiceWithStops = {
      rid: '202606130001234',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'KNGSCRS',
          scheduled_arrival: ts('2026-06-13', '10:30'),
          actual_arrival: ts('2026-06-13', '10:30'),
          delay_minutes: 0,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValue(darwinOnTime);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: '202606130001234',
          originCrs: 'YRK',
          destinationCrs: 'KGX',
          scheduledDeparture: ts('2026-06-13', '09:00'),
          scheduledArrival: ts('2026-06-13', '10:30'),
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts('2026-06-13', '10:30'),
    });

    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(0);
  });

  it('AC-6c: via evaluate() — single-leg 56-min delay returns delayed outcome (not no_data)', async () => {
    // Verify evaluate() single-leg path is unchanged end-to-end

    const mockJourneyRepo = {
      findByJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'mj-bl338-sl-001' }),
      findSegmentsByJourneyId: vi.fn().mockResolvedValue([]),
    };
    const mockDelayAlertRepo = {
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'alert-bl338-sl-001' }),
    };
    const mockOutboxRepo = { create: vi.fn().mockResolvedValue(undefined) };

    const darwinSingleLeg: DarwinServiceWithStops = {
      rid: '202606137108175',
      delay_minutes: 56,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'KNGSCRS',
          scheduled_arrival: ts('2026-06-13', '14:30'),
          actual_arrival: ts('2026-06-13', '15:26'),
          delay_minutes: 56,
        },
      ],
    };

    const mockDarwinClient = {
      getDelayInfo: vi.fn(),
      getServiceWithStops: vi.fn().mockResolvedValue(darwinSingleLeg),
    };
    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['KNGSCRS']),
    };

    const slw = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient as any,
      otpClient: { findReplacementRoute: vi.fn().mockResolvedValue(null) },
    });

    const svc = new DelayEvaluationService({
      journeyRepository: mockJourneyRepo as any,
      delayAlertRepository: mockDelayAlertRepo as any,
      outboxRepository: mockOutboxRepo as any,
      darwinClient: mockDarwinClient as any,
      sequentialLegWalk: slw as any,
    });

    const singleSegment: EvaluationSegment = {
      segment_order: 0,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: ts('2026-06-13', '12:55'),
      scheduled_arrival: ts('2026-06-13', '14:30'),
      rid: '202606137108175',
      toc_code: 'GR',
    };

    const result = await svc.evaluate({
      journey_id: 'bl338-sl-regression-001-aaaa-bbbb',
      user_id: 'user-bl338-sl-001',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      departure_datetime: ts('2026-06-13', '12:55'),
      arrival_datetime: ts('2026-06-13', '14:30'),
      toc_code: 'GR',
      segments: [singleSegment],
      correlation_id: 'corr-bl338-sl',
      ticket_fare_pence: 7467,
      ticket_class: 'standard',
      ticket_type: 'anytime',
    });

    // Single-leg: 56 min delay → delayed (same behaviour as before)
    expect(result.outcome).toBe('delayed');
    if (result.outcome === 'delayed') {
      expect(result.delay_minutes).toBe(56);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8: Never fabricate 0 — null delay → no_data across ALL paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-338 AC-8: never fabricate delay_minutes:0 — null must propagate as no_data', () => {
  /**
   * Corroborates AC-3 across additional paths.
   * The ANTI-FRAUD principle: null delay_minutes must NEVER be coerced to 0.
   * This applies in BOTH SLW (assessment_pending/needs_manual_review) and
   * in evaluate()'s terminalFromSlwResult (delay_minutes===null → no_data).
   */

  it('AC-8a: SLW no_data → delay_minutes:null (not 0)', async () => {
    const mockDarwinClient = {
      getServiceWithStops: vi.fn().mockResolvedValue({
        rid: '202606136721613',
        delay_minutes: null,
        is_cancelled: false,
        delay_reasons: null,
        status: 'no_data',
        stops: null,
      } as DarwinServiceWithStops),
    };
    const mockTiplocRepo = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn().mockResolvedValue([]) };

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn().mockResolvedValue(null) },
    });

    const result = await walk.calculate({
      legs: [{
        rid: '202606136721613',
        originCrs: 'NOT',
        destinationCrs: 'DBY',
        scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
        scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
        connectionThresholdMinutes: null,
      }],
      finalDestinationCrs: 'DBY',
      scheduledFinalArrival: SEG1_NOT_DBY.scheduled_arrival,
    });

    // Must be null, never 0
    expect(result.delay_minutes).toBeNull();
    expect(result.delay_minutes).not.toBe(0);
    expect(result.status).toBe('assessment_pending');
  });

  it('AC-8b: evaluate() with SLW needs_manual_review → outcome:no_data (delay_minutes not in output)', async () => {
    // When SLW returns needs_manual_review, evaluate() must return no_data
    // (which has no delay_minutes field — the null check is in terminalFromSlwResult)
    const mockJourneyRepo = {
      findByJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'mj-bl338-nmr-001' }),
      findSegmentsByJourneyId: vi.fn().mockResolvedValue([]),
    };

    const darwinCancelled: DarwinServiceWithStops = {
      rid: SEG1_NOT_DBY.rid,
      delay_minutes: null,
      is_cancelled: true,
      delay_reasons: null,
      status: 'cancelled',
      stops: null,
    };

    const mockDarwinClient = {
      getDelayInfo: vi.fn(),
      getServiceWithStops: vi.fn().mockResolvedValue(darwinCancelled),
    };
    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['DRBY']),
    };

    const slw = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient as any,
      otpClient: { findReplacementRoute: vi.fn().mockResolvedValue(null) }, // null → needs_manual_review
    });

    const svc = new DelayEvaluationService({
      journeyRepository: mockJourneyRepo as any,
      delayAlertRepository: { create: vi.fn().mockResolvedValue(undefined) } as any,
      outboxRepository: { create: vi.fn().mockResolvedValue(undefined) } as any,
      darwinClient: mockDarwinClient as any,
      sequentialLegWalk: slw as any,
    });

    const result = await svc.evaluate({
      journey_id: 'bl338-nmr-001-aaaa-bbbbbbbbbbbb',
      user_id: 'user-bl338-nmr-001',
      origin_crs: 'NOT',
      destination_crs: 'DBY',
      departure_datetime: SEG1_NOT_DBY.scheduled_departure,
      arrival_datetime: SEG1_NOT_DBY.scheduled_arrival,
      toc_code: 'EM',
      segments: [SEG1_NOT_DBY],
      correlation_id: 'corr-bl338-nmr-01',
      ticket_fare_pence: 5000,
      ticket_class: 'standard',
      ticket_type: 'anytime',
    });

    // needs_manual_review must map to no_data (never fabricate 0-delay eligible)
    expect(result.outcome).toBe('no_data');
    // no_data outcome must NOT have a delay_minutes field
    expect('delay_minutes' in result).toBe(false);
  });

  it('AC-8c: on-time-through leg (delay:0) is distinguished from fabricated 0 — next leg carries real delay', async () => {
    // On-time-through is only valid for non-final legs where the stop is absent.
    // The resulting 0 delay for that leg is not the FINAL output — the next leg provides it.
    // This test confirms the 0 from on-time-through is correctly "forwarded through",
    // not reported as the final delay_minutes.

    const darwinLeg1 = DARWIN_SEG1_NO_DERBY_STOP; // absent Derby stop, service ran
    const darwinLeg2 = DARWIN_SEG2_PLY_DELAYED;    // Plymouth 56 min

    const mockDarwinClient = {
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(darwinLeg1)
        .mockResolvedValueOnce(darwinLeg2),
    };
    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'DBY') return ['DRBY'];
        if (crs === 'PLY') return ['PLYMTH'];
        return [];
      }),
    };

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_NOT_DBY.rid,
          originCrs: 'NOT',
          destinationCrs: 'DBY',
          scheduledDeparture: SEG1_NOT_DBY.scheduled_departure,
          scheduledArrival: SEG1_NOT_DBY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_DBY_PLY.rid,
          originCrs: 'DBY',
          destinationCrs: 'PLY',
          scheduledDeparture: SEG2_DBY_PLY.scheduled_departure,
          scheduledArrival: SEG2_DBY_PLY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: NOT_PLY_SCHEDULED_FINAL_ARRIVAL,
    });

    // Final output must be 56 (real delay from leg 2), NOT 0 (on-time-through from leg 1)
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(56);
    expect(result.delay_minutes).not.toBe(0);
  });
});
