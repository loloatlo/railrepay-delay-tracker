/**
 * Regression Tests: BL-181 (TD-DELAY-CALC-001) — Real-World Scenarios
 *
 * Phase: TD-3 — QA Sign-off (Jessie)
 * BL Item: BL-181 (TD-DELAY-CALC-001)
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 * Service: delay-tracker
 *
 * PURPOSE:
 *   These regression tests encode the specific real-world failure modes that motivated
 *   BL-181. They verify the Sequential Leg Walk algorithm produces correct output for
 *   edge-case journey patterns that the old MAX(arrival_delay) approach handled incorrectly.
 *
 * AC COVERAGE:
 *   AC-16: Real-world TfW scenario — Cardiff Central to Manchester Piccadilly,
 *          train recovers time en route; old method overstated delay.
 *   AC-17: Missed connection cascade — 3-leg journey where first leg delay causes
 *          missed connection on second, triggering OTP replacement.
 *   AC-18: Cancellation mid-journey — second leg cancelled, OTP provides replacement,
 *          total delay calculated correctly against original schedule.
 *   AC-19: Zero delay confirmation — train arrives exactly on time; system reports
 *          delay_minutes: 0 (not null).
 *
 * Test Lock Rule: Blake MUST NOT modify these tests.
 * Per ADR-014 (TDD) and ADR-004 (Vitest).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SequentialLegWalk } from '../../../src/services/sequential-leg-walk.js';

import {
  cardiffCentral,
  manchesterPiccadilly,
  birminghamNewStreet,
  kingssCross,
  leeds,
  york,
} from '../../fixtures/db/tiploc-crs-mapping.fixtures.js';

// ============================================================================
// Helper: build an ISO timestamp from a date and HH:MM time
// ============================================================================

function ts(date: string, time: string): string {
  return `${date}T${time}:00Z`;
}

// ============================================================================
// Shared mock factories
// ============================================================================

function makeMocks() {
  const mockTiplocRepo = {
    getCrsByTiploc: vi.fn(),
    getTiplocsByCrs: vi.fn(),
  };
  const mockDarwinClient = {
    getServiceWithStops: vi.fn(),
  };
  const mockOtpClient = {
    findReplacementRoute: vi.fn(),
  };
  const walk = new SequentialLegWalk({
    tiplocRepository: mockTiplocRepo,
    darwinClient: mockDarwinClient,
    otpClient: mockOtpClient,
  });
  return { mockTiplocRepo, mockDarwinClient, mockOtpClient, walk };
}

// ============================================================================
// AC-16: Real-world TfW regression — train recovers time
//
// Scenario: Cardiff Central → (change Birmingham) → Manchester Piccadilly
//   Leg 1: Cardiff → Birmingham. Train departs late but recovers time.
//          Darwin reports MAX stop delay = 22 min; actual arrival at Birmingham = 18 min late.
//   Leg 2: Birmingham → Manchester. Train on time. Arrives on schedule.
//
// Old method: MAX(arrival_delay) = 22 → overstates delay.
// Correct method (ADR-021): actual_final_arrival − scheduled_final_arrival = 0 min.
//   (Passenger made the connection and the second train was on time.)
// ============================================================================

describe('BL-181 AC-16: TfW regression — train recovers time en route', () => {
  /**
   * _fixtureMetadata: source: delay_tracker.tiploc_crs_mapping
   * Stations: Cardiff Central (CDF/CARDIFF), Birmingham New Street (BHM/BHAM),
   *           Manchester Piccadilly (MAN/MNCRPIC)
   */

  const TRAVEL_DATE = '2026-03-15';

  // Leg 1: Cardiff → Birmingham New Street (TfW service)
  const leg1: {
    rid: string;
    originCrs: string;
    destinationCrs: string;
    scheduledArrival: string;
    scheduledDeparture: string;
    connectionThresholdMinutes: number;
  } = {
    rid: 'TFW202603150800',
    originCrs: cardiffCentral.crs_code,       // CDF
    destinationCrs: birminghamNewStreet.crs_code, // BHM
    scheduledDeparture: ts(TRAVEL_DATE, '08:00'),
    scheduledArrival: ts(TRAVEL_DATE, '10:00'),
    connectionThresholdMinutes: 7, // (10:10 next leg departure − 10:00 arrival) − 3 min platform discount
  };

  // Leg 2: Birmingham New Street → Manchester Piccadilly (CrossCountry)
  const leg2: {
    rid: string;
    originCrs: string;
    destinationCrs: string;
    scheduledArrival: string;
    scheduledDeparture: string;
    connectionThresholdMinutes: null;
  } = {
    rid: 'XC202603151010',
    originCrs: birminghamNewStreet.crs_code,  // BHM
    destinationCrs: manchesterPiccadilly.crs_code, // MAN
    scheduledDeparture: ts(TRAVEL_DATE, '10:10'),
    scheduledArrival: ts(TRAVEL_DATE, '11:45'),
    connectionThresholdMinutes: null, // Final leg
  };

  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();

    // TIPLOC reverse lookups
    mocks.mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === birminghamNewStreet.crs_code) return [birminghamNewStreet.tiploc_code]; // BHAM
      if (crs === manchesterPiccadilly.crs_code) return [manchesterPiccadilly.tiploc_code]; // MNCRPIC
      return [];
    });
  });

  it('AC-16: should calculate delay as 0 when train recovers time and final leg is on time', async () => {
    // Leg 1: Train departs late, has a MAX stop delay of 22 min at one point,
    //        BUT recovers time and arrives at Birmingham only 8 minutes late.
    //        Actual arrival: 10:08 — within the 7-minute connection threshold? NO — 8 > 7.
    //        Wait: connection threshold is 7 min. 8 min delay > 7 min threshold.
    //        BUT: scheduled departure of leg 2 is 10:10. Actual arrival 10:08 < 10:10, so
    //        connection IS made (actual_arrival earlier than next departure).
    //        The test verifies the algorithm uses actual_arrival (10:08) vs threshold,
    //        not MAX stop delay (22 min).
    //
    //        Restate: stopDelayMinutes for Birmingham stop = 8 (the actual delay AT the destination stop).
    //        Connection threshold = 7. 8 > 7: connection IS missed per threshold logic.
    //        This triggers OTP. OTP finds leg 2 (same train, or fast connection).
    //        Final arrival at MAN = 11:45 (on schedule).

    // Arrange: Darwin leg 1 — MAX stop delay was 22 min at an intermediate stop,
    //          but actual arrival at Birmingham = 10:08 (8 min late, stopDelayMinutes=8)
    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 22, // MAX stop delay (the old metric — overstates)
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: [
            {
              tiploc_code: 'CARDIFF',
              scheduled_arrival: null,
              actual_arrival: null,
              delay_minutes: 0, // departure point
            },
            {
              tiploc_code: 'PONTYPL', // intermediate stop — high delay point
              scheduled_arrival: ts(TRAVEL_DATE, '08:45'),
              actual_arrival: ts(TRAVEL_DATE, '09:07'), // 22 min late
              delay_minutes: 22,
            },
            {
              tiploc_code: birminghamNewStreet.tiploc_code, // BHAM — destination
              scheduled_arrival: ts(TRAVEL_DATE, '10:00'),
              actual_arrival: ts(TRAVEL_DATE, '10:08'), // only 8 min late — train recovered time
              delay_minutes: 8, // AC-16 key: stop delay at destination is 8, not 22
            },
          ],
        };
      }
      // Leg 2: on time
      if (rid === leg2.rid) {
        return {
          rid: leg2.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: birminghamNewStreet.tiploc_code,
              scheduled_arrival: null,
              actual_arrival: null,
              delay_minutes: 0,
            },
            {
              tiploc_code: manchesterPiccadilly.tiploc_code, // MNCRPIC
              scheduled_arrival: ts(TRAVEL_DATE, '11:45'),
              actual_arrival: ts(TRAVEL_DATE, '11:45'), // On time
              delay_minutes: 0,
            },
          ],
        };
      }
      return { rid, delay_minutes: null, is_cancelled: false, delay_reasons: null, status: 'no_data', stops: null };
    });

    // Leg 1 stopDelayMinutes=8 > connectionThreshold=7: missed connection.
    // OTP returns leg 2 (departure from Birmingham at 10:10, arrives MAN 11:45 on time).
    mocks.mockOtpClient.findReplacementRoute.mockResolvedValue([
      {
        rid: leg2.rid,
        originCrs: birminghamNewStreet.crs_code,
        destinationCrs: manchesterPiccadilly.crs_code,
        scheduledDeparture: ts(TRAVEL_DATE, '10:10'),
        scheduledArrival: ts(TRAVEL_DATE, '11:45'),
        connectionThresholdMinutes: null,
      },
    ]);

    // Act
    const result = await mocks.walk.calculate({
      legs: [leg1, leg2],
      finalDestinationCrs: manchesterPiccadilly.crs_code,
      scheduledFinalArrival: ts(TRAVEL_DATE, '11:45'),
    });

    // Assert — AC-16: final delay is 0 min (arrived on time at Manchester)
    // The old MAX(arrival_delay) would have returned 22 (from the intermediate stop).
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(0);
    expect(result.actual_final_arrival).toBe(ts(TRAVEL_DATE, '11:45'));
    expect(result.scheduled_final_arrival).toBe(ts(TRAVEL_DATE, '11:45'));
  });

  it('AC-16: should detect delay when train only partially recovers time (final leg late)', async () => {
    // Leg 1: MAX stop delay 22 min, recovers to 18 min at Birmingham. Misses connection.
    // OTP replacement arrives MAN 35 min late.
    // AC-16: Correct delay = 35 min (NOT 22 from MAX stop delay)
    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 22, // MAX stop delay — old method would return this incorrectly
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: [
            {
              tiploc_code: birminghamNewStreet.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '10:00'),
              actual_arrival: ts(TRAVEL_DATE, '10:18'), // 18 min late — exceeds 7 min threshold
              delay_minutes: 18,
            },
          ],
        };
      }
      // Replacement leg: arrives MAN 35 min late (12:20 vs scheduled 11:45)
      if (rid === 'XC202603151040') {
        return {
          rid: 'XC202603151040',
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: manchesterPiccadilly.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '12:20'),
              actual_arrival: ts(TRAVEL_DATE, '12:20'),
              delay_minutes: 0,
            },
          ],
        };
      }
      return { rid, delay_minutes: null, is_cancelled: false, delay_reasons: null, status: 'no_data', stops: null };
    });

    mocks.mockOtpClient.findReplacementRoute.mockResolvedValue([
      {
        rid: 'XC202603151040',
        originCrs: birminghamNewStreet.crs_code,
        destinationCrs: manchesterPiccadilly.crs_code,
        scheduledDeparture: ts(TRAVEL_DATE, '10:40'),
        scheduledArrival: ts(TRAVEL_DATE, '12:20'), // 35 min after scheduled 11:45
        connectionThresholdMinutes: null,
      },
    ]);

    const result = await mocks.walk.calculate({
      legs: [leg1, leg2],
      finalDestinationCrs: manchesterPiccadilly.crs_code,
      scheduledFinalArrival: ts(TRAVEL_DATE, '11:45'),
    });

    // Assert: delay is 35 min (12:20 − 11:45), not 22 (MAX stop delay)
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(35);
  });
});

// ============================================================================
// AC-17: Missed connection cascade — 3-leg journey
//
// Scenario: London Kings Cross → York → Leeds → (final destination)
//   Leg 1: KGX → York. On time.
//   Leg 2: York → Leeds. 45 min delay — causes missed connection.
//   Leg 3: Leeds → final destination. Scheduled. OTP finds a later train.
//
// The cascade means the delay compounds: the OTP replacement from Leeds
// departs 50 min after original schedule, arriving proportionally late.
// ============================================================================

describe('BL-181 AC-17: Missed connection cascade — 3-leg journey', () => {
  /**
   * _fixtureMetadata: source: delay_tracker.tiploc_crs_mapping
   * Stations: KGX/KNGSCRS, YRK/YORK, LDS/LEEDS
   */

  const TRAVEL_DATE = '2026-03-20';
  const FINAL_DEST = 'HGT'; // Harrogate (fictional final destination beyond Leeds)
  const FINAL_DEST_TIPLOC = 'HGRATE';

  const leg1 = {
    rid: 'GR202603200900',
    originCrs: kingssCross.crs_code,
    destinationCrs: york.crs_code,
    scheduledDeparture: ts(TRAVEL_DATE, '09:00'),
    scheduledArrival: ts(TRAVEL_DATE, '11:00'),
    connectionThresholdMinutes: 12, // 11:15 − 11:00 − 3 = 12
  };

  const leg2 = {
    rid: 'TP202603201115',
    originCrs: york.crs_code,
    destinationCrs: leeds.crs_code,
    scheduledDeparture: ts(TRAVEL_DATE, '11:15'),
    scheduledArrival: ts(TRAVEL_DATE, '11:45'),
    connectionThresholdMinutes: 7, // 11:55 − 11:45 − 3 = 7
  };

  const leg3 = {
    rid: 'NT202603201155',
    originCrs: leeds.crs_code,
    destinationCrs: FINAL_DEST,
    scheduledDeparture: ts(TRAVEL_DATE, '11:55'),
    scheduledArrival: ts(TRAVEL_DATE, '12:20'),
    connectionThresholdMinutes: null,
  };

  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();

    mocks.mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === york.crs_code) return [york.tiploc_code];
      if (crs === leeds.crs_code) return [leeds.tiploc_code];
      if (crs === FINAL_DEST) return [FINAL_DEST_TIPLOC];
      return [];
    });
  });

  it('AC-17: should detect missed connection on leg 2 and route via OTP replacement for leg 3', async () => {
    // Leg 1: on time, arrives York 11:00
    // Leg 2: 45 min delay — arrives Leeds 12:30 (far exceeds 7 min threshold)
    // OTP replacement from Leeds departs 12:35, arrives final dest 13:00

    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: york.tiploc_code, // YORK
              scheduled_arrival: ts(TRAVEL_DATE, '11:00'),
              actual_arrival: ts(TRAVEL_DATE, '11:00'),
              delay_minutes: 0,
            },
          ],
        };
      }
      if (rid === leg2.rid) {
        return {
          rid: leg2.rid,
          delay_minutes: 45,
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: [
            {
              tiploc_code: leeds.tiploc_code, // LEEDS
              scheduled_arrival: ts(TRAVEL_DATE, '11:45'),
              actual_arrival: ts(TRAVEL_DATE, '12:30'), // 45 min late — misses 7 min threshold
              delay_minutes: 45,
            },
          ],
        };
      }
      // Replacement leg arrives final dest at 13:00
      if (rid === 'NT202603201235') {
        return {
          rid: 'NT202603201235',
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: FINAL_DEST_TIPLOC,
              scheduled_arrival: ts(TRAVEL_DATE, '13:00'),
              actual_arrival: ts(TRAVEL_DATE, '13:00'),
              delay_minutes: 0,
            },
          ],
        };
      }
      return { rid, delay_minutes: null, is_cancelled: false, delay_reasons: null, status: 'no_data', stops: null };
    });

    // OTP replacement from Leeds (after 12:30 actual arrival) → departs 12:35, arrives 13:00
    mocks.mockOtpClient.findReplacementRoute.mockResolvedValue([
      {
        rid: 'NT202603201235',
        originCrs: leeds.crs_code,
        destinationCrs: FINAL_DEST,
        scheduledDeparture: ts(TRAVEL_DATE, '12:35'),
        scheduledArrival: ts(TRAVEL_DATE, '13:00'),
        connectionThresholdMinutes: null,
      },
    ]);

    const result = await mocks.walk.calculate({
      legs: [leg1, leg2, leg3],
      finalDestinationCrs: FINAL_DEST,
      scheduledFinalArrival: ts(TRAVEL_DATE, '12:20'),
    });

    // Assert: delay = 13:00 − 12:20 = 40 min
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(40);
    expect(result.actual_final_arrival).toBe(ts(TRAVEL_DATE, '13:00'));
    expect(result.scheduled_final_arrival).toBe(ts(TRAVEL_DATE, '12:20'));
  });

  it('AC-17: should return needs_manual_review when OTP finds no replacement after cascade', async () => {
    // Leg 1 on time, Leg 2 badly delayed (45 min), OTP finds nothing (last train of day)
    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: york.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '11:00'),
              actual_arrival: ts(TRAVEL_DATE, '11:00'),
              delay_minutes: 0,
            },
          ],
        };
      }
      if (rid === leg2.rid) {
        return {
          rid: leg2.rid,
          delay_minutes: 45,
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: [
            {
              tiploc_code: leeds.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '11:45'),
              actual_arrival: ts(TRAVEL_DATE, '12:30'),
              delay_minutes: 45,
            },
          ],
        };
      }
      return { rid, delay_minutes: null, is_cancelled: false, delay_reasons: null, status: 'no_data', stops: null };
    });

    // OTP: no replacement available (last train has gone)
    mocks.mockOtpClient.findReplacementRoute.mockResolvedValue(null);

    const result = await mocks.walk.calculate({
      legs: [leg1, leg2, leg3],
      finalDestinationCrs: FINAL_DEST,
      scheduledFinalArrival: ts(TRAVEL_DATE, '12:20'),
    });

    // Assert: needs manual review — no OTP replacement found
    expect(result.status).toBe('needs_manual_review');
    expect(result.delay_minutes).toBeNull();
    expect(result.actual_final_arrival).toBeNull();
  });
});

// ============================================================================
// AC-18: Cancellation mid-journey — second leg cancelled, OTP replaces
//
// Scenario: London Kings Cross → York (leg 1 on time) then York → Leeds (leg 2 CANCELLED).
//   OTP finds replacement train York → Leeds departing 1 hour later.
//   Final delay = time difference between original and replacement arrival.
// ============================================================================

describe('BL-181 AC-18: Cancellation mid-journey — OTP replacement', () => {
  /**
   * _fixtureMetadata: source: delay_tracker.tiploc_crs_mapping
   * Stations: KGX/KNGSCRS, YRK/YORK, LDS/LEEDS
   */

  const TRAVEL_DATE = '2026-03-22';

  const leg1 = {
    rid: 'GR202603220800',
    originCrs: kingssCross.crs_code,
    destinationCrs: york.crs_code,
    scheduledDeparture: ts(TRAVEL_DATE, '08:00'),
    scheduledArrival: ts(TRAVEL_DATE, '10:00'),
    connectionThresholdMinutes: 10,
  };

  const leg2Cancelled = {
    rid: 'TP202603221015',
    originCrs: york.crs_code,
    destinationCrs: leeds.crs_code,
    scheduledDeparture: ts(TRAVEL_DATE, '10:15'),
    scheduledArrival: ts(TRAVEL_DATE, '10:45'),
    connectionThresholdMinutes: null, // final leg (before cancellation discovered)
  };

  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();

    mocks.mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === york.crs_code) return [york.tiploc_code];
      if (crs === leeds.crs_code) return [leeds.tiploc_code];
      return [];
    });
  });

  it('AC-18: should query OTP when second leg is cancelled and calculate delay from replacement', async () => {
    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: york.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '10:00'),
              actual_arrival: ts(TRAVEL_DATE, '10:00'),
              delay_minutes: 0,
            },
          ],
        };
      }
      if (rid === leg2Cancelled.rid) {
        return {
          rid: leg2Cancelled.rid,
          delay_minutes: null,
          is_cancelled: true, // AC-18 key: CANCELLED
          delay_reasons: [{ reason: 'operational' }],
          status: 'cancelled',
          stops: null,
        };
      }
      // Replacement leg — on time
      if (rid === 'TP202603221115') {
        return {
          rid: 'TP202603221115',
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: leeds.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '11:45'),
              actual_arrival: ts(TRAVEL_DATE, '11:45'),
              delay_minutes: 0,
            },
          ],
        };
      }
      return { rid, delay_minutes: null, is_cancelled: false, delay_reasons: null, status: 'no_data', stops: null };
    });

    // OTP replacement: next available train from York to Leeds, departs 11:15, arrives 11:45
    mocks.mockOtpClient.findReplacementRoute.mockResolvedValue([
      {
        rid: 'TP202603221115',
        originCrs: york.crs_code,
        destinationCrs: leeds.crs_code,
        scheduledDeparture: ts(TRAVEL_DATE, '11:15'),
        scheduledArrival: ts(TRAVEL_DATE, '11:45'),
        connectionThresholdMinutes: null,
      },
    ]);

    const result = await mocks.walk.calculate({
      legs: [leg1, leg2Cancelled],
      finalDestinationCrs: leeds.crs_code,
      scheduledFinalArrival: ts(TRAVEL_DATE, '10:45'),
    });

    // Assert: delay = 11:45 − 10:45 = 60 min
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(60);
    expect(result.actual_final_arrival).toBe(ts(TRAVEL_DATE, '11:45'));
    expect(result.scheduled_final_arrival).toBe(ts(TRAVEL_DATE, '10:45'));

    // Verify OTP was called for the cancelled leg (from York's origin, not Birmingham)
    expect(mocks.mockOtpClient.findReplacementRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCrs: york.crs_code, // OTP query starts from York (leg 2 origin)
        toCrs: leeds.crs_code,
      }),
    );
  });

  it('AC-18: should return needs_manual_review when OTP finds no replacement for cancelled leg', async () => {
    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: york.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '10:00'),
              actual_arrival: ts(TRAVEL_DATE, '10:00'),
              delay_minutes: 0,
            },
          ],
        };
      }
      return {
        rid,
        delay_minutes: null,
        is_cancelled: true,
        delay_reasons: null,
        status: 'cancelled',
        stops: null,
      };
    });

    mocks.mockOtpClient.findReplacementRoute.mockResolvedValue([]);

    const result = await mocks.walk.calculate({
      legs: [leg1, leg2Cancelled],
      finalDestinationCrs: leeds.crs_code,
      scheduledFinalArrival: ts(TRAVEL_DATE, '10:45'),
    });

    expect(result.status).toBe('needs_manual_review');
    expect(result.delay_minutes).toBeNull();
  });
});

// ============================================================================
// AC-19: Zero delay confirmation — train arrives exactly on time
//
// The system MUST report delay_minutes: 0 (an integer), NOT null.
// null means "unknown / assessment pending"; 0 means "confirmed on time".
// This distinction is critical for the downstream eligibility engine.
// ============================================================================

describe('BL-181 AC-19: Zero delay — train arrives exactly on time', () => {
  /**
   * _fixtureMetadata: source: delay_tracker.tiploc_crs_mapping
   * Stations: KGX/KNGSCRS, EDB/EDINBGH
   */

  const TRAVEL_DATE = '2026-03-25';

  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
  });

  it('AC-19: should return delay_minutes: 0 (not null) when single-leg journey is exactly on time', async () => {
    // Arrange: single leg KGX → Edinburgh Waverley, arrives exactly on schedule
    const leg = {
      rid: 'LR202603250530',
      originCrs: kingssCross.crs_code,
      destinationCrs: 'EDB', // Edinburgh Waverley
      scheduledDeparture: ts(TRAVEL_DATE, '05:30'),
      scheduledArrival: ts(TRAVEL_DATE, '09:30'),
      connectionThresholdMinutes: null,
    };

    mocks.mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['EDINBGH']);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: leg.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time', // AC-5 disambiguation: status='on_time' means genuinely on time
      stops: [
        {
          tiploc_code: 'EDINBGH',
          scheduled_arrival: ts(TRAVEL_DATE, '09:30'),
          actual_arrival: ts(TRAVEL_DATE, '09:30'), // Exactly on time
          delay_minutes: 0,
        },
      ],
    });

    const result = await mocks.walk.calculate({
      legs: [leg],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(TRAVEL_DATE, '09:30'),
    });

    // Assert: delay_minutes is 0 (integer), NOT null
    // This is the AC-19 guarantee — 0 and null are semantically different.
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(0);                    // Must be 0, not null
    expect(result.delay_minutes).not.toBeNull();              // Explicit null guard
    expect(result.actual_final_arrival).toBe(ts(TRAVEL_DATE, '09:30'));
  });

  it('AC-19: should return delay_minutes: 0 when multi-leg journey completes exactly on time', async () => {
    // Two-leg journey, both on time — final result must be 0, not null
    const leg1 = {
      rid: 'LR202603250530',
      originCrs: kingssCross.crs_code,
      destinationCrs: york.crs_code,
      scheduledDeparture: ts(TRAVEL_DATE, '05:30'),
      scheduledArrival: ts(TRAVEL_DATE, '07:30'),
      connectionThresholdMinutes: 5, // 07:35 − 07:30 − 0 (no discount in this test)
    };
    const leg2 = {
      rid: 'TP202603250735',
      originCrs: york.crs_code,
      destinationCrs: leeds.crs_code,
      scheduledDeparture: ts(TRAVEL_DATE, '07:35'),
      scheduledArrival: ts(TRAVEL_DATE, '08:00'),
      connectionThresholdMinutes: null,
    };

    mocks.mockTiplocRepo.getTiplocsByCrs.mockImplementation(async (crs: string) => {
      if (crs === york.crs_code) return [york.tiploc_code];
      if (crs === leeds.crs_code) return [leeds.tiploc_code];
      return [];
    });

    mocks.mockDarwinClient.getServiceWithStops.mockImplementation(async (rid: string) => {
      if (rid === leg1.rid) {
        return {
          rid: leg1.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: york.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '07:30'),
              actual_arrival: ts(TRAVEL_DATE, '07:30'),
              delay_minutes: 0, // 0 <= 5 threshold: connection made
            },
          ],
        };
      }
      if (rid === leg2.rid) {
        return {
          rid: leg2.rid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
          status: 'on_time',
          stops: [
            {
              tiploc_code: leeds.tiploc_code,
              scheduled_arrival: ts(TRAVEL_DATE, '08:00'),
              actual_arrival: ts(TRAVEL_DATE, '08:00'),
              delay_minutes: 0,
            },
          ],
        };
      }
      return { rid, delay_minutes: null, is_cancelled: false, delay_reasons: null, status: 'no_data', stops: null };
    });

    const result = await mocks.walk.calculate({
      legs: [leg1, leg2],
      finalDestinationCrs: leeds.crs_code,
      scheduledFinalArrival: ts(TRAVEL_DATE, '08:00'),
    });

    expect(result.status).toBe('completed');
    expect(result.delay_minutes).toBe(0);
    expect(result.delay_minutes).not.toBeNull();
  });

  it('AC-19: should return delay_minutes: 0 when train arrives 30 seconds early (rounds to 0)', async () => {
    // Train arrives 30 seconds before scheduled time — Math.round(−0.5) = 0
    const leg = {
      rid: 'LR202603250700',
      originCrs: kingssCross.crs_code,
      destinationCrs: 'EDB',
      scheduledDeparture: ts(TRAVEL_DATE, '07:00'),
      scheduledArrival: ts(TRAVEL_DATE, '11:00'),
      connectionThresholdMinutes: null,
    };

    mocks.mockTiplocRepo.getTiplocsByCrs.mockResolvedValue(['EDINBGH']);

    mocks.mockDarwinClient.getServiceWithStops.mockResolvedValue({
      rid: leg.rid,
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [
        {
          tiploc_code: 'EDINBGH',
          scheduled_arrival: ts(TRAVEL_DATE, '11:00'),
          actual_arrival: '2026-03-25T10:59:30Z', // 30 seconds early
          delay_minutes: 0,
        },
      ],
    });

    const result = await mocks.walk.calculate({
      legs: [leg],
      finalDestinationCrs: 'EDB',
      scheduledFinalArrival: ts(TRAVEL_DATE, '11:00'),
    });

    // Math.round(-0.5 min) may produce -0 in JavaScript.
    // Both -0 and +0 represent "no delay" — either is acceptable.
    // The critical AC-19 assertion is that the value is NOT null (not "unknown").
    expect(result.status).toBe('completed');
    expect(result.delay_minutes).not.toBeNull();              // Must not be null (AC-19)
    expect(Math.abs(result.delay_minutes as number)).toBe(0); // Must represent zero delay
  });
});
