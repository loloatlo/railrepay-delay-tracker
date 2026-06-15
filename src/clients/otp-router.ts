/**
 * OtpRouterClient — real OTP HTTP client for delay-tracker
 *
 * BL-338 / TD-OTP-REPLACEMENT-001
 *
 * Implements OtpClient interface (src/services/sequential-leg-walk.ts).
 * POSTs a GraphQL plan query to otp-router, maps RAIL legs to OtpLeg[].
 *
 * Design notes:
 * - Uses native fetch (mirrors DarwinIngestorClient pattern; NOT axios — ADR compliance)
 * - Constructor takes baseUrl: string, injected via OTP_ROUTER_URL env var
 * - trip.gtfsId ("1:RID") → OtpLeg.rid via stripGtfsPrefix util
 * - originCrs/destinationCrs taken from fromCrs/toCrs query params (OTP stop gtfsIds
 *   contain TIPLOC codes, not CRS codes; caller already has the CRS)
 * - Returns null on empty itineraries, HTTP error, network error, or GraphQL errors
 */

import type { OtpClient, OtpLeg } from '../services/sequential-leg-walk.js';
import { stripGtfsPrefix } from '../utils/strip-gtfs-prefix.js';

const PLAN_QUERY = `
  query PlanRoute($fromCrs: String!, $toCrs: String!, $date: String!, $time: String!) {
    plan(
      from: { stop: { feedId: "1", gtfsId: $fromCrs } }
      to:   { stop: { feedId: "1", gtfsId: $toCrs   } }
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

/**
 * Real OtpClient implementation for delay-tracker.
 * Injected via OTP_ROUTER_URL environment variable.
 */
export class OtpRouterClient implements OtpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
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

    const body = JSON.stringify({
      query: PLAN_QUERY,
      variables: {
        fromCrs: `1:${fromCrs}`,
        toCrs: `1:${toCrs}`,
        date,
        time,
      },
    });

    try {
      const response = await fetch(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!response.ok) {
        return null;
      }

      const json = await response.json() as {
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
      };

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
