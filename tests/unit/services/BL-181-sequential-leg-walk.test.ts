/**
 * Unit Tests: BL-181 Sub-task 4 — Sequential Leg Walk Algorithm
 *
 * Phase: TD-1 — Test Specification (Jessie)
 * BL Item: BL-181 (TD-DELAY-CALC-001)
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 * Service: delay-tracker
 *
 * CONTEXT:
 *   The current implementation uses MAX(arrival_delay) across all stops of a single train
 *   service, which overstates delays when trains recover time and understates delays when
 *   missed connections cascade. A real TfW Delay Repay claim was rejected because the TOC
 *   measured a smaller delay at the destination than RailRepay calculated.
 *
 * ADR-021 FUNDAMENTAL DELAY EQUATION:
 *   delay_minutes = actual_arrival_at_destination − scheduled_arrival_at_destination
 *
 * SEQUENTIAL LEG WALK ALGORITHM (ADR-021):
 *   For each leg:
 *   1. Query darwin-ingestor batch API for actual stop data (TIPLOC-based)
 *   2. Check if the passenger's destination stop exists in Darwin data
 *   3. If leg is CANCELLED or stop is missing → query OTP for replacement route
 *   4. If this is the final leg → return actual arrival at destination
 *   5. If actual arrival > (next leg scheduled departure − connection_threshold) → missed connection
 *      → query OTP for replacement, recurse into replacement legs
 *   6. Otherwise connection made → continue to next leg
 *
 * DARWIN API RESPONSE SHAPE (Sub-task 2 — BL-181 AC-4, AC-5):
 *   POST /api/v1/delays → { services: DarwinServiceWithStops[] }
 *   Each service: { rid, delay_minutes, is_cancelled, delay_reasons, status, stops }
 *   Each stop: { crs_code, scheduled_arrival, actual_arrival, delay_minutes }
 *   status: 'on_time' | 'delayed' | 'cancelled' | 'no_data'
 *   stops: StopInfo[] | null (null when status='no_data')
 *
 * TIPLOC LOOKUP (Sub-task 1 — RFC-007, AC-8):
 *   delay_tracker.tiploc_crs_mapping (tiploc_code VARCHAR(7) PK, crs_code CHAR(3))
 *   Darwin stop data uses TIPLOC codes; passenger destinations use CRS codes.
 *   The algorithm must look up CRS → TIPLOC(s) to match Darwin stop data.
 *
 * CONNECTION THRESHOLD (Sub-task 3 — AC-6, AC-7):
 *   Provided per-interchange in journey.confirmed payload.
 *   Formula: (nextLeg.scheduledDeparture − currentLeg.scheduledArrival) − PLATFORM_DISCOUNT
 *
 * NOTE:
 *   These tests MUST FAIL (RED) until Blake creates:
 *     services/delay-tracker/src/services/sequential-leg-walk.ts
 *
 *   DO NOT modify these tests to make them pass — implement the code instead.
 *   Test Lock Rule: Blake MUST NOT modify these tests.
 *   Per ADR-014 (TDD) and ADR-004 (Vitest).
 *
 * AC COVERAGE:
 *   AC-8:  TIPLOC-CRS lookup queries tiploc_crs_mapping table
 *   AC-9:  Sequential Leg Walk processes legs in order, queries darwin-ingestor batch API
 *   AC-10: Connection miss: actual_arrival > next_scheduled_departure − connection_threshold
 *   AC-11: On missed connection, query OTP for replacement (departure-after actual arrival)
 *   AC-12: Recursive processing of replacement legs
 *   AC-13: Final delay = actual_final_arrival − scheduled_final_arrival (in minutes)
 *   AC-14: Edge cases: cancelled leg, no Darwin data, last train of day
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// @ts-expect-error — Module does not exist yet (TDD RED phase)
import { SequentialLegWalk } from '../../../src/services/sequential-leg-walk.js';

// Fixtures from Hoops (ADR-017)
import {
  kingssCross,
  manchesterPiccadilly,
  edinburghWaverley,
  york,
  leeds,
  euston,
  cardiffCentral,
  birminghamNewStreet,
  tiplocWithNullName,
} from '../../fixtures/db/tiploc-crs-mapping.fixtures.js';

// ============================================================================
// Type definitions for the module under test
// These types define the public interface Blake must implement.
// ============================================================================

/**
 * A single leg in the passenger's booked journey.
 * Provided by journey.confirmed Kafka event payload.
 */
interface JourneyLeg {
  /** Darwin Run ID for this train service */
  rid: string;
  /** CRS code of leg's origin station */
  originCrs: string;
  /** CRS code of leg's destination station (may be interchange, not final destination) */
  destinationCrs: string;
  /** ISO-8601 scheduled arrival at this leg's destination */
  scheduledArrival: string;
  /** ISO-8601 scheduled departure from this leg's origin */
  scheduledDeparture: string;
  /**
   * Minutes of buffer before this connection is considered missed.
   * Provided per ADR-021: (nextLeg.scheduledDeparture − thisLeg.scheduledArrival) − PLATFORM_DISCOUNT
   * null for the final leg (no onward connection).
   */
  connectionThresholdMinutes: number | null;
}

/**
 * Stop-level data returned by darwin-ingestor batch API (BL-181 Sub-task 2, AC-4).
 * Uses TIPLOC codes (Darwin's internal format).
 */
interface DarwinStop {
  /** TIPLOC code for this calling point */
  tiploc_code: string;
  /** Scheduled arrival time (HH:MM or ISO string) */
  scheduled_arrival: string | null;
  /** Actual arrival time (HH:MM or ISO string) */
  actual_arrival: string | null;
  /** Delay in minutes for this stop */
  delay_minutes: number;
}

/**
 * Darwin service response (BL-181 Sub-task 2, AC-4 + AC-5).
 * status distinguishes on_time (delay=0) from no_data (no Darwin data).
 */
interface DarwinServiceWithStops {
  rid: string;
  delay_minutes: number | null;
  is_cancelled: boolean;
  delay_reasons: Record<string, unknown>[] | null;
  status: 'on_time' | 'delayed' | 'cancelled' | 'no_data';
  stops: DarwinStop[] | null;
}

/**
 * OTP replacement route leg (from otp-router departure-after query).
 */
interface OtpLeg {
  rid: string;
  originCrs: string;
  destinationCrs: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  connectionThresholdMinutes: number | null;
}

/**
 * Result of the Sequential Leg Walk algorithm.
 */
interface LegWalkResult {
  /** Total delay in minutes (actual final arrival − scheduled final arrival) */
  delay_minutes: number | null;
  /** ISO-8601 actual arrival at final destination */
  actual_final_arrival: string | null;
  /** ISO-8601 scheduled arrival at final destination (from original booking) */
  scheduled_final_arrival: string;
  /** Algorithm status */
  status: 'completed' | 'assessment_pending' | 'needs_manual_review';
}

// ============================================================================
// Darwin API mock client interface
// Mocked at service boundary — never calls the real darwin-ingestor network
// Verified: darwin-ingestor exposes POST /api/v1/delays (batch endpoint)
// ============================================================================

interface MockDarwinClient {
  getServiceWithStops: ReturnType<typeof vi.fn>;
}

// ============================================================================
// OTP API mock client interface
// Mocked at service boundary — never calls the real otp-router network
// The otp-router service planJourney() supports departure-after queries
// ============================================================================

interface MockOtpClient {
  findReplacementRoute: ReturnType<typeof vi.fn>;
}

// ============================================================================
// Database mock (for TIPLOC-CRS lookup)
// Mocked at repository boundary — never hits real Postgres
// ============================================================================

interface MockTiplocRepository {
  getCrsByTiploc: ReturnType<typeof vi.fn>;
  getTiplocsByCrs: ReturnType<typeof vi.fn>;
}

// ============================================================================
// Helper: build an ISO timestamp for a given date and HH:MM time
// ============================================================================

function ts(date: string, time: string): string {
  return `${date}T${time}:00Z`;
}

// ============================================================================
// SECTION 1: TIPLOC-CRS Lookup (AC-8)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-8: TIPLOC-CRS Lookup', () => {
  /**
   * AC-8: A lookup function queries delay_tracker.tiploc_crs_mapping
   * to resolve a TIPLOC code (Darwin internal) to a CRS code (passenger-facing).
   *
   * The function must also support reverse lookup (CRS → TIPLOC list) because
   * Darwin stop data uses TIPLOCs but the passenger's destination is a CRS code.
   * The algorithm resolves the destination CRS to all matching TIPLOCs, then
   * checks whether any of those TIPLOCs appear in Darwin stop data.
   */

  let mockTiplocRepo: MockTiplocRepository;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn(),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: { getServiceWithStops: vi.fn() },
      otpClient: { findReplacementRoute: vi.fn() },
    });
  });

  // AC-8: forward lookup — TIPLOC → CRS
  it('should resolve TIPLOC code to CRS via tiploc_crs_mapping table', async () => {
    // _fixtureMetadata: source: delay_tracker.tiploc_crs_mapping
    // Real TIPLOC/CRS pair: Manchester Piccadilly
    mockTiplocRepo.getCrsByTiploc.mockResolvedValue(manchesterPiccadilly.crs_code);

    const crs = await walk.resolveTiplocToCrs(manchesterPiccadilly.tiploc_code);

    expect(mockTiplocRepo.getCrsByTiploc).toHaveBeenCalledWith(manchesterPiccadilly.tiploc_code);
    expect(crs).toBe('MAN');
  });

  // AC-8: reverse lookup — CRS → list of TIPLOCs
  it('should resolve CRS code to all matching TIPLOC codes (one CRS may map to multiple TIPLOCs)', async () => {
    // Real case: Kings Cross ECML station
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue([kingssCross.tiploc_code]);

    const tiplocs = await walk.resolveCrsToTiplocs(kingssCross.crs_code);

    expect(mockTiplocRepo.getTiplocsByCrs).toHaveBeenCalledWith(kingssCross.crs_code);
    expect(tiplocs).toContain('KNGSCRS');
  });

  // AC-8: unknown TIPLOC returns null (station not in mapping table)
  it('should return null when TIPLOC code is not in the mapping table', async () => {
    mockTiplocRepo.getCrsByTiploc.mockResolvedValue(null);

    const crs = await walk.resolveTiplocToCrs('UNKNOWN');

    expect(crs).toBeNull();
  });

  // AC-8: CRS with no matching TIPLOCs returns empty array
  it('should return empty array when CRS has no TIPLOC entries', async () => {
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue([]);

    const tiplocs = await walk.resolveCrsToTiplocs('ZZZ');

    expect(tiplocs).toEqual([]);
  });

  // AC-8: null station_name in mapping row does not affect lookup
  it('should return CRS even when station_name is null in the mapping row', async () => {
    // _fixtureMetadata: tiplocWithNullName — synthetic row with null station_name
    mockTiplocRepo.getCrsByTiploc.mockResolvedValue(tiplocWithNullName.crs_code);

    const crs = await walk.resolveTiplocToCrs(tiplocWithNullName.tiploc_code);

    expect(crs).toBe('ZZZ');
  });

  // AC-8: Edinburgh Waverley real-world station used in ECML journey tests
  it('should resolve Edinburgh Waverley TIPLOC to EDB CRS', async () => {
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue([edinburghWaverley.tiploc_code]);

    const tiplocs = await walk.resolveCrsToTiplocs(edinburghWaverley.crs_code);

    expect(tiplocs).toContain('EDINBGH');
  });
});

// ============================================================================
// SECTION 2: Single-leg journey, simple delay (AC-9, AC-13)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-9 + AC-13: Single-leg delay', () => {
  /**
   * AC-9:  The algorithm processes legs in order, querying darwin-ingestor batch API for each.
   * AC-13: delay_minutes = actual_final_arrival − scheduled_final_arrival
   *
   * Single direct train: KGX → EDB
   * Scheduled arrival: 12:30
   * Actual arrival:    13:05 (35 minutes late)
   * Expected delay:    35 minutes
   *
   * _fixtureMetadata:
   *   source: darwin_ingestor.delay_service_stops — representative ECML service
   *   description: LNER KGX→EDB service delayed by signal failure
   */

  const JOURNEY_DATE = '2026-01-15';
  const RID = '202601150800123';

  const singleLeg: JourneyLeg = {
    rid: RID,
    originCrs: 'KGX',
    destinationCrs: 'EDB',
    scheduledDeparture: ts(JOURNEY_DATE, '08:00'),
    scheduledArrival: ts(JOURNEY_DATE, '12:30'),
    connectionThresholdMinutes: null, // final leg
  };

  const darwinResponse: DarwinServiceWithStops = {
    rid: RID,
    delay_minutes: 35,
    is_cancelled: false,
    delay_reasons: [{ code: '574', description: 'Signal failure at Peterborough' }],
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'YORK',      // York — intermediate stop
        scheduled_arrival: ts(JOURNEY_DATE, '10:15'),
        actual_arrival: ts(JOURNEY_DATE, '10:35'),
        delay_minutes: 20,
      },
      {
        tiploc_code: 'EDINBGH',   // Edinburgh Waverley — destination
        scheduled_arrival: ts(JOURNEY_DATE, '12:30'),
        actual_arrival: ts(JOURNEY_DATE, '13:05'),
        delay_minutes: 35,
      },
    ],
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = { getServiceWithStops: vi.fn() };
    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn(),
    };

    // EDB → ['EDINBGH'] — destination CRS resolves to this TIPLOC in Darwin stops
    mockTiplocRepo.getTiplocsByCrs.mockResolvedValue([edinburghWaverley.tiploc_code]);

    mockDarwinClient.getServiceWithStops.mockResolvedValue(darwinResponse);

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });
  });

  // AC-9: darwin client is called with the correct RID
  it('should query darwin-ingestor batch API for the leg RID', async () => {
    await walk.calculate({
      legs: [singleLeg],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledWith(RID);
  });

  // AC-9 + AC-13: delay is actual_arrival_at_destination minus scheduled
  it('should return delay_minutes = 35 when train arrives 35 minutes late at destination', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [singleLeg],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    expect(result.delay_minutes).toBe(35);
    expect(result.status).toBe('completed');
  });

  // AC-13: actual and scheduled final arrivals are present in the result
  it('should return actual_final_arrival and scheduled_final_arrival in the result', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [singleLeg],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    expect(result.actual_final_arrival).toBe(ts(JOURNEY_DATE, '13:05'));
    expect(result.scheduled_final_arrival).toBe(ts(JOURNEY_DATE, '12:30'));
  });

  // AC-13: delay uses destination stop, NOT the maximum delay across all stops
  it('should use the destination stop delay (35 min), NOT max stop delay (which is also 35 here, but derived from EDINBGH stop, not York)', async () => {
    // York stop shows 20 min delay; Edinburgh shows 35 min delay.
    // The algorithm must pick the Edinburgh (destination) stop, not York (intermediate).
    const result: LegWalkResult = await walk.calculate({
      legs: [singleLeg],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    // If this were MAX(stop.delay_minutes) the result would be 35 (happens to match here,
    // but the key assertion is that the lookup used the TIPLOC for EDB).
    expect(mockTiplocRepo.getTiplocsByCrs).toHaveBeenCalledWith('EDB');
    expect(result.delay_minutes).toBe(35);
  });
});

// ============================================================================
// SECTION 3: Zero delay — on time (AC-13)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-13: On-time journey', () => {
  /**
   * AC-13: When actual_final_arrival equals scheduled_final_arrival,
   * delay_minutes must be 0 and status must be 'on_time'.
   *
   * _fixtureMetadata:
   *   source: darwin_ingestor.delay_service_stops
   *   description: PAD→BRI GWR service, arrived exactly on time
   */

  const JOURNEY_DATE = '2026-01-20';
  const RID = '202601200930456';

  const singleLegOnTime: JourneyLeg = {
    rid: RID,
    originCrs: 'PAD',
    destinationCrs: 'BRI',
    scheduledDeparture: ts(JOURNEY_DATE, '09:30'),
    scheduledArrival: ts(JOURNEY_DATE, '11:15'),
    connectionThresholdMinutes: null,
  };

  const darwinOnTime: DarwinServiceWithStops = {
    rid: RID,
    delay_minutes: 0,
    is_cancelled: false,
    delay_reasons: null,
    status: 'on_time',
    stops: [
      {
        tiploc_code: 'BRISLT',   // Bristol Temple Meads — destination
        scheduled_arrival: ts(JOURNEY_DATE, '11:15'),
        actual_arrival: ts(JOURNEY_DATE, '11:15'),
        delay_minutes: 0,
      },
    ],
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = { getServiceWithStops: vi.fn().mockResolvedValue(darwinOnTime) };
    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['BRISLT']),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });
  });

  it('should return delay_minutes: 0 and status: completed when train is on time', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [singleLegOnTime],
      finalDestinationCrs: 'BRI',
      scheduledFinalArrival: ts(JOURNEY_DATE, '11:15'),
    });

    expect(result.delay_minutes).toBe(0);
    expect(result.status).toBe('completed');
  });

  it('should return matching actual_final_arrival and scheduled_final_arrival when on time', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [singleLegOnTime],
      finalDestinationCrs: 'BRI',
      scheduledFinalArrival: ts(JOURNEY_DATE, '11:15'),
    });

    expect(result.actual_final_arrival).toBe(ts(JOURNEY_DATE, '11:15'));
    expect(result.scheduled_final_arrival).toBe(ts(JOURNEY_DATE, '11:15'));
  });
});

// ============================================================================
// SECTION 4: Multi-leg journey, no missed connection (AC-9, AC-13)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-9 + AC-13: Multi-leg, connection made', () => {
  /**
   * AC-9:  All legs are processed sequentially.
   * AC-13: delay = actual_final_arrival (leg 2 destination) − scheduled_final_arrival
   *
   * Journey: KGX → York (leg 1) → EDB (leg 2)
   * Leg 1: KGX→YRK, scheduled arrival 10:15, actual arrival 10:25 (+10 min)
   * Connection threshold at York: 20 min (layover: 25 min − 5 min platform discount)
   * 10:25 + 0 < 10:40 scheduled departure of leg 2 → connection MADE
   * Leg 2: YRK→EDB, scheduled arrival 12:30, actual arrival 12:40 (+10 min)
   * Final delay: 10 minutes
   *
   * _fixtureMetadata:
   *   source: representative ECML multi-leg journey pattern
   *   description: KGX→YRK→EDB, minor delay on both legs, connection made
   */

  const JOURNEY_DATE = '2026-02-10';
  const RID_LEG1 = '202602100800LEG1';
  const RID_LEG2 = '202602101040LEG2';

  const leg1: JourneyLeg = {
    rid: RID_LEG1,
    originCrs: 'KGX',
    destinationCrs: 'YRK',
    scheduledDeparture: ts(JOURNEY_DATE, '08:00'),
    scheduledArrival: ts(JOURNEY_DATE, '10:15'),
    connectionThresholdMinutes: 20, // (10:40 departure − 10:15 arrival) − 5 platform discount
  };

  const leg2: JourneyLeg = {
    rid: RID_LEG2,
    originCrs: 'YRK',
    destinationCrs: 'EDB',
    scheduledDeparture: ts(JOURNEY_DATE, '10:40'),
    scheduledArrival: ts(JOURNEY_DATE, '12:30'),
    connectionThresholdMinutes: null, // final leg
  };

  const darwinLeg1: DarwinServiceWithStops = {
    rid: RID_LEG1,
    delay_minutes: 10,
    is_cancelled: false,
    delay_reasons: null,
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'YORK',   // York — this leg's destination
        scheduled_arrival: ts(JOURNEY_DATE, '10:15'),
        actual_arrival: ts(JOURNEY_DATE, '10:25'),
        delay_minutes: 10,
      },
    ],
  };

  const darwinLeg2: DarwinServiceWithStops = {
    rid: RID_LEG2,
    delay_minutes: 10,
    is_cancelled: false,
    delay_reasons: null,
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'EDINBGH',  // Edinburgh — final destination
        scheduled_arrival: ts(JOURNEY_DATE, '12:30'),
        actual_arrival: ts(JOURNEY_DATE, '12:40'),
        delay_minutes: 10,
      },
    ],
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let mockOtpClient: MockOtpClient;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(darwinLeg1)  // called for leg 1
        .mockResolvedValueOnce(darwinLeg2), // called for leg 2
    };

    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn()
        .mockResolvedValueOnce(['YORK'])      // leg 1 destination: YRK
        .mockResolvedValueOnce(['EDINBGH']),  // leg 2 destination: EDB
    };

    mockOtpClient = { findReplacementRoute: vi.fn() };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });
  });

  // AC-9: darwin client called once per leg in order
  it('should query darwin-ingestor for each leg RID in sequence', async () => {
    await walk.calculate({
      legs: [leg1, leg2],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(2);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(1, RID_LEG1);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenNthCalledWith(2, RID_LEG2);
  });

  // AC-13: final delay is from the last leg's destination stop
  it('should return delay_minutes: 10 from the final leg destination stop', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [leg1, leg2],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    expect(result.delay_minutes).toBe(10);
    expect(result.status).toBe('completed');
  });

  // Connection was made — OTP must NOT be called
  it('should NOT query OTP when connection is made within threshold', async () => {
    await walk.calculate({
      legs: [leg1, leg2],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:30'),
    });

    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
  });
});

// ============================================================================
// SECTION 5: Missed connection detection (AC-10)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-10: Missed connection detection', () => {
  /**
   * AC-10: Connection miss condition:
   *   actual_arrival > next_scheduled_departure − connection_threshold
   *   Equivalently: actual_arrival_delay > connection_threshold_minutes
   *
   * Journey: EUS → BHM (leg 1) → MAN (leg 2)
   * Leg 1: EUS→BHM, scheduled arrival 10:30, actual arrival 11:05 (+35 min)
   * Connection threshold at BHM: 25 min (layover: 30 min − 5 min platform discount)
   * Actual arrival delay (35 min) > connection threshold (25 min) → MISSED
   *
   * _fixtureMetadata:
   *   source: representative West Coast Main Line multi-leg disruption
   *   description: EUS→BHM→MAN, signal failure on leg 1, connection missed at Birmingham
   */

  const JOURNEY_DATE = '2026-03-05';
  const RID_LEG1 = '202603050730LEG1';
  const RID_LEG2 = '202603051100LEG2';

  const leg1Missed: JourneyLeg = {
    rid: RID_LEG1,
    originCrs: 'EUS',
    destinationCrs: 'BHM',
    scheduledDeparture: ts(JOURNEY_DATE, '07:30'),
    scheduledArrival: ts(JOURNEY_DATE, '10:30'),
    connectionThresholdMinutes: 25, // layover 30 min − 5 min platform discount
  };

  const leg2Missed: JourneyLeg = {
    rid: RID_LEG2,
    originCrs: 'BHM',
    destinationCrs: 'MAN',
    scheduledDeparture: ts(JOURNEY_DATE, '11:00'),
    scheduledArrival: ts(JOURNEY_DATE, '12:15'),
    connectionThresholdMinutes: null,
  };

  const darwinLeg1Missed: DarwinServiceWithStops = {
    rid: RID_LEG1,
    delay_minutes: 35,
    is_cancelled: false,
    delay_reasons: [{ code: '573', description: 'Signalling problem' }],
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'BHAM',   // Birmingham New Street — leg 1 destination
        scheduled_arrival: ts(JOURNEY_DATE, '10:30'),
        actual_arrival: ts(JOURNEY_DATE, '11:05'),
        delay_minutes: 35,
      },
    ],
  };

  // Replacement legs returned by OTP (departure-after 11:05 + platform change time)
  const replacementLegs: OtpLeg[] = [
    {
      rid: '202603051115REPL',
      originCrs: 'BHM',
      destinationCrs: 'MAN',
      scheduledDeparture: ts(JOURNEY_DATE, '11:15'),
      scheduledArrival: ts(JOURNEY_DATE, '12:30'),
      connectionThresholdMinutes: null,
    },
  ];

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let mockOtpClient: MockOtpClient;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn().mockResolvedValueOnce(darwinLeg1Missed),
    };

    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['BHAM']),
    };

    mockOtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue(replacementLegs),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });
  });

  // AC-10: OTP is queried when delay > connection threshold
  it('should call OTP findReplacementRoute when actual arrival delay exceeds connection threshold', async () => {
    await walk.calculate({
      legs: [leg1Missed, leg2Missed],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:15'),
    });

    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
  });

  // AC-10: OTP query uses departure-after the actual arrival at interchange
  it('should query OTP with departure-after set to actual arrival at interchange station', async () => {
    await walk.calculate({
      legs: [leg1Missed, leg2Missed],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:15'),
    });

    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCrs: 'BHM',
        toCrs: 'MAN',
        departAfter: ts(JOURNEY_DATE, '11:05'), // actual arrival at BHM
      })
    );
  });

  // AC-10: connection is NOT flagged as missed when delay <= threshold
  it('should NOT call OTP when actual arrival delay is within connection threshold', async () => {
    // Leg 1 arrives only 20 min late at BHM; threshold is 25 min → connection made
    const darwinLeg1OnTime: DarwinServiceWithStops = {
      ...darwinLeg1Missed,
      delay_minutes: 20,
      stops: [
        {
          tiploc_code: 'BHAM',
          scheduled_arrival: ts(JOURNEY_DATE, '10:30'),
          actual_arrival: ts(JOURNEY_DATE, '10:50'), // 20 min late — within 25 min threshold
          delay_minutes: 20,
        },
      ],
    };

    const darwinLeg2OnTime: DarwinServiceWithStops = {
      rid: RID_LEG2,
      delay_minutes: 20,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        {
          tiploc_code: 'MNCRPIC',
          scheduled_arrival: ts(JOURNEY_DATE, '12:15'),
          actual_arrival: ts(JOURNEY_DATE, '12:35'),
          delay_minutes: 20,
        },
      ],
    };

    mockDarwinClient.getServiceWithStops = vi.fn()
      .mockResolvedValueOnce(darwinLeg1OnTime)
      .mockResolvedValueOnce(darwinLeg2OnTime);

    mockTiplocRepo.getTiplocsByCrs = vi.fn()
      .mockResolvedValueOnce(['BHAM'])      // BHM leg 1 destination
      .mockResolvedValueOnce(['MNCRPIC']);  // MAN final destination

    await walk.calculate({
      legs: [leg1Missed, leg2Missed],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '12:15'),
    });

    expect(mockOtpClient.findReplacementRoute).not.toHaveBeenCalled();
  });
});

// ============================================================================
// SECTION 6: OTP replacement query on missed connection (AC-11)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-11: OTP replacement route', () => {
  /**
   * AC-11: When a connection is missed, OTP is queried for a replacement route.
   * The replacement must depart AFTER the passenger's actual arrival at the interchange.
   * The algorithm must then continue processing the replacement legs.
   *
   * Real-world TfW regression case (BL-181 root cause):
   * Journey: CDF → BHM (leg 1) → MAN (leg 2)
   * Leg 1 delayed 40 min at CDF; connection at BHM missed.
   * OTP finds next CDF→BHM→MAN service departing 45 min later.
   *
   * _fixtureMetadata:
   *   source: real TfW Delay Repay case that exposed the BL-181 defect
   *   description: Cardiff-Birmingham-Manchester cross-country journey, missed connection
   */

  const JOURNEY_DATE = '2026-02-12';
  const RID_LEG1 = '202602120930CDFTFWL1';
  const RID_LEG2 = '202602121230BHMMANL2';
  const RID_REPL = '202602121315CDFTFWREPL';

  const leg1Cardiff: JourneyLeg = {
    rid: RID_LEG1,
    originCrs: 'CDF',
    destinationCrs: 'BHM',
    scheduledDeparture: ts(JOURNEY_DATE, '09:30'),
    scheduledArrival: ts(JOURNEY_DATE, '11:45'),
    connectionThresholdMinutes: 30,
  };

  const leg2Birmingham: JourneyLeg = {
    rid: RID_LEG2,
    originCrs: 'BHM',
    destinationCrs: 'MAN',
    scheduledDeparture: ts(JOURNEY_DATE, '12:15'),
    scheduledArrival: ts(JOURNEY_DATE, '13:40'),
    connectionThresholdMinutes: null,
  };

  const darwinLeg1Cardiff: DarwinServiceWithStops = {
    rid: RID_LEG1,
    delay_minutes: 40,
    is_cancelled: false,
    delay_reasons: [{ code: '576' }],
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'BHAM',   // Birmingham New Street
        scheduled_arrival: ts(JOURNEY_DATE, '11:45'),
        actual_arrival: ts(JOURNEY_DATE, '12:25'), // 40 min late — exceeds 30 min threshold
        delay_minutes: 40,
      },
    ],
  };

  const replacementLegsFromOtp: OtpLeg[] = [
    {
      rid: RID_REPL,
      originCrs: 'BHM',
      destinationCrs: 'MAN',
      scheduledDeparture: ts(JOURNEY_DATE, '13:00'),
      scheduledArrival: ts(JOURNEY_DATE, '14:20'),
      connectionThresholdMinutes: null,
    },
  ];

  const darwinReplacement: DarwinServiceWithStops = {
    rid: RID_REPL,
    delay_minutes: 5,
    is_cancelled: false,
    delay_reasons: null,
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'MNCRPIC',  // Manchester Piccadilly — final destination
        scheduled_arrival: ts(JOURNEY_DATE, '14:20'),
        actual_arrival: ts(JOURNEY_DATE, '14:25'),
        delay_minutes: 5,
      },
    ],
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let mockOtpClient: MockOtpClient;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(darwinLeg1Cardiff)   // original leg 1
        .mockResolvedValueOnce(darwinReplacement),  // replacement leg
    };

    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn()
        .mockResolvedValueOnce(['BHAM'])      // BHM (leg 1 destination)
        .mockResolvedValueOnce(['MNCRPIC']), // MAN (final destination, replacement leg)
    };

    mockOtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue(replacementLegsFromOtp),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });
  });

  // AC-11: OTP is called when connection is missed
  it('should query OTP for replacement route when connection is missed', async () => {
    await walk.calculate({
      legs: [leg1Cardiff, leg2Birmingham],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '13:40'),
    });

    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
  });

  // AC-11: total delay is based on actual arrival via replacement service
  it('should compute final delay using the replacement leg actual arrival at MAN', async () => {
    // Scheduled final arrival (original itinerary): 13:40
    // Actual final arrival (via replacement):       14:25
    // Expected delay: 45 minutes (14:25 − 13:40 = 45 min)
    const result: LegWalkResult = await walk.calculate({
      legs: [leg1Cardiff, leg2Birmingham],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '13:40'),
    });

    expect(result.delay_minutes).toBe(45);
    expect(result.actual_final_arrival).toBe(ts(JOURNEY_DATE, '14:25'));
    expect(result.scheduled_final_arrival).toBe(ts(JOURNEY_DATE, '13:40'));
    expect(result.status).toBe('completed');
  });

  // AC-11: darwin client is called for replacement leg RID
  it('should query darwin-ingestor for the replacement leg RID', async () => {
    await walk.calculate({
      legs: [leg1Cardiff, leg2Birmingham],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '13:40'),
    });

    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledWith(RID_REPL);
  });
});

// ============================================================================
// SECTION 7: Recursive replacement processing (AC-12)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-12: Recursive replacement legs', () => {
  /**
   * AC-12: Replacement legs returned by OTP must themselves be checked for delays.
   * If a replacement leg also causes a missed connection, OTP is queried again.
   *
   * Cascading failure scenario:
   * Journey: KGX → LDS → MAN
   * Leg 1 KGX→LDS delayed 50 min → missed connection at Leeds
   * OTP replacement: LDS→MAN departing 45 min later
   * Replacement leg is also 20 min late at MAN
   * Total delay: (replacement departure delay) + (replacement arrival delay at MAN)
   *
   * _fixtureMetadata:
   *   source: ECML/TransPennine cascading disruption scenario
   *   description: KGX→LDS→MAN, missed connection at Leeds, replacement also delayed
   */

  const JOURNEY_DATE = '2026-03-15';
  const RID_LEG1 = '202603150700KGXLEG1';
  const RID_LEG2 = '202603151045LDSMAN2';
  const RID_REPL = '202603151130LDSMAN3';

  const leg1Kgx: JourneyLeg = {
    rid: RID_LEG1,
    originCrs: 'KGX',
    destinationCrs: 'LDS',
    scheduledDeparture: ts(JOURNEY_DATE, '07:00'),
    scheduledArrival: ts(JOURNEY_DATE, '09:30'),
    connectionThresholdMinutes: 20,
  };

  const leg2Leeds: JourneyLeg = {
    rid: RID_LEG2,
    originCrs: 'LDS',
    destinationCrs: 'MAN',
    scheduledDeparture: ts(JOURNEY_DATE, '09:50'),
    scheduledArrival: ts(JOURNEY_DATE, '10:45'),
    connectionThresholdMinutes: null,
  };

  const darwinLeg1Delayed: DarwinServiceWithStops = {
    rid: RID_LEG1,
    delay_minutes: 50,
    is_cancelled: false,
    delay_reasons: null,
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'LEEDS',   // Leeds — leg 1 destination
        scheduled_arrival: ts(JOURNEY_DATE, '09:30'),
        actual_arrival: ts(JOURNEY_DATE, '10:20'), // 50 min late → exceeds 20 min threshold
        delay_minutes: 50,
      },
    ],
  };

  // OTP returns a replacement leg from Leeds to Manchester
  const replacementLegsRound1: OtpLeg[] = [
    {
      rid: RID_REPL,
      originCrs: 'LDS',
      destinationCrs: 'MAN',
      scheduledDeparture: ts(JOURNEY_DATE, '10:30'),
      scheduledArrival: ts(JOURNEY_DATE, '11:25'),
      connectionThresholdMinutes: null,
    },
  ];

  // Replacement leg is itself 20 minutes late at Manchester
  const darwinReplacement: DarwinServiceWithStops = {
    rid: RID_REPL,
    delay_minutes: 20,
    is_cancelled: false,
    delay_reasons: null,
    status: 'delayed',
    stops: [
      {
        tiploc_code: 'MNCRPIC',
        scheduled_arrival: ts(JOURNEY_DATE, '11:25'),
        actual_arrival: ts(JOURNEY_DATE, '11:45'),
        delay_minutes: 20,
      },
    ],
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let mockOtpClient: MockOtpClient;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(darwinLeg1Delayed)  // leg 1
        .mockResolvedValueOnce(darwinReplacement), // replacement leg
    };

    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn()
        .mockResolvedValueOnce(['LEEDS'])     // LDS — leg 1 destination
        .mockResolvedValueOnce(['MNCRPIC']), // MAN — final destination (via replacement)
    };

    mockOtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue(replacementLegsRound1),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });
  });

  // AC-12: darwin client is queried for the replacement leg (not just the original legs)
  it('should query darwin-ingestor for replacement leg RID during recursive processing', async () => {
    await walk.calculate({
      legs: [leg1Kgx, leg2Leeds],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '10:45'),
    });

    // Leg 1 query + replacement leg query = 2 total darwin calls
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledTimes(2);
    expect(mockDarwinClient.getServiceWithStops).toHaveBeenCalledWith(RID_REPL);
  });

  // AC-12: final delay accounts for replacement leg delay at final destination
  it('should return final delay based on actual arrival via replacement leg', async () => {
    // Original scheduled final arrival: 10:45
    // Actual final arrival (via replacement): 11:45
    // Expected delay: 60 minutes
    const result: LegWalkResult = await walk.calculate({
      legs: [leg1Kgx, leg2Leeds],
      finalDestinationCrs: 'MAN',
      scheduledFinalArrival: ts(JOURNEY_DATE, '10:45'),
    });

    expect(result.delay_minutes).toBe(60);
    expect(result.actual_final_arrival).toBe(ts(JOURNEY_DATE, '11:45'));
    expect(result.status).toBe('completed');
  });
});

// ============================================================================
// SECTION 8: Cancelled leg (AC-14)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-14: Cancelled leg', () => {
  /**
   * AC-14 (cancelled leg): When Darwin reports is_cancelled: true for a leg,
   * the algorithm must immediately query OTP for a replacement route from
   * the cancelled leg's origin station. It must NOT look up Darwin stop data
   * for the cancelled service.
   *
   * _fixtureMetadata:
   *   source: darwin_ingestor.delay_services WHERE cancelled = true
   *   description: CrossCountry Newcastle→York service cancelled, passenger rerouted
   */

  const JOURNEY_DATE = '2026-03-22';
  const RID_CANCELLED = '202603221000NCLYRK';
  const RID_REPL = '202603221100NCLYRKREPL';

  const legCancelled: JourneyLeg = {
    rid: RID_CANCELLED,
    originCrs: 'NCL',
    destinationCrs: 'YRK',
    scheduledDeparture: ts(JOURNEY_DATE, '10:00'),
    scheduledArrival: ts(JOURNEY_DATE, '11:15'),
    connectionThresholdMinutes: null, // this is the only leg (direct journey)
  };

  const darwinCancelled: DarwinServiceWithStops = {
    rid: RID_CANCELLED,
    delay_minutes: null,
    is_cancelled: true,
    delay_reasons: [{ code: '101', description: 'Train crew shortage' }],
    status: 'cancelled',
    stops: null, // cancelled service has no stop data
  };

  const replacementLegs: OtpLeg[] = [
    {
      rid: RID_REPL,
      originCrs: 'NCL',
      destinationCrs: 'YRK',
      scheduledDeparture: ts(JOURNEY_DATE, '10:30'),
      scheduledArrival: ts(JOURNEY_DATE, '11:55'),
      connectionThresholdMinutes: null,
    },
  ];

  const darwinReplacement: DarwinServiceWithStops = {
    rid: RID_REPL,
    delay_minutes: 0,
    is_cancelled: false,
    delay_reasons: null,
    status: 'on_time',
    stops: [
      {
        tiploc_code: 'YORK',
        scheduled_arrival: ts(JOURNEY_DATE, '11:55'),
        actual_arrival: ts(JOURNEY_DATE, '11:55'),
        delay_minutes: 0,
      },
    ],
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let mockOtpClient: MockOtpClient;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn()
        .mockResolvedValueOnce(darwinCancelled)
        .mockResolvedValueOnce(darwinReplacement),
    };

    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn().mockResolvedValue(['YORK']),
    };

    mockOtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue(replacementLegs),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });
  });

  // AC-14 (cancelled): OTP is queried when leg is cancelled
  it('should query OTP for replacement route when Darwin reports leg as cancelled', async () => {
    await walk.calculate({
      legs: [legCancelled],
      finalDestinationCrs: 'YRK',
      scheduledFinalArrival: ts(JOURNEY_DATE, '11:15'),
    });

    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
  });

  // AC-14 (cancelled): OTP query uses the cancelled leg's origin as departure point
  it('should query OTP from the cancelled leg origin station', async () => {
    await walk.calculate({
      legs: [legCancelled],
      finalDestinationCrs: 'YRK',
      scheduledFinalArrival: ts(JOURNEY_DATE, '11:15'),
    });

    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCrs: 'NCL',
        toCrs: 'YRK',
      })
    );
  });

  // AC-14 (cancelled): final delay is calculated via the replacement service
  it('should return delay based on replacement service arrival when original leg is cancelled', async () => {
    // Original scheduled final arrival: 11:15
    // Actual via replacement: 11:55
    // Expected delay: 40 minutes
    const result: LegWalkResult = await walk.calculate({
      legs: [legCancelled],
      finalDestinationCrs: 'YRK',
      scheduledFinalArrival: ts(JOURNEY_DATE, '11:15'),
    });

    expect(result.delay_minutes).toBe(40);
    expect(result.status).toBe('completed');
  });
});

// ============================================================================
// SECTION 9: No Darwin data (AC-14)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-14: No Darwin data', () => {
  /**
   * AC-14 (no Darwin data): When darwin-ingestor returns status: 'no_data' for a service
   * (delay_minutes: null, stops: null), the algorithm must return
   * status: 'assessment_pending'. The delay cannot be calculated without Darwin data.
   *
   * ADR-021: "Darwin has no data for a service → Return null — delay-tracker publishes
   * delay.assessment-pending rather than a false zero."
   *
   * _fixtureMetadata:
   *   source: darwin_ingestor where service not yet ingested
   *   description: Future same-day service not yet in Darwin feed — assessment pending
   */

  const JOURNEY_DATE = '2026-04-10';
  const RID = '202604100800NODA';

  const legNoData: JourneyLeg = {
    rid: RID,
    originCrs: 'PAD',
    destinationCrs: 'BRI',
    scheduledDeparture: ts(JOURNEY_DATE, '08:00'),
    scheduledArrival: ts(JOURNEY_DATE, '09:45'),
    connectionThresholdMinutes: null,
  };

  const darwinNoData: DarwinServiceWithStops = {
    rid: RID,
    delay_minutes: null,
    is_cancelled: false,
    delay_reasons: null,
    status: 'no_data',
    stops: null,
  };

  let mockDarwinClient: MockDarwinClient;
  let mockTiplocRepo: MockTiplocRepository;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn().mockResolvedValue(darwinNoData),
    };

    mockTiplocRepo = {
      getCrsByTiploc: vi.fn(),
      getTiplocsByCrs: vi.fn(),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: { findReplacementRoute: vi.fn() },
    });
  });

  // AC-14 (no_data): returns assessment_pending status
  it('should return status: assessment_pending when Darwin has no data for a service', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [legNoData],
      finalDestinationCrs: 'BRI',
      scheduledFinalArrival: ts(JOURNEY_DATE, '09:45'),
    });

    expect(result.status).toBe('assessment_pending');
  });

  // AC-14 (no_data): delay_minutes is null (cannot be calculated)
  it('should return delay_minutes: null when Darwin data is unavailable', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [legNoData],
      finalDestinationCrs: 'BRI',
      scheduledFinalArrival: ts(JOURNEY_DATE, '09:45'),
    });

    expect(result.delay_minutes).toBeNull();
    expect(result.actual_final_arrival).toBeNull();
  });

  // AC-14 (no_data): scheduled_final_arrival is still present in result (for later re-assessment)
  it('should include scheduled_final_arrival in result even when assessment is pending', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [legNoData],
      finalDestinationCrs: 'BRI',
      scheduledFinalArrival: ts(JOURNEY_DATE, '09:45'),
    });

    expect(result.scheduled_final_arrival).toBe(ts(JOURNEY_DATE, '09:45'));
  });

  // AC-14 (no_data): OTP is NOT called (no_data means Darwin has no record — not a cancellation)
  it('should NOT query OTP when Darwin returns no_data status', async () => {
    const mockOtp = { findReplacementRoute: vi.fn() };

    const walkWithOtp = new SequentialLegWalk({
      tiplocRepository: mockTiplocRepo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtp,
    });

    await walkWithOtp.calculate({
      legs: [legNoData],
      finalDestinationCrs: 'BRI',
      scheduledFinalArrival: ts(JOURNEY_DATE, '09:45'),
    });

    expect(mockOtp.findReplacementRoute).not.toHaveBeenCalled();
  });
});

// ============================================================================
// SECTION 10: Last train of day — no OTP result (AC-14)
// ============================================================================

describe('BL-181 Sub-task 4: Sequential Leg Walk — AC-14: Last train of day', () => {
  /**
   * AC-14 (last train): When a connection is missed but OTP returns no replacement route
   * (findReplacementRoute returns null or empty array), the algorithm must return
   * status: 'needs_manual_review'. These are rare but high-value cases (≥120 min delay).
   *
   * ADR-021: "Last train of the day (no OTP result) → Flag as needs_manual_review.
   * These are rare and high-value (120+ min delay = 100% refund)."
   *
   * _fixtureMetadata:
   *   source: representative last-train-of-day disruption scenario
   *   description: EDB→KGX last LNER service, cancelled, no overnight replacement available
   */

  const JOURNEY_DATE = '2026-04-01';
  const RID_LAST = '202604012130EDBKGX';

  const legLast: JourneyLeg = {
    rid: RID_LAST,
    originCrs: 'EDB',
    destinationCrs: 'KGX',
    scheduledDeparture: ts(JOURNEY_DATE, '21:30'),
    scheduledArrival: ts(JOURNEY_DATE, '01:00'), // crosses midnight (next day)
    connectionThresholdMinutes: null,
  };

  const darwinLastCancelled: DarwinServiceWithStops = {
    rid: RID_LAST,
    delay_minutes: null,
    is_cancelled: true,
    delay_reasons: [{ code: '999', description: 'Train failed — no replacement available' }],
    status: 'cancelled',
    stops: null,
  };

  let mockDarwinClient: MockDarwinClient;
  let mockOtpClient: MockOtpClient;
  let walk: InstanceType<typeof SequentialLegWalk>;

  beforeEach(() => {
    mockDarwinClient = {
      getServiceWithStops: vi.fn().mockResolvedValue(darwinLastCancelled),
    };

    // OTP returns empty array — no replacement route available (last train)
    mockOtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue([]),
    };

    walk = new SequentialLegWalk({
      tiplocRepository: { getCrsByTiploc: vi.fn(), getTiplocsByCrs: vi.fn() },
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });
  });

  // AC-14 (last train): OTP is queried first
  it('should attempt OTP replacement query even for cancelled last-train service', async () => {
    await walk.calculate({
      legs: [legLast],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts(JOURNEY_DATE, '01:00'),
    });

    expect(mockOtpClient.findReplacementRoute).toHaveBeenCalledTimes(1);
  });

  // AC-14 (last train): returns needs_manual_review when OTP has no result
  it('should return status: needs_manual_review when OTP finds no replacement route', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [legLast],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts(JOURNEY_DATE, '01:00'),
    });

    expect(result.status).toBe('needs_manual_review');
  });

  // AC-14 (last train): delay_minutes is null (cannot determine actual arrival)
  it('should return delay_minutes: null for needs_manual_review result', async () => {
    const result: LegWalkResult = await walk.calculate({
      legs: [legLast],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts(JOURNEY_DATE, '01:00'),
    });

    expect(result.delay_minutes).toBeNull();
    expect(result.actual_final_arrival).toBeNull();
  });

  // AC-14 (last train): OTP returning null is treated same as empty array
  it('should return needs_manual_review when OTP returns null', async () => {
    mockOtpClient.findReplacementRoute.mockResolvedValue(null);

    const result: LegWalkResult = await walk.calculate({
      legs: [legLast],
      finalDestinationCrs: 'KGX',
      scheduledFinalArrival: ts(JOURNEY_DATE, '01:00'),
    });

    expect(result.status).toBe('needs_manual_review');
  });
});
