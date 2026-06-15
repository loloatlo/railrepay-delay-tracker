/**
 * OtpRouterClient — real OTP HTTP client for delay-tracker
 *
 * BL-338 / TD-OTP-REPLACEMENT-001
 *
 * Implements OtpClient interface (src/services/sequential-leg-walk.ts).
 * Two-step resolve→plan: resolves CRS codes to lat/lon coords, then POSTs
 * a GraphQL plan query with coord-based from/to to otp-router.
 * Maps RAIL legs to OtpLeg[].
 *
 * Design notes:
 * - Uses native fetch (mirrors DarwinIngestorClient pattern; NOT axios — ADR compliance)
 * - Constructor takes baseUrl: string, injected via OTP_ROUTER_URL env var
 * - trip.gtfsId ("1:RID") → OtpLeg.rid via stripGtfsPrefix util
 * - originCrs/destinationCrs taken from fromCrs/toCrs query params (OTP stop gtfsIds
 *   contain TIPLOC codes, not CRS codes; caller already has the CRS)
 * - Returns null on empty itineraries, HTTP error, network error, or GraphQL errors
 *
 * TWO-STEP CONTRACT (proven by live smoke against deployed otp-router):
 *   Call 1: stop(id:"1:<fromCrs>") { gtfsId lat lon }  → resolves fromCrs coords
 *   Call 2: stop(id:"1:<toCrs>")  { gtfsId lat lon }  → resolves toCrs coords
 *   Call 3: plan(from:{lat,lon}, to:{lat,lon}, date, time) → itineraries
 *
 *   The plan call MUST use lat/lon for from/to (NOT stop:{feedId,gtfsId}).
 *   Verified live: NOT → {lat:52.9471795, lon:-1.1468881}
 *                  PLY → {lat:50.3778174, lon:-4.1433631}
 */

import type { OtpClient, OtpLeg } from '../services/sequential-leg-walk.js';
import { stripGtfsPrefix } from '../utils/strip-gtfs-prefix.js';

const STOP_RESOLVE_QUERY = `
  query ResolveStop($id: String!) {
    stop(id: $id) {
      gtfsId
      lat
      lon
    }
  }
`;

const PLAN_QUERY = `
  query PlanRoute($fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!, $date: String!, $time: String!) {
    plan(
      from: { lat: $fromLat, lon: $fromLon }
      to:   { lat: $toLat,   lon: $toLon   }
      date: $date
      time: $time
      transportModes: [{ mode: RAIL }]
      numItineraries: 5
    ) {
      itineraries {
        legs {
          mode
          from { name stop { gtfsId } }
          to   { name stop { gtfsId } }
          startTime
          endTime
          trip { gtfsId }
        }
      }
    }
  }
`;

interface StopResolveResponse {
  errors?: Array<{ message: string }>;
  data?: {
    stop?: {
      gtfsId: string;
      lat: number;
      lon: number;
    } | null;
  };
}

interface PlanResponse {
  errors?: Array<{ message: string }>;
  data?: {
    plan?: {
      itineraries: Array<{
        legs: Array<{
          mode: string;
          from: { name: string; stop: { gtfsId: string } };
          to:   { name: string; stop: { gtfsId: string } };
          startTime: number;
          endTime: number;
          trip: { gtfsId: string };
        }>;
      }>;
    };
  };
}

/**
 * Real OtpClient implementation for delay-tracker.
 * Injected via OTP_ROUTER_URL environment variable.
 *
 * Two-step: resolve CRS→coords, then plan with lat/lon.
 */
export class OtpRouterClient implements OtpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Resolve a CRS code to lat/lon coordinates via OTP stop(id:"1:<CRS>").
   * Returns null if the stop is not found, HTTP error, or GraphQL error.
   * Throws on network error (caller catches and returns null).
   */
  private async resolveStop(crs: string): Promise<{ lat: number; lon: number } | null> {
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: STOP_RESOLVE_QUERY,
        variables: { id: `1:${crs}` },
      }),
    });

    if (!response.ok) {
      return null;
    }

    const json = await response.json() as StopResolveResponse;

    // GraphQL errors in body → null
    if (json.errors && json.errors.length > 0) {
      return null;
    }

    const stop = json.data?.stop;
    if (!stop) {
      return null;
    }

    return { lat: stop.lat, lon: stop.lon };
  }

  async findReplacementRoute(params: {
    fromCrs: string;
    toCrs: string;
    departAfter: string;
  }): Promise<OtpLeg[] | null> {
    const { fromCrs, toCrs, departAfter } = params;

    // Parse departAfter ISO string into date (YYYY-MM-DD) and time (HH:MM:SS) for OTP
    const dt = new Date(departAfter);
    const date = dt.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const time = dt.toISOString().slice(11, 19); // "HH:MM:SS"

    try {
      // Step 1: Resolve fromCrs → lat/lon
      const fromCoords = await this.resolveStop(fromCrs);
      if (!fromCoords) {
        return null;
      }

      // Step 2: Resolve toCrs → lat/lon (short-circuit if fromCoords was null above)
      const toCoords = await this.resolveStop(toCrs);
      if (!toCoords) {
        return null;
      }

      // Step 3: Plan with lat/lon coords (NOT stop:{feedId,gtfsId})
      const planResponse = await fetch(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: PLAN_QUERY,
          variables: {
            fromLat: fromCoords.lat,
            fromLon: fromCoords.lon,
            toLat: toCoords.lat,
            toLon: toCoords.lon,
            date,
            time,
          },
        }),
      });

      if (!planResponse.ok) {
        return null;
      }

      const json = await planResponse.json() as PlanResponse;

      // GraphQL errors in body → null
      if (json.errors && json.errors.length > 0) {
        return null;
      }

      const itineraries = json.data?.plan?.itineraries;
      if (!itineraries || itineraries.length === 0) {
        return null;
      }

      // Map RAIL legs from first itinerary → OtpLeg[]
      const railLegs: OtpLeg[] = itineraries[0].legs
        .filter((leg) => leg.mode === 'RAIL')
        .map((leg) => {
          // trip.gtfsId is "1:RID" — strip prefix to get bare RID
          const rid = stripGtfsPrefix(leg.trip.gtfsId) as string;

          return {
            rid,
            // CRS codes: use fromCrs/toCrs from caller for the overall route.
            // Individual stop gtfsIds from OTP contain TIPLOC-based identifiers,
            // not CRS codes. The caller already has the correct CRS pair.
            originCrs: fromCrs,
            destinationCrs: toCrs,
            scheduledDeparture: new Date(leg.startTime).toISOString(),
            scheduledArrival: new Date(leg.endTime).toISOString(),
            connectionThresholdMinutes: null,
          };
        });

      return railLegs.length > 0 ? railLegs : null;
    } catch {
      // Network error or JSON parse failure → graceful degradation
      return null;
    }
  }
}
