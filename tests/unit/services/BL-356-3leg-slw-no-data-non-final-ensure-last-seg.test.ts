/**
 * RED Tests: BL-356
 * 3-leg SLW no_data non-final on-time-through + ensure handler last-segment final-dest
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-356
 * ADR     : ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 * ADR     : ADR-031 — Synchronous ensure-on-404
 * Date    : 2026-06-20
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * ─── WHAT THIS SPEC COVERS ────────────────────────────────────────────────────
 * Bug 1 — SLW short-circuits on no_data NON-FINAL leg (sequential-leg-walk.ts ~159-166):
 *   The current `no_data` branch returns assessment_pending for ANY leg — final or not.
 *   For a 3-leg journey where leg-1 is no_data (Darwin has no record), the walk exits
 *   early and leg-3's real 27-min delay is never seen → false "on time" result.
 *
 *   Fix required: when Darwin returns no_data for a NON-FINAL leg, treat it as
 *   on-time-through (continue to next leg, consistent with BL-338's destinationStop===null
 *   on-time-through). Only return assessment_pending when the FINAL leg is no_data.
 *
 * Bug 2 — ensure handler uses seg0.destination_crs as finalDestinationCrs (delay-ensure.handler.ts ~111):
 *   When the request body omits final-dest fields, the handler falls back to seg0.destination_crs
 *   (first segment = first interchange, NOT the real final destination). This means a
 *   3-leg LDS→MAN→BHM→NQY journey uses "MAN" (seg0 dest) instead of "NQY" (last seg dest)
 *   as the final destination for the SLW call, producing wrong or no results.
 *
 *   Fix required: use the LAST segment's destination_crs and scheduled_arrival as the
 *   fallback for finalDestinationCrs / scheduledFinalArrival in EvaluationInput.
 *
 * ─── REAL 3-LEG FIXTURE (LDS→MAN→BHM→NQY, 2026-06-17) ────────────────────────
 *   Leg 1: LDS→MAN, rid:'202606171210001', Darwin no_data (service not in ingestor)
 *   Leg 2: MAN→BHM, rid:'202606171415002', on-time, 54-min buffer before leg-3
 *   Leg 3: BHM→NQY, rid:'202606171700003', DELAYED 27 min (final)
 *   scheduledFinalArrival: '2026-06-17T20:15:00Z'
 *   Expected: status:'completed', delay_minutes:27 → ELIGIBLE
 *
 * ─── AC COVERAGE MAP ──────────────────────────────────────────────────────────
 * AC-1 : SLW non-final no_data leg → on-time-through (continues to next leg, no early exit)
 * AC-1 boundary: SLW FINAL leg no_data → assessment_pending (IMMUTABLE anti-fraud guard)
 * AC-2 : 3-leg dispositive — legs 1 no_data / leg 2 on-time / leg 3 +27 min → completed delay_minutes:27
 * AC-3 : ensure handler last-segment dest — multi-seg body-less → last seg's dest+arrival, NOT seg0
 * AC-4 : no-regression — 2-leg (leg-1 no_data, leg-2 final delayed) and 1-leg final-delayed unchanged
 * AC-5 : anti-fabrication — genuinely cancelled non-final leg still routes to OTP (not on-time-through)
 *         AND BL-338 stop-level on-time-through (destinationStop===null on running service) still holds
 *
 * ─── MOCK PATTERN (project memory) ───────────────────────────────────────────
 * vi.clearAllMocks() does NOT clear mockResolvedValueOnce queues.
 * Per-test: use individual .mockReset() + re-establish .mockResolvedValue() where needed.
 * Do NOT use vi.resetAllMocks() globally (broke factory mocks in BL-338 series).
 *
 * Shared logger pattern (TD-AUTH infra guideline):
 * When mocking @railrepay/winston-logger, define sharedLogger OUTSIDE the factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  SequentialLegWalk,
  type JourneyLeg,
  type DarwinServiceWithStops,
} from '../../../src/services/sequential-leg-walk.js';

import {
  DelayEvaluationService,
  type EvaluationInput,
  type EvaluationSegment,
} from '../../../src/services/delay-evaluation.service.js';

import { DelayEnsureHandler } from '../../../src/api/delay-ensure.handler.js';

// NOTE: DelayEnsureHandler is tested via express integration using supertest
import express from 'express';
// @ts-ignore — supertest may not have its own type declaration but is dev-dep
import request from 'supertest';

// ─── Helper ───────────────────────────────────────────────────────────────────

function ts(date: string, time: string): string {
  return `${date}T${time}:00Z`;
}

// ─── Real 3-leg fixture (LDS→MAN→BHM→NQY, 2026-06-17) ───────────────────────

const DATE_3LEG = '2026-06-17';

/** Seg 1: LDS→MAN. Darwin returns no_data (service not yet in ingestor). */
const SEG1_LDS_MAN: EvaluationSegment = {
  segment_order: 0,
  origin_crs: 'LDS',
  destination_crs: 'MAN',
  scheduled_departure: ts(DATE_3LEG, '12:10'),
  scheduled_arrival:   ts(DATE_3LEG, '13:05'),
  rid: '202606171210001',
  toc_code: 'TP',
};

/** Seg 2: MAN→BHM. On time, 54-min buffer before leg 3. */
const SEG2_MAN_BHM: EvaluationSegment = {
  segment_order: 1,
  origin_crs: 'MAN',
  destination_crs: 'BHM',
  scheduled_departure: ts(DATE_3LEG, '13:59'),
  scheduled_arrival:   ts(DATE_3LEG, '15:21'),
  rid: '202606171415002',
  toc_code: 'XC',
};

/** Seg 3: BHM→NQY (final). Delayed 27 min. */
const SEG3_BHM_NQY: EvaluationSegment = {
  segment_order: 2,
  origin_crs: 'BHM',
  destination_crs: 'NQY',
  scheduled_departure: ts(DATE_3LEG, '16:15'),
  scheduled_arrival:   ts(DATE_3LEG, '20:15'),
  rid: '202606171700003',
  toc_code: 'GW',
};

const SCHEDULED_FINAL_ARRIVAL_3LEG = ts(DATE_3LEG, '20:15');

/** Darwin: leg 1 (LDS→MAN) — no_data; Darwin has no record for this RID. */
const DARWIN_LEG1_NO_DATA: DarwinServiceWithStops = {
  rid: SEG1_LDS_MAN.rid,
  delay_minutes: null,
  is_cancelled: false,
  delay_reasons: null,
  status: 'no_data',
  stops: null,
};

/** Darwin: leg 2 (MAN→BHM) — on time, BHM destination present. */
const DARWIN_LEG2_BHM_ON_TIME: DarwinServiceWithStops = {
  rid: SEG2_MAN_BHM.rid,
  delay_minutes: 0,
  is_cancelled: false,
  delay_reasons: null,
  status: 'on_time',
  stops: [
    {
      tiploc_code: 'BHMNEWST', // BHM — on time
      scheduled_arrival: ts(DATE_3LEG, '15:21'),
      actual_arrival:    ts(DATE_3LEG, '15:21'),
      delay_minutes: 0,
    },
  ],
};

/** Darwin: leg 3 (BHM→NQY) — delayed 27 min at Newquay. */
const DARWIN_LEG3_NQY_DELAYED: DarwinServiceWithStops = {
  rid: SEG3_BHM_NQY.rid,
  delay_minutes: 27,
  is_cancelled: false,
  delay_reasons: [{ code: '576', description: 'Track problem' }],
  status: 'delayed',
  stops: [
    {
      tiploc_code: 'NEWQUAY', // NQY — delayed 27 min
      scheduled_arrival: ts(DATE_3LEG, '20:15'),
      actual_arrival:    ts(DATE_3LEG, '20:42'),
      delay_minutes: 27,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1: SLW non-final no_data → on-time-through (continues, does NOT return early)
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-356 AC-1: SLW non-final no_data leg → on-time-through (continues to next leg)', () => {
  /**
   * Bug: the no_data branch at ~line 159-166 of sequential-leg-walk.ts
   * returns assessment_pending for ANY leg, including non-final legs.
   *
   * Fix: when Darwin returns no_data for a NON-FINAL leg, treat it as
   * on-time-through (consistent with BL-338's destinationStop===null branch).
   * Only return assessment_pending when the FINAL leg is no_data.
   *
   * This is the SERVICE-LEVEL parallel to BL-338's STOP-LEVEL on-time-through:
   *   BL-338: service ran (not no_data), but destination STOP absent → on-time-through
   *   BL-356: service UNKNOWN (no_data), non-final leg → on-time-through
   *
   * Differentiating data:
   *   - 2-leg journey; leg-1 is non-final + no_data; leg-2 is final + delayed
   *   - Darwin called twice: once for leg-1 (no_data), once for leg-2 (delayed)
   *   - Current broken behaviour: exits after leg-1 → assessment_pending
   *   - Fixed behaviour: continues to leg-2 → completed delay_minutes:56
   */

  let mockDarwinClient: { getServiceWithStops: ReturnType<typeof vi.fn> };
  let mockTiplocRepo: {
    getCrsByTiploc: ReturnType<typeof vi.fn>;
    getTiplocsByCrs: ReturnType<typeof vi.fn>;
  };
  let mockOtpClient: { findReplacementRoute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDarwinClient = { getServiceWithStops: vi.fn() };
    mockTiplocRepo   = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn() };
    mockOtpClient    = { findReplacementRoute: vi.fn() };
  });

  it('AC-1a: Darwin getServiceWithStops is called for BOTH legs when leg-1 is no_data (walk does not exit early)', async () => {
    /**
     * After the fix, the walk must NOT short-circuit on a non-final no_data leg.
     * Darwin must be called for leg-2 as well.
     */
    const darwinLeg2Delayed: DarwinServiceWithStops = {
      rid: '202606171415002',
      delay_minutes: 56,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'PLYMTH',
          scheduled_arrival: ts('2026-06-17', '22:48'),
          actual_arrival:    ts('2026-06-17', '23:44'),
          delay_minutes: 56,
        },
      ],
    };

    // Leg-1: no_data. Leg-2: delayed.
    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)
      .mockResolvedValueOnce(darwinLeg2Delayed);

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'MAN') return ['MNCRPIC'];  // leg-1 dest — irrelevant when no_data
      if (crs === 'PLY') return ['PLYMTH'];   // leg-2 dest (final)
      return [];
    });

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    await walk.calculate({
      legs: [
        {
          rid: '202606171210001',
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: ts('2026-06-17', '12:10'),
          scheduledArrival:   ts('2026-06-17', '13:05'),
          connectionThresholdMinutes: null,
        },
        {
          rid: '202606171415002',
          originCrs: 'MAN',
          destinationCrs: 'PLY',
          scheduledDeparture: ts('2026-06-17', '19:09'),
          scheduledArrival:   ts('2026-06-17', '22:48'),
          connectionThresholdMinutes: null, // final leg
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: ts('2026-06-17', '22:48'),
    });

    // KEY ASSERTION: Darwin was called for BOTH legs (no early exit after leg-1 no_data)
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(2);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(1, '202606171210001');
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(2, '202606171415002');
  });

  it('AC-1b: non-final no_data leg → walk continues and returns the FINAL leg delay (not assessment_pending)', async () => {
    /**
     * Verify the result is 'completed' with the real final-leg delay,
     * NOT 'assessment_pending' (the current broken early-exit behaviour).
     */
    const darwinLeg2Delayed: DarwinServiceWithStops = {
      rid: '202606171415002',
      delay_minutes: 56,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'PLYMTH',
          scheduled_arrival: ts('2026-06-17', '22:48'),
          actual_arrival:    ts('2026-06-17', '23:44'),
          delay_minutes: 56,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)
      .mockResolvedValueOnce(darwinLeg2Delayed);

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'PLY') return ['PLYMTH'];
      return [];
    });

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: '202606171210001',
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: ts('2026-06-17', '12:10'),
          scheduledArrival:   ts('2026-06-17', '13:05'),
          connectionThresholdMinutes: null,
        },
        {
          rid: '202606171415002',
          originCrs: 'MAN',
          destinationCrs: 'PLY',
          scheduledDeparture: ts('2026-06-17', '19:09'),
          scheduledArrival:   ts('2026-06-17', '22:48'),
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: ts('2026-06-17', '22:48'),
    });

    // Must be completed with real delay from leg-2; NOT assessment_pending
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(56);
    // Explicitly assert it is NOT the early-exit broken behaviour
    expect(result.status).not.toBe('assessment_pending');
    expect(result.delay_minutes).not.toBeNull();
  });

  it('AC-1c: non-final no_data → OTP is NOT called (on-time-through, not a genuine cancellation)', async () => {
    /**
     * The no_data non-final on-time-through must NOT trigger an OTP call.
     * OTP is only for genuine cancellations or missed connections.
     */
    const darwinLeg2OnTime: DarwinServiceWithStops = {
      rid: '202606171415002',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'PLYMTH',
          scheduled_arrival: ts('2026-06-17', '22:48'),
          actual_arrival:    ts('2026-06-17', '22:48'),
          delay_minutes: 0,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)
      .mockResolvedValueOnce(darwinLeg2OnTime);

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'PLY') return ['PLYMTH'];
      return [];
    });

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    await walk.calculate({
      legs: [
        {
          rid: '202606171210001',
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: ts('2026-06-17', '12:10'),
          scheduledArrival:   ts('2026-06-17', '13:05'),
          connectionThresholdMinutes: null,
        },
        {
          rid: '202606171415002',
          originCrs: 'MAN',
          destinationCrs: 'PLY',
          scheduledDeparture: ts('2026-06-17', '19:09'),
          scheduledArrival:   ts('2026-06-17', '22:48'),
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: ts('2026-06-17', '22:48'),
    });

    // OTP MUST NOT be called for a non-final no_data on-time-through
    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1 boundary (IMMUTABLE ANTI-FRAUD GUARD):
// FINAL leg no_data → assessment_pending (NEVER on-time-through)
// This is the immutable companion to the non-final on-time-through.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-356 AC-1 boundary: FINAL leg no_data → assessment_pending (IMMUTABLE anti-fraud guard)', () => {
  /**
   * The non-final no_data on-time-through MUST NOT apply to the FINAL leg.
   * If the FINAL leg has no Darwin data, the delay is genuinely unknown — must
   * return assessment_pending. Never assume on-time for the final leg.
   *
   * This is the service-level parallel to BL-338's AC-3 (stop-level anti-fraud guard).
   *
   * Differentiating data:
   *   - Single-leg journey (isLastLeg=true for the only leg)
   *   - Darwin status: 'no_data' for the final (only) leg
   *   - Expected: assessment_pending, delay_minutes:null
   */

  it('AC-1-boundary-a: single-leg no_data (final leg) → assessment_pending, delay_minutes null', async () => {
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn().mockResolvedValue([]) };
    const mockOtpClient    = { findReplacementRoute: vi.fn() };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce({
      rid: '202606171700003',
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'no_data',
      stops: null,
    } as DarwinServiceWithStops);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: '202606171700003',
          originCrs: 'BHM',
          destinationCrs: 'NQY',
          scheduledDeparture: ts(DATE_3LEG, '16:15'),
          scheduledArrival:   ts(DATE_3LEG, '20:15'),
          connectionThresholdMinutes: null, // FINAL leg
        },
      ],
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: ts(DATE_3LEG, '20:15'),
    });

    // IMMUTABLE: final leg no_data → assessment_pending, NEVER completed/0
    expect(result.status).toBe('assessment_pending');
    expect(result.delay_minutes).toBeNull();
    expect(result.delay_minutes).not.toBe(0);
    // OTP must NOT be called for no_data (Darwin has no record — not a cancellation)
    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
  });

  it('AC-1-boundary-b: 3-leg journey where FINAL leg is no_data → assessment_pending (non-final legs continue, final exits correctly)', async () => {
    /**
     * Legs 1 and 2 are on-time (non-final, proceed normally).
     * Leg 3 (final) is no_data → must return assessment_pending.
     * This confirms the fix is SCOPED: on-time-through only for non-final no_data legs.
     */
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn() };
    const mockOtpClient    = { findReplacementRoute: vi.fn() };

    const darwinLeg1OnTime: DarwinServiceWithStops = {
      rid: SEG1_LDS_MAN.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'MNCRPIC',
          scheduled_arrival: ts(DATE_3LEG, '13:05'),
          actual_arrival:    ts(DATE_3LEG, '13:05'),
          delay_minutes: 0,
        },
      ],
    };

    const darwinLeg2OnTime: DarwinServiceWithStops = {
      rid: SEG2_MAN_BHM.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'BHMNEWST',
          scheduled_arrival: ts(DATE_3LEG, '15:21'),
          actual_arrival:    ts(DATE_3LEG, '15:21'),
          delay_minutes: 0,
        },
      ],
    };

    const darwinLeg3FinalNoData: DarwinServiceWithStops = {
      rid: SEG3_BHM_NQY.rid,
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'no_data', // FINAL leg — must return assessment_pending
      stops: null,
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(darwinLeg1OnTime)
      .mockResolvedValueOnce(darwinLeg2OnTime)
      .mockResolvedValueOnce(darwinLeg3FinalNoData);

    mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === 'MAN') return ['MNCRPIC'];
      if (crs === 'BHM') return ['BHMNEWST'];
      if (crs === 'NQY') return ['NEWQUAY'];
      return [];
    });

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_LDS_MAN.rid,
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
          scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_MAN_BHM.rid,
          originCrs: 'MAN',
          destinationCrs: 'BHM',
          scheduledDeparture: SEG2_MAN_BHM.scheduled_departure,
          scheduledArrival:   SEG2_MAN_BHM.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG3_BHM_NQY.rid,
          originCrs: 'BHM',
          destinationCrs: 'NQY',
          scheduledDeparture: SEG3_BHM_NQY.scheduled_departure,
          scheduledArrival:   SEG3_BHM_NQY.scheduled_arrival,
          connectionThresholdMinutes: null, // FINAL leg
        },
      ],
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // Final leg no_data → assessment_pending (immutable guard — not on-time-through)
    expect(result.status).toBe('assessment_pending');
    expect(result.delay_minutes).toBeNull();
    // All 3 Darwin calls were made (legs 1+2 continued; leg 3 exited correctly)
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2: Dispositive 3-leg — leg-1 no_data / leg-2 on-time / leg-3 +27 min
// Expected: status:'completed', delay_minutes:27 → ELIGIBLE
// This is the mirror of the real b9e19734 scan scenario.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-356 AC-2: Dispositive 3-leg journey — no_data leg-1, on-time leg-2, 27-min-delayed leg-3', () => {
  /**
   * The actual real-world scenario that exposed this bug.
   * Leg-1 (LDS→MAN): Darwin no_data (service not in ingestor)
   * Leg-2 (MAN→BHM): on time, 54-min buffer to leg-3 (connection made)
   * Leg-3 (BHM→NQY): delayed 27 min → ELIGIBLE
   *
   * Current broken behaviour:
   *   - SLW sees leg-1 no_data → early-exit → assessment_pending → no_data
   *   - Leg-3's 27-min delay is never evaluated
   *   - Journey shown as "on time" to passenger
   *
   * After fix:
   *   - SLW leg-1 no_data → on-time-through → continues to leg-2
   *   - Leg-2 on-time → connection made → continues to leg-3
   *   - Leg-3 +27 min → status:'completed', delay_minutes:27
   *
   * Differentiating data per-leg (distinct RIDs, CRS, tiploc):
   *   Leg 1: rid:202606171210001, LDS→MAN, no_data
   *   Leg 2: rid:202606171415002, MAN→BHM, on_time, tiploc:BHMNEWST
   *   Leg 3: rid:202606171700003, BHM→NQY, delayed 27, tiploc:NEWQUAY
   */

  function buildThreeLegWalk(
    options: { leg2ConnectionThreshold?: number } = {},
  ) {
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'MAN') return ['MNCRPIC'];
        if (crs === 'BHM') return ['BHMNEWST'];
        if (crs === 'NQY') return ['NEWQUAY'];
        return [];
      }),
    };
    const mockOtpClient = { findReplacementRoute: vi.fn() };

    // Queue: leg-1 → no_data, leg-2 → on_time, leg-3 → delayed 27
    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)
      .mockResolvedValueOnce(DARWIN_LEG2_BHM_ON_TIME)
      .mockResolvedValueOnce(DARWIN_LEG3_NQY_DELAYED);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const legs: JourneyLeg[] = [
      {
        rid: SEG1_LDS_MAN.rid,
        originCrs: 'LDS',
        destinationCrs: 'MAN',
        scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
        scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
        connectionThresholdMinutes: null, // no_data leg — threshold irrelevant
      },
      {
        rid: SEG2_MAN_BHM.rid,
        originCrs: 'MAN',
        destinationCrs: 'BHM',
        scheduledDeparture: SEG2_MAN_BHM.scheduled_departure,
        scheduledArrival:   SEG2_MAN_BHM.scheduled_arrival,
        // 54-min buffer: (16:15 - 15:21) = 54 min. Even with a 30-min threshold,
        // leg-2 is on time so no missed connection.
        connectionThresholdMinutes: options.leg2ConnectionThreshold ?? 54,
      },
      {
        rid: SEG3_BHM_NQY.rid,
        originCrs: 'BHM',
        destinationCrs: 'NQY',
        scheduledDeparture: SEG3_BHM_NQY.scheduled_departure,
        scheduledArrival:   SEG3_BHM_NQY.scheduled_arrival,
        connectionThresholdMinutes: null, // FINAL leg
      },
    ];

    return { walk, legs, mockDarwinClient, mockOtpClient, mockTiplocRepo };
  }

  it('AC-2a: 3-leg walk returns status:completed with delay_minutes:27 (dispositive assertion)', async () => {
    const { walk, legs } = buildThreeLegWalk();

    const result = await walk.calculate({
      legs,
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // DISPOSITIVE: the 3-leg walk must see leg-3's real 27-min delay
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(27);
  });

  it('AC-2b: all 3 Darwin calls are made (no early exit on leg-1 no_data)', async () => {
    const { walk, legs, mockDarwinClient } = buildThreeLegWalk();

    await walk.calculate({
      legs,
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // All 3 legs must be evaluated (leg-1 on-time-through → leg-2 on-time → leg-3 real delay)
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(3);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(1, SEG1_LDS_MAN.rid);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(2, SEG2_MAN_BHM.rid);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(3, SEG3_BHM_NQY.rid);
  });

  it('AC-2c: OTP is NOT called for the no_data leg-1 on-time-through (no fabricated replacement route)', async () => {
    const { walk, legs, mockOtpClient } = buildThreeLegWalk();

    await walk.calculate({
      legs,
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // No OTP call: leg-1 is on-time-through; leg-2 connection is made; no OTP needed
    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
  });

  it('AC-2d: result is NOT assessment_pending (the broken pre-fix early-exit outcome)', async () => {
    /**
     * Before the fix: result.status = 'assessment_pending', delay_minutes = null.
     * After the fix:  result.status = 'completed',          delay_minutes = 27.
     * This test makes the broken outcome explicit as the RED failure mode.
     */
    const { walk, legs } = buildThreeLegWalk();

    const result = await walk.calculate({
      legs,
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // Explicitly NOT the broken early-exit
    expect(result.status).not.toBe('assessment_pending');
    expect(result.delay_minutes).not.toBeNull();
  });

  it('AC-2e: through evaluate() — 3-leg journey outcome is delayed (not no_data) with delay_minutes:27', async () => {
    /**
     * Full pipeline test: EvaluationInput → evaluate() → SLW → mocked Darwin.
     * Confirms that the fix propagates through the entire evaluation chain.
     * The delayAlertRepository.create must be called with delay_minutes:27.
     */
    const mockJourneyRepo = {
      findByJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'mj-bl356-3leg-001' }),
      findSegmentsByJourneyId: vi.fn().mockResolvedValue([SEG1_LDS_MAN, SEG2_MAN_BHM, SEG3_BHM_NQY]),
    };

    const mockDelayAlertRepo = {
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'alert-bl356-3leg-001' }),
    };

    const mockOutboxRepo = { create: vi.fn().mockResolvedValue(undefined) };

    const mockDarwinClient = {
      getDelayInfo: vi.fn(),
      // Pre-check on seg1.rid (evaluate pre-check)
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)  // pre-check (seg1 → no_data but doesn't throw)
        .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)  // SLW leg-1
        .mockResolvedValueOnce(DARWIN_LEG2_BHM_ON_TIME)  // SLW leg-2
        .mockResolvedValueOnce(DARWIN_LEG3_NQY_DELAYED), // SLW leg-3
    };

    const mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'MAN') return ['MNCRPIC'];
        if (crs === 'BHM') return ['BHMNEWST'];
        if (crs === 'NQY') return ['NEWQUAY'];
        return [];
      }),
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

    const input: EvaluationInput = {
      journey_id: 'bl356-3leg-001-aaaa-bbbbbbbbbbbb',
      user_id: 'user-bl356-3leg-001',
      origin_crs: 'LDS',
      destination_crs: 'NQY',
      departure_datetime: SEG1_LDS_MAN.scheduled_departure,
      arrival_datetime: SCHEDULED_FINAL_ARRIVAL_3LEG,
      toc_code: 'XC',
      segments: [SEG1_LDS_MAN, SEG2_MAN_BHM, SEG3_BHM_NQY],
      correlation_id: 'corr-bl356-3leg-001',
      ticket_fare_pence: 9900,
      ticket_class: 'standard',
      ticket_type: 'anytime',
    };

    const result = await svc.evaluate(input);

    // Full pipeline: 3-leg journey → delayed outcome with 27-min delay
    expect(result.outcome).toBe('delayed');
    if (result.outcome === 'delayed') {
      expect(result.delay_minutes).toBe(27);
    }
    // Must NOT be no_data (the broken pre-fix outcome)
    expect(result.outcome).not.toBe('no_data');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-3: ensure handler last-segment dest — multi-seg body-less fallback
// The bug: handler falls back to seg0.destination_crs / seg0.scheduled_arrival
// Fix: use LAST segment's destination_crs / scheduled_arrival
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-356 AC-3: ensure handler uses LAST segment final-dest (not seg0) when body omits final-dest', () => {
  /**
   * Bug: delay-ensure.handler.ts ~line 111:
   *   destination_crs: ... seg0.destination_crs   // WRONG: first interchange
   *   arrival_datetime: ... seg0.scheduled_arrival // WRONG: first interchange arrival
   *
   * Fix: use the LAST segment's destination_crs / scheduled_arrival.
   *
   * For a 3-leg LDS→MAN→BHM→NQY journey:
   *   seg0.destination_crs = 'MAN'  (wrong — first interchange)
   *   lastSeg.destination_crs = 'NQY' (correct — final destination)
   *
   * We verify this by checking what EvaluationInput is passed to
   * DelayEvaluationService.evaluate(). We mock evaluate() and capture the call args.
   *
   * Differentiating data:
   *   seg0.destination_crs = 'MAN' (Sheffield in real scenario, but MAN here for clarity)
   *   lastSeg.destination_crs = 'NQY' (Newquay)
   *   Body has no destination_crs field (omitted — tests the fallback path)
   *   Body has no arrival_datetime field (omitted — tests the fallback path)
   */

  function buildApp(mockEvaluateFn: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(express.json());

    // Mock journeyRepository: findSegmentsByJourneyId returns 3 segs
    const mockJourneyRepo = {
      findByJourneyId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'mj-bl356-ac3-001' }),
      findSegmentsByJourneyId: vi.fn().mockResolvedValue([SEG1_LDS_MAN, SEG2_MAN_BHM, SEG3_BHM_NQY]),
    };

    // Mock DelayEvaluationService: capture what evaluate() is called with
    const mockDelayEvaluationService = {
      evaluate: mockEvaluateFn,
    };

    const handler = new DelayEnsureHandler({
      journeyRepository: mockJourneyRepo as any,
      delayEvaluationService: mockDelayEvaluationService as any,
    });

    handler.register(app);
    return app;
  }

  it('AC-3a: evaluate() is called with destination_crs from the LAST segment (NQY), NOT seg0 (MAN)', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue({ outcome: 'on_time', delay_minutes: 0, cancelled: false, toc_code: 'GW', last_observed_at: new Date().toISOString() });
    const app = buildApp(mockEvaluate);

    // Body: only journey_id + user_id (no destination_crs, no arrival_datetime)
    await request(app)
      .post('/delays/ensure')
      .send({
        journey_id: 'bl356-ac3-001-aaaa-bbbbbbbbbbbb',
        user_id: 'user-bl356-ac3-001',
        // Intentionally omitting destination_crs and arrival_datetime
        // to exercise the seg-fallback path
      })
      .expect(200);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);

    const callArg: EvaluationInput = mockEvaluate.mock.calls[0][0];

    // KEY ASSERTION: finalDestinationCrs must be from LAST segment (NQY), not seg0 (MAN)
    expect(callArg.destination_crs).toBe('NQY');
    // KEY ASSERTION: arrival_datetime must be from LAST segment
    expect(callArg.arrival_datetime).toBe(SEG3_BHM_NQY.scheduled_arrival);

    // CONFIRM it is NOT seg0's values (the broken pre-fix behaviour)
    expect(callArg.destination_crs).not.toBe('MAN');  // seg0.destination_crs
    expect(callArg.arrival_datetime).not.toBe(SEG1_LDS_MAN.scheduled_arrival);
  });

  it('AC-3b: evaluate() is called with origin_crs from seg0 (LDS) — that part remains unchanged', async () => {
    /**
     * Only the DEST fields should use last seg; the origin fields should still use seg0.
     * This guards against over-correction.
     */
    const mockEvaluate = vi.fn().mockResolvedValue({ outcome: 'on_time', delay_minutes: 0, cancelled: false, toc_code: 'GW', last_observed_at: new Date().toISOString() });
    const app = buildApp(mockEvaluate);

    await request(app)
      .post('/delays/ensure')
      .send({
        journey_id: 'bl356-ac3-002-aaaa-bbbbbbbbbbbb',
        user_id: 'user-bl356-ac3-002',
      })
      .expect(200);

    const callArg: EvaluationInput = mockEvaluate.mock.calls[0][0];

    // Origin must still come from seg0 (not changed by the fix)
    expect(callArg.origin_crs).toBe(SEG1_LDS_MAN.origin_crs); // 'LDS'
    expect(callArg.departure_datetime).toBe(SEG1_LDS_MAN.scheduled_departure);
  });

  it('AC-3c: when body provides explicit destination_crs and arrival_datetime, they take precedence over seg fallback', async () => {
    /**
     * The fix must not break the explicit-value path.
     * When body has destination_crs and arrival_datetime, they must be used as-is.
     */
    const mockEvaluate = vi.fn().mockResolvedValue({ outcome: 'no_data' });
    const app = buildApp(mockEvaluate);

    const explicitDest = 'NQY';
    const explicitArrival = '2026-06-17T22:00:00Z';

    await request(app)
      .post('/delays/ensure')
      .send({
        journey_id: 'bl356-ac3-003-aaaa-bbbbbbbbbbbb',
        user_id: 'user-bl356-ac3-003',
        destination_crs: explicitDest,
        arrival_datetime: explicitArrival,
      })
      .expect(200);

    const callArg: EvaluationInput = mockEvaluate.mock.calls[0][0];

    // Explicit values in body must take precedence
    expect(callArg.destination_crs).toBe(explicitDest);
    expect(callArg.arrival_datetime).toBe(explicitArrival);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-4: No-regression — 2-leg and 1-leg paths unchanged
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-356 AC-4: No-regression — 2-leg and 1-leg SLW paths unaffected by the fix', () => {
  /**
   * The non-final no_data on-time-through fix must not break existing paths:
   * - 2-leg: leg-1 no_data, leg-2 final delayed → completed with correct delay
   *   (same shape as BL-338's NOT→PLY fixture but using BL-356's LDS→MAN context)
   * - 1-leg: single final leg with delay → completed with correct delay
   * - 2-leg: leg-1 on-time (destination present), leg-2 final on-time → completed 0
   */

  it('AC-4a: 2-leg journey (leg-1 no_data, leg-2 final delayed 56 min) → completed delay_minutes:56', async () => {
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'MAN') return ['MNCRPIC'];
        if (crs === 'PLY') return ['PLYMTH'];
        return [];
      }),
    };

    const darwinLeg2Delayed: DarwinServiceWithStops = {
      rid: '202606171415KGX',
      delay_minutes: 56,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'PLYMTH',
          scheduled_arrival: ts('2026-06-17', '22:48'),
          actual_arrival:    ts('2026-06-17', '23:44'),
          delay_minutes: 56,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)  // leg-1: no_data → on-time-through
      .mockResolvedValueOnce(darwinLeg2Delayed);    // leg-2: final → 56 min

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_LDS_MAN.rid,
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
          scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: '202606171415KGX',
          originCrs: 'MAN',
          destinationCrs: 'PLY',
          scheduledDeparture: ts('2026-06-17', '19:09'),
          scheduledArrival:   ts('2026-06-17', '22:48'),
          connectionThresholdMinutes: null, // final
        },
      ],
      finalDestinationCrs: 'PLY',
      scheduledFinalArrival: ts('2026-06-17', '22:48'),
    });

    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(56);
    // Both Darwin calls were made (not short-circuited)
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(2);
  });

  it('AC-4b: single-leg final-delayed journey → completed with correct delay (unchanged by BL-356 fix)', async () => {
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['KNGSCRS']),
    };

    const darwinSingleLegDelayed: DarwinServiceWithStops = {
      rid: '202606177108175',
      delay_minutes: 30,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'KNGSCRS',
          scheduled_arrival: ts('2026-06-17', '14:30'),
          actual_arrival:    ts('2026-06-17', '15:00'),
          delay_minutes: 30,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(darwinSingleLegDelayed);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: '202606177108175',
          originCrs: 'YRK',
          destinationCrs: 'KGX',
          scheduledDeparture: ts('2026-06-17', '12:55'),
          scheduledArrival:   ts('2026-06-17', '14:30'),
          connectionThresholdMinutes: null, // FINAL + ONLY leg
        },
      ],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts('2026-06-17', '14:30'),
    });

    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(30);
  });

  it('AC-4c: 2-leg journey with leg-1 on-time (destination present) → completed 0, unchanged', async () => {
    /**
     * The normal 2-leg on-time path (no no_data, no absent stop):
     * must continue to work exactly as before the BL-356 fix.
     */
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'MAN') return ['MNCRPIC'];
        if (crs === 'NQY') return ['NEWQUAY'];
        return [];
      }),
    };

    const darwinLeg1Present: DarwinServiceWithStops = {
      rid: SEG1_LDS_MAN.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'MNCRPIC',
          scheduled_arrival: SEG1_LDS_MAN.scheduled_arrival,
          actual_arrival:    SEG1_LDS_MAN.scheduled_arrival,
          delay_minutes: 0,
        },
      ],
    };

    const darwinLeg2OnTime: DarwinServiceWithStops = {
      rid: SEG3_BHM_NQY.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'NEWQUAY',
          scheduled_arrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
          actual_arrival:    SCHEDULED_FINAL_ARRIVAL_3LEG,
          delay_minutes: 0,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(darwinLeg1Present)
      .mockResolvedValueOnce(darwinLeg2OnTime);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_LDS_MAN.rid,
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
          scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG3_BHM_NQY.rid,
          originCrs: 'MAN',
          destinationCrs: 'NQY',
          scheduledDeparture: SEG3_BHM_NQY.scheduled_departure,
          scheduledArrival:   SCHEDULED_FINAL_ARRIVAL_3LEG,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5: Anti-fabrication — cancelled non-final leg still routes to OTP
//       AND BL-338 stop-level on-time-through (destinationStop===null) still holds
// ═══════════════════════════════════════════════════════════════════════════════

describe('BL-356 AC-5: anti-fabrication — cancelled non-final leg routes to OTP, stop-level on-time-through unchanged', () => {
  /**
   * The no_data on-time-through fix must NOT affect the genuine cancellation path.
   * A cancelled non-final leg (is_cancelled:true) must still call OTP.
   * Also confirms BL-338's stop-level on-time-through (destinationStop===null on
   * a running service, status!='no_data') is not disturbed by the BL-356 change.
   */

  it('AC-5a: cancelled (is_cancelled:true) non-final leg → OTP IS called (not on-time-through)', async () => {
    /**
     * is_cancelled:true is a genuine cancellation — must route to OTP.
     * Differentiating: status='cancelled', is_cancelled=true (vs no_data fix which is status='no_data').
     */
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn().mockResolvedValue(['MNCRPIC']) };
    const mockOtpClient    = { findReplacementRoute: vi.fn().mockResolvedValue(null) };

    const darwinCancelledLeg1: DarwinServiceWithStops = {
      rid: SEG1_LDS_MAN.rid,
      delay_minutes: null,
      is_cancelled: true, // GENUINE cancellation — NOT no_data
      delay_reasons: [{ code: '101', description: 'Train crew shortage' }],
      status: 'cancelled',
      stops: null,
    };

    mockDarwinClient.getServiceWithStops.mockResolvedValueOnce(darwinCancelledLeg1);

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    await walk.calculate({
      legs: [
        {
          rid: SEG1_LDS_MAN.rid,
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
          scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_MAN_BHM.rid,
          originCrs: 'MAN',
          destinationCrs: 'BHM',
          scheduledDeparture: SEG2_MAN_BHM.scheduled_departure,
          scheduledArrival:   SEG2_MAN_BHM.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG3_BHM_NQY.rid,
          originCrs: 'BHM',
          destinationCrs: 'NQY',
          scheduledDeparture: SEG3_BHM_NQY.scheduled_departure,
          scheduledArrival:   SEG3_BHM_NQY.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
      ],
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // Cancelled leg MUST trigger OTP — not on-time-through
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCrs: 'LDS',
        toCrs: 'NQY',
      }),
    );
  });

  it('AC-5b: BL-338 stop-level on-time-through (destinationStop absent, service ran, status!=no_data) still works in 3-leg context', async () => {
    /**
     * BL-338: if Darwin status is NOT no_data (e.g., 'delayed') but the destination STOP
     * is absent from the stops array for a non-final leg → on-time-through (continue).
     * BL-356 adds: if Darwin status IS no_data for a non-final leg → also on-time-through.
     * Both must coexist; BL-338's stop-level path must still fire for 'delayed' status.
     *
     * Leg-1: status='delayed', destination MAN ABSENT from stops (stop-level gap) → on-time-through (BL-338)
     * Leg-2: status='no_data' (service-level gap) → on-time-through (BL-356)
     * Leg-3: delayed 27 min at NQY → completed delay_minutes:27
     */
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockOtpClient    = { findReplacementRoute: vi.fn() };
    const mockTiplocRepo   = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
        if (crs === 'MAN') return ['MNCRPIC'];  // returns tiploc that is ABSENT from leg-1 stops
        if (crs === 'BHM') return ['BHMNEWST']; // irrelevant for leg-2 (no_data)
        if (crs === 'NQY') return ['NEWQUAY'];  // present in leg-3 stops
        return [];
      }),
    };

    const darwinLeg1RunningNoDerbySt: DarwinServiceWithStops = {
      rid: SEG1_LDS_MAN.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed', // Service RAN (not no_data, not cancelled) → BL-338 applies
      stops: [
        // MAN/MNCRPIC is intentionally ABSENT (coverage gap, BL-338 scenario)
        {
          tiploc_code: 'LEEDS',
          scheduled_arrival: null,
          actual_arrival: null,
          delay_minutes: 0,
        },
      ],
    };

    // Leg-2 is no_data → BL-356 applies
    const darwinLeg2NoData: DarwinServiceWithStops = {
      rid: SEG2_MAN_BHM.rid,
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'no_data',
      stops: null,
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(darwinLeg1RunningNoDerbySt)  // BL-338: stop absent, service ran
      .mockResolvedValueOnce(darwinLeg2NoData)            // BL-356: no_data on non-final
      .mockResolvedValueOnce(DARWIN_LEG3_NQY_DELAYED);    // final: 27 min

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_LDS_MAN.rid,
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
          scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG2_MAN_BHM.rid,
          originCrs: 'MAN',
          destinationCrs: 'BHM',
          scheduledDeparture: SEG2_MAN_BHM.scheduled_departure,
          scheduledArrival:   SEG2_MAN_BHM.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG3_BHM_NQY.rid,
          originCrs: 'BHM',
          destinationCrs: 'NQY',
          scheduledDeparture: SEG3_BHM_NQY.scheduled_departure,
          scheduledArrival:   SEG3_BHM_NQY.scheduled_arrival,
          connectionThresholdMinutes: null, // FINAL leg
        },
      ],
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // Both BL-338 (stop-level) and BL-356 (service-level) on-time-throughs fire correctly
    // Result must be leg-3's 27-min delay
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(27);
    // OTP must NOT be called (neither BL-338 nor BL-356 on-time-through triggers OTP)
    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
    // All 3 Darwin calls were made
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(3);
  });

  it('AC-5c: no path fabricates delay — no_data non-final on-time-through does not introduce a 0-delay result', async () => {
    /**
     * The 0 contributed by the non-final no_data on-time-through must never become
     * the FINAL reported delay. The final delay must always come from the last leg.
     * If the last leg is also on time, the correct result is delay_minutes:0 (real).
     * This test uses a 2-leg journey where leg-1 is no_data and leg-2 is genuinely on-time.
     */
    const mockDarwinClient = { getServiceWithStops: vi.fn() };
    const mockTiplocRepo   = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['NEWQUAY']),
    };

    const darwinLeg2OnTime: DarwinServiceWithStops = {
      rid: SEG3_BHM_NQY.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'NEWQUAY',
          scheduled_arrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
          actual_arrival:    SCHEDULED_FINAL_ARRIVAL_3LEG, // genuinely on time
          delay_minutes: 0,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops
      .mockResolvedValueOnce(DARWIN_LEG1_NO_DATA)   // leg-1: no_data → on-time-through
      .mockResolvedValueOnce(darwinLeg2OnTime);      // leg-2 (final): genuinely on time

    const walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });

    const result = await walk.calculate({
      legs: [
        {
          rid: SEG1_LDS_MAN.rid,
          originCrs: 'LDS',
          destinationCrs: 'MAN',
          scheduledDeparture: SEG1_LDS_MAN.scheduled_departure,
          scheduledArrival:   SEG1_LDS_MAN.scheduled_arrival,
          connectionThresholdMinutes: null,
        },
        {
          rid: SEG3_BHM_NQY.rid,
          originCrs: 'MAN',
          destinationCrs: 'NQY',
          scheduledDeparture: SEG3_BHM_NQY.scheduled_departure,
          scheduledArrival:   SCHEDULED_FINAL_ARRIVAL_3LEG,
          connectionThresholdMinutes: null, // FINAL leg
        },
      ],
      finalDestinationCrs: 'NQY',
      scheduledFinalArrival: SCHEDULED_FINAL_ARRIVAL_3LEG,
    });

    // Correctly on time: delay is from the FINAL leg (0), not fabricated from no_data leg
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(0);
  });
});
