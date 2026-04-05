/**
 * Sequential Leg Walk Algorithm
 *
 * BL-181 Sub-task 4 — TD-DELAY-CALC-001
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 *
 * Replaces MAX(arrival_delay) with the correct fundamental delay equation:
 *   delay_minutes = actual_arrival_at_destination − scheduled_arrival_at_destination
 *
 * The algorithm walks each journey leg in order, querying Darwin for stop-level data
 * and OTP for replacement routes when connections are missed or legs are cancelled.
 */

// ---------------------------------------------------------------------------
// Public interfaces (consumed by callers and tests)
// ---------------------------------------------------------------------------

export interface JourneyLeg {
  rid: string;
  originCrs: string;
  destinationCrs: string;
  scheduledArrival: string;
  scheduledDeparture: string;
  connectionThresholdMinutes: number | null;
}

export interface DarwinStop {
  tiploc_code: string;
  scheduled_arrival: string | null;
  actual_arrival: string | null;
  delay_minutes: number;
}

export interface DarwinServiceWithStops {
  rid: string;
  delay_minutes: number | null;
  is_cancelled: boolean;
  delay_reasons: Record<string, unknown>[] | null;
  status: 'on_time' | 'delayed' | 'cancelled' | 'no_data';
  stops: DarwinStop[] | null;
}

export interface OtpLeg {
  rid: string;
  originCrs: string;
  destinationCrs: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  connectionThresholdMinutes: number | null;
}

export interface LegWalkResult {
  delay_minutes: number | null;
  actual_final_arrival: string | null;
  scheduled_final_arrival: string;
  status: 'completed' | 'assessment_pending' | 'needs_manual_review';
}

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface TiplocRepository {
  getCrsByTiploc(tiplocCode: string): Promise<string | null>;
  getTiplocsByCrs(crsCode: string): Promise<string[]>;
}

export interface DarwinClient {
  getServiceWithStops(rid: string): Promise<DarwinServiceWithStops>;
}

export interface OtpClient {
  findReplacementRoute(params: {
    fromCrs: string;
    toCrs: string;
    departAfter: string;
  }): Promise<OtpLeg[] | null>;
}

export interface SequentialLegWalkDeps {
  tiplocRepository: TiplocRepository;
  darwinClient: DarwinClient;
  otpClient: OtpClient;
}

// ---------------------------------------------------------------------------
// Calculate params
// ---------------------------------------------------------------------------

export interface CalculateParams {
  legs: JourneyLeg[];
  finalDestinationCrs: string;
  scheduledFinalArrival: string;
}

// ---------------------------------------------------------------------------
// SequentialLegWalk implementation
// ---------------------------------------------------------------------------

export class SequentialLegWalk {
  private tiplocRepository: TiplocRepository;
  private darwinClient: DarwinClient;
  private otpClient: OtpClient;

  constructor(deps: SequentialLegWalkDeps) {
    this.tiplocRepository = deps.tiplocRepository;
    this.darwinClient = deps.darwinClient;
    this.otpClient = deps.otpClient;
  }

  /**
   * AC-8: Resolve a Darwin TIPLOC code to a passenger-facing CRS code.
   * Delegates to tiploc_crs_mapping table via repository.
   */
  async resolveTiplocToCrs(tiplocCode: string): Promise<string | null> {
    return this.tiplocRepository.getCrsByTiploc(tiplocCode);
  }

  /**
   * AC-8: Resolve a CRS code to all matching TIPLOC codes.
   * A single station may have multiple TIPLOC codes (e.g. Birmingham New Street).
   */
  async resolveCrsToTiplocs(crsCode: string): Promise<string[]> {
    return this.tiplocRepository.getTiplocsByCrs(crsCode);
  }

  /**
   * AC-9 through AC-14: Core Sequential Leg Walk algorithm.
   *
   * Processes journey legs in order, querying Darwin for stop-level data and
   * OTP for replacement routes when connections are missed or legs are cancelled.
   *
   * Returns the fundamental delay equation result:
   *   delay_minutes = actual_final_arrival − scheduled_final_arrival
   */
  async calculate(params: CalculateParams): Promise<LegWalkResult> {
    const { legs, finalDestinationCrs, scheduledFinalArrival } = params;

    return this.walkLegs(legs, finalDestinationCrs, scheduledFinalArrival);
  }

  // ---------------------------------------------------------------------------
  // Private: core walk logic
  // ---------------------------------------------------------------------------

  private async walkLegs(
    legs: JourneyLeg[],
    finalDestinationCrs: string,
    scheduledFinalArrival: string,
  ): Promise<LegWalkResult> {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const isLastLeg = i === legs.length - 1;

      // AC-9: Query Darwin for this leg's stop data
      const darwinData = await this.darwinClient.getServiceWithStops(leg.rid);

      // AC-14 (no_data): Darwin has no record (or returned undefined) — cannot calculate delay
      if (!darwinData || darwinData.status === 'no_data') {
        return {
          delay_minutes: null,
          actual_final_arrival: null,
          scheduled_final_arrival: scheduledFinalArrival,
          status: 'assessment_pending',
        };
      }

      // AC-14 (cancelled): leg is cancelled — query OTP from this leg's origin
      if (darwinData.is_cancelled) {
        return this.handleCancelledOrMissed(
          leg.originCrs,
          finalDestinationCrs,
          leg.scheduledDeparture,
          scheduledFinalArrival,
        );
      }

      // Find the destination stop in Darwin data using TIPLOC reverse lookup
      const destinationTiplocs = await this.tiplocRepository.getTiplocsByCrs(leg.destinationCrs);
      const destinationStop = this.findDestinationStop(darwinData.stops, destinationTiplocs);

      if (!destinationStop || destinationStop.actual_arrival === null) {
        // Stop not found in Darwin data — treat as needing OTP replacement
        return this.handleCancelledOrMissed(
          leg.originCrs,
          finalDestinationCrs,
          leg.scheduledDeparture,
          scheduledFinalArrival,
        );
      }

      const actualArrival = destinationStop.actual_arrival;
      const stopDelayMinutes = destinationStop.delay_minutes;

      // AC-13: If this is the final leg, compute and return the result
      if (isLastLeg) {
        const delayMs =
          new Date(actualArrival).getTime() - new Date(scheduledFinalArrival).getTime();
        const delayMinutes = Math.round(delayMs / 60000);

        return {
          delay_minutes: delayMinutes,
          actual_final_arrival: actualArrival,
          scheduled_final_arrival: scheduledFinalArrival,
          status: 'completed',
        };
      }

      // AC-10: Check if the connection to the next leg is missed
      const nextLeg = legs[i + 1];
      const connectionThreshold = leg.connectionThresholdMinutes;

      if (connectionThreshold !== null && stopDelayMinutes > connectionThreshold) {
        // AC-11: Connection missed — query OTP for replacement from current destination
        return this.handleCancelledOrMissed(
          leg.destinationCrs,
          finalDestinationCrs,
          actualArrival,
          scheduledFinalArrival,
        );
      }

      // Connection made — continue to next leg (loop continues)
      void nextLeg; // next iteration of loop handles it
    }

    // Should not reach here with valid input, but guard for empty legs
    return {
      delay_minutes: null,
      actual_final_arrival: null,
      scheduled_final_arrival: scheduledFinalArrival,
      status: 'needs_manual_review',
    };
  }

  // ---------------------------------------------------------------------------
  // Private: OTP replacement handling (shared by cancelled, missed connection)
  // ---------------------------------------------------------------------------

  private async handleCancelledOrMissed(
    fromCrs: string,
    toCrs: string,
    departAfter: string,
    scheduledFinalArrival: string,
  ): Promise<LegWalkResult> {
    // AC-11 / AC-14: Query OTP for a replacement route
    const replacementLegs = await this.otpClient.findReplacementRoute({
      fromCrs,
      toCrs,
      departAfter,
    });

    // AC-14 (last train): OTP found no replacement — needs manual review
    if (!replacementLegs || replacementLegs.length === 0) {
      return {
        delay_minutes: null,
        actual_final_arrival: null,
        scheduled_final_arrival: scheduledFinalArrival,
        status: 'needs_manual_review',
      };
    }

    // AC-12: Process replacement legs recursively (they may themselves be delayed)
    return this.walkLegs(
      replacementLegs as JourneyLeg[],
      toCrs,
      scheduledFinalArrival,
    );
  }

  // ---------------------------------------------------------------------------
  // Private: find the matching Darwin stop for a destination CRS
  // ---------------------------------------------------------------------------

  private findDestinationStop(
    stops: DarwinStop[] | null,
    destinationTiplocs: string[],
  ): DarwinStop | null {
    if (!stops || stops.length === 0 || destinationTiplocs.length === 0) {
      return null;
    }

    return (
      stops.find((stop) => destinationTiplocs.includes(stop.tiploc_code)) ?? null
    );
  }
}
