/**
 * BL-338 AC-1: OtpRouterClient — unit tests for the real OTP HTTP client
 *
 * AC-1: Real OtpClient — interface-based unit tests: CRS→plan query against a
 * MOCKED otp-router HTTP layer, OTP itinerary→OtpLeg[] mapping,
 * trip.gtfsId("1:RID")→rid strip, null on no-route, timeout/error handling.
 *
 * WHY THIS FILE IS SEPARATE:
 *   This file imports src/clients/otp-router.ts which does NOT exist yet (TDD RED).
 *   Vitest fails at module-load time when an import target is absent — this would
 *   kill the ENTIRE test suite if placed in the main BL-338 file.
 *   By isolating the module-load RED here, AC-2 through AC-8 (in the main file)
 *   can load and fail for BEHAVIORAL reasons, not import errors.
 *
 * SOP-IMPROVEMENT-011: raw OTP response strings (un-stripped gtfsId) are fed
 * directly into the client to verify the client strips them correctly at the
 * classification boundary.
 *
 * Test Lock Rule: Blake MUST NOT modify this file. If a test needs to change,
 * Blake hands back to Jessie with explanation.
 */

// @ts-expect-error — src/clients/otp-router.ts does not exist yet (TDD RED)
// Blake must create this file to make these tests GREEN.
import { OtpRouterClient } from '../../../src/clients/otp-router.js';
import type { OtpClient, OtpLeg } from '../../../src/services/sequential-leg-walk.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────────────
// Shared setup
// ───────────────────────────────────────────────────────────────────────────────

const OTP_URL = 'http://otp-router-test:8080';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as typeof fetch;
  process.env.OTP_ROUTER_URL = OTP_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OTP_ROUTER_URL;
});

// ───────────────────────────────────────────────────────────────────────────────
// Helper: build a raw OTP plan response
// ───────────────────────────────────────────────────────────────────────────────

function makeOtpPlan(legs: Array<{
  mode: string;
  fromGtfsId: string;
  toGtfsId: string;
  startTime: number;
  endTime: number;
  tripGtfsId: string;
}>) {
  return {
    data: {
      plan: {
        itineraries: legs.length === 0 ? [] : [
          {
            legs: legs.map((l) => ({
              mode: l.mode,
              from: { name: 'stop', stop: { gtfsId: l.fromGtfsId } },
              to:   { name: 'stop', stop: { gtfsId: l.toGtfsId   } },
              startTime: l.startTime,
              endTime:   l.endTime,
              trip: { gtfsId: l.tripGtfsId },
            })),
          },
        ],
      },
    },
  };
}

function mockOk(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => body,
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// AC-1 tests
// ───────────────────────────────────────────────────────────────────────────────

describe('BL-338 AC-1: OtpRouterClient — real OTP HTTP client', () => {
  /**
   * Verified: OtpRouterClient must implement OtpClient interface:
   *   findReplacementRoute({fromCrs, toCrs, departAfter}): Promise<OtpLeg[] | null>
   *
   * HTTP layer mocked via globalThis.fetch = vi.fn() (native fetch pattern,
   * mirrors DarwinIngestorClient, NOT axios — see BL-338 spec §Change-2 constraint).
   *
   * Endpoint mocked: POST ${OTP_ROUTER_URL}/graphql
   */

  // AC-1a: Successful single RAIL leg → OtpLeg[] with correct field mapping

  it('AC-1a: should return OtpLeg[] when otp-router returns a valid plan with a RAIL itinerary', async () => {
    // SOP-011: raw gtfsId strings as otp-router actually returns them (un-stripped)
    mockOk(makeOtpPlan([{
      mode: 'RAIL',
      fromGtfsId: '1:DRBY',    // raw — client must strip to CRS
      toGtfsId:   '1:PLYMTH',  // raw — client must strip to CRS
      startTime:  1781377740000,   // 2026-06-13T19:09:00.000Z (self-fix: was 1749844140000 = 2025-06-13)
      endTime:    1781390880000,   // 2026-06-13T22:48:00.000Z (self-fix: was 1749859680000 = 2025-06-14)
      tripGtfsId: '1:202606137101164', // raw "1:RID" → must become RID
    }]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'DBY',
      toCrs: 'PLY',
      departAfter: '2026-06-13T19:09:00Z',
    });

    expect(legs).not.toBeNull();
    expect(Array.isArray(legs)).toBe(true);
    expect((legs as OtpLeg[]).length).toBeGreaterThan(0);

    const leg = (legs as OtpLeg[])[0];
    // Key assertion: trip.gtfsId "1:202606137101164" → rid "202606137101164"
    expect(leg.rid).toBe('202606137101164');
    expect(leg.originCrs).toBe('DBY');
    expect(leg.destinationCrs).toBe('PLY');
    // Scheduled times should be ISO strings derived from epoch ms
    expect(leg.scheduledDeparture).toMatch(/2026-06-13/);
    expect(leg.scheduledArrival).toMatch(/2026-06-13/);
  });

  // AC-1b: SOP-011 — raw "1:RID" prefix must be stripped from trip.gtfsId → OtpLeg.rid

  it('AC-1b (SOP-011): should strip "1:" prefix from trip.gtfsId when mapping to OtpLeg.rid', async () => {
    // Feed raw "1:RID" — the client must produce a bare RID with no prefix
    mockOk(makeOtpPlan([{
      mode: 'RAIL',
      fromGtfsId: '1:NTNBSH',
      toGtfsId:   '1:DRBY',
      startTime:  1749829020000,
      endTime:    1749831960000,
      tripGtfsId: '1:202606136721613', // MUST become '202606136721613'
    }]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'DBY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).not.toBeNull();
    const rid = (legs as OtpLeg[])[0].rid;
    // Must NOT contain the "1:" prefix
    expect(rid).toBe('202606136721613');
    expect(rid).not.toContain('1:');
  });

  // AC-1c: Empty itineraries array → null

  it('AC-1c: should return null when otp-router returns an empty itineraries array', async () => {
    mockOk(makeOtpPlan([]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'EDB',
      toCrs: 'KGX',
      departAfter: '2026-06-13T21:30:00Z',
    });

    expect(legs).toBeNull();
  });

  // AC-1d: Network error → null (graceful degradation, must not throw)

  it('AC-1d: should return null when otp-router is unreachable (network error)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'PLY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    // Must not throw — graceful degradation to null
    expect(legs).toBeNull();
  });

  // AC-1e: HTTP 500 → null

  it('AC-1e: should return null when otp-router returns HTTP 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: 'Internal Server Error' }] }),
    });

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'PLY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).toBeNull();
  });

  // AC-1f: GraphQL errors in response body → null

  it('AC-1f: should return null when otp-router returns GraphQL errors in the response body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ message: 'Station NOT not found in GTFS' }],
        data: null,
      }),
    });

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'PLY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).toBeNull();
  });

  // AC-1g: Mixed-mode itinerary — only RAIL legs survive the mapping

  it('AC-1g: should filter to RAIL legs only, ignoring WALK/BUS/TRAM modes in OTP response', async () => {
    mockOk({
      data: {
        plan: {
          itineraries: [
            {
              legs: [
                {
                  mode: 'WALK', // Must be filtered out
                  from: { name: 'Platform', stop: { gtfsId: '1:DUMMY1' } },
                  to:   { name: 'Barrier',  stop: { gtfsId: '1:NTNBSH' } },
                  startTime: 1749828900000,
                  endTime:   1749829020000,
                  trip: { gtfsId: '1:WALK001' },
                },
                {
                  mode: 'RAIL', // Must survive
                  from: { name: 'Nottingham', stop: { gtfsId: '1:NTNBSH' } },
                  to:   { name: 'Derby',      stop: { gtfsId: '1:DRBY'  } },
                  startTime: 1749829020000,
                  endTime:   1749831960000,
                  trip: { gtfsId: '1:202606136721613' },
                },
              ],
            },
          ],
        },
      },
    });

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'DBY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).not.toBeNull();
    const railLegs = legs as OtpLeg[];
    // WALK leg must NOT appear in the result
    expect(railLegs.every((l) => l.rid !== 'WALK001')).toBe(true);
    // RAIL leg MUST appear
    expect(railLegs.some((l) => l.rid === '202606136721613')).toBe(true);
  });

  // AC-1h: HTTP POST to correct URL with GraphQL body

  it('AC-1h: should POST to OTP_ROUTER_URL with a JSON body that has a "query" field', async () => {
    mockOk(makeOtpPlan([{
      mode: 'RAIL',
      fromGtfsId: '1:NTNBSH',
      toGtfsId:   '1:DRBY',
      startTime:  1749829020000,
      endTime:    1749831960000,
      tripGtfsId: '1:202606136721613',
    }]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'DBY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    // URL must contain the OTP_ROUTER_URL base (with /graphql or similar path)
    expect(url).toContain(OTP_URL);
    // Must be a POST
    expect(opts.method?.toUpperCase()).toBe('POST');
    // Body must be a JSON string with a 'query' field (GraphQL)
    expect(opts.body).toBeTruthy();
    const body = JSON.parse(opts.body as string);
    expect(body).toHaveProperty('query');
  });
});
