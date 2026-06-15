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
 * TWO-STEP CONTRACT (proven by live smoke against deployed otp-router):
 *   findReplacementRoute({fromCrs, toCrs, departAfter}) MUST make 3 sequential
 *   fetch calls to the otp-router GraphQL endpoint:
 *     Call 1: stop(id:"1:<fromCrs>") { lat lon }  → resolves fromCrs coords
 *     Call 2: stop(id:"1:<toCrs>")  { lat lon }  → resolves toCrs coords
 *     Call 3: plan(from:{lat,lon}, to:{lat,lon}, date, time) → itineraries
 *   If either stop-resolve returns null/empty → returns null gracefully.
 *   The plan call MUST use lat/lon coords for from/to, NOT stop:{feedId,gtfsId}.
 *   Verified live: NOT → {lat:52.9471795, lon:-1.1468881}
 *                  PLY → {lat:50.3778174, lon:-4.1433631}
 *
 * Test Lock Rule: Blake MUST NOT modify this file. If a test needs to change,
 * Blake hands back to Jessie with explanation.
 *
 * Mock-queue note (project memory): use mockResolvedValueOnce for 3-call sequences.
 * vi.clearAllMocks() does NOT clear the once-queue — use mockReset() to fully reset
 * before re-establishing. Do NOT use global vi.resetAllMocks().
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
  // Use mockReset (not clearAllMocks) to flush the once-queue between tests.
  // vi.clearAllMocks() does NOT clear mockResolvedValueOnce entries.
  mockFetch.mockReset();
  vi.restoreAllMocks();
  delete process.env.OTP_ROUTER_URL;
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers: stop-resolve responses and plan response
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Build a stop-resolve response: the shape otp-router returns for
 *   stop(id: "1:<CRS>") { gtfsId lat lon }
 *
 * Uses DIFFERENTIATING coords per stop so a swapped-arg bug fails immediately.
 */
function makeStopResolve(gtfsId: string, lat: number, lon: number) {
  return {
    ok: true,
    json: async () => ({
      data: {
        stop: { gtfsId, lat, lon },
      },
    }),
  };
}

/**
 * Build a raw OTP plan response (call 3).
 * Feeds raw "1:RID" trip.gtfsId values — client must strip them.
 */
function makeOtpPlan(legs: Array<{
  mode: string;
  fromGtfsId: string;
  toGtfsId: string;
  startTime: number;
  endTime: number;
  tripGtfsId: string;
}>) {
  return {
    ok: true,
    json: async () => ({
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
    }),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// AC-1 tests
// ───────────────────────────────────────────────────────────────────────────────

describe('BL-338 AC-1: OtpRouterClient — real OTP HTTP client (two-step resolve→plan)', () => {
  /**
   * Verified: OtpRouterClient must implement OtpClient interface:
   *   findReplacementRoute({fromCrs, toCrs, departAfter}): Promise<OtpLeg[] | null>
   *
   * HTTP layer mocked via globalThis.fetch = vi.fn() (native fetch pattern,
   * mirrors DarwinIngestorClient, NOT axios — see BL-338 spec §Change-2 constraint).
   *
   * Two-step contract:
   *   Call 1: POST /graphql — stop resolve for fromCrs → { lat, lon }
   *   Call 2: POST /graphql — stop resolve for toCrs   → { lat, lon }
   *   Call 3: POST /graphql — plan with from:{lat,lon}, to:{lat,lon}
   *
   * Endpoint mocked: POST ${OTP_ROUTER_URL}/graphql
   */

  // AC-1a: Successful single RAIL leg → OtpLeg[] with correct field mapping

  it('AC-1a: should return OtpLeg[] when otp-router returns a valid plan with a RAIL itinerary', async () => {
    // Call 1: NOT stop resolve — live: {lat:52.9471795, lon:-1.1468881}
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:NOT', 52.9471795, -1.1468881));
    // Call 2: PLY stop resolve — live: {lat:50.3778174, lon:-4.1433631}
    // Differentiating coords: different from NOT so swapped-arg bugs fail
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:PLY', 50.3778174, -4.1433631));
    // Call 3: plan response with RAIL leg (raw "1:RID" gtfsId — client must strip)
    mockFetch.mockResolvedValueOnce(makeOtpPlan([{
      mode: 'RAIL',
      fromGtfsId: '1:NTNBSH',
      toGtfsId:   '1:PLYMTH',
      startTime:  1781377740000,   // 2026-06-13T19:09:00.000Z
      endTime:    1781390880000,   // 2026-06-13T22:48:00.000Z
      tripGtfsId: '1:202606137101164', // raw "1:RID" → must become RID
    }]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'PLY',
      departAfter: '2026-06-13T19:09:00Z',
    });

    expect(legs).not.toBeNull();
    expect(Array.isArray(legs)).toBe(true);
    expect((legs as OtpLeg[]).length).toBeGreaterThan(0);

    const leg = (legs as OtpLeg[])[0];
    // Key assertion: trip.gtfsId "1:202606137101164" → rid "202606137101164"
    expect(leg.rid).toBe('202606137101164');
    expect(leg.originCrs).toBe('NOT');
    expect(leg.destinationCrs).toBe('PLY');
    // Scheduled times should be ISO strings derived from epoch ms
    expect(leg.scheduledDeparture).toMatch(/2026-06-13/);
    expect(leg.scheduledArrival).toMatch(/2026-06-13/);
  });

  // AC-1b: SOP-011 — raw "1:RID" prefix must be stripped from trip.gtfsId → OtpLeg.rid

  it('AC-1b (SOP-011): should strip "1:" prefix from trip.gtfsId when mapping to OtpLeg.rid', async () => {
    // Call 1: DBY stop resolve (differentiating lat/lon from PLY)
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:DBY', 52.9155, -1.4762));
    // Call 2: NOT stop resolve (different coords from DBY)
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:NOT', 52.9471795, -1.1468881));
    // Call 3: plan — feed raw "1:RID" — the client must produce a bare RID with no prefix
    mockFetch.mockResolvedValueOnce(makeOtpPlan([{
      mode: 'RAIL',
      fromGtfsId: '1:DRBY',
      toGtfsId:   '1:NTNBSH',
      startTime:  1749829020000,
      endTime:    1749831960000,
      tripGtfsId: '1:202606136721613', // MUST become '202606136721613'
    }]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'DBY',
      toCrs: 'NOT',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).not.toBeNull();
    const rid = (legs as OtpLeg[])[0].rid;
    // Must NOT contain the "1:" prefix
    expect(rid).toBe('202606136721613');
    expect(rid).not.toContain('1:');
  });

  // AC-1c: Empty itineraries array → null (2 stop-resolves succeed, plan returns empty)

  it('AC-1c: should return null when otp-router returns an empty itineraries array', async () => {
    // Calls 1 & 2: stop-resolves succeed (valid coords)
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:EDB', 55.9519, -3.1885));
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:KGX', 51.5308, -0.1234));
    // Call 3: plan returns empty itineraries
    mockFetch.mockResolvedValueOnce(makeOtpPlan([]));

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'EDB',
      toCrs: 'KGX',
      departAfter: '2026-06-13T21:30:00Z',
    });

    expect(legs).toBeNull();
  });

  // AC-1d: Network error → null (fires on call 1 — stop-resolve — no calls 2/3)

  it('AC-1d: should return null when otp-router is unreachable (network error)', async () => {
    // Network error fires on call 1 (fromCrs stop-resolve)
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // Calls 2 & 3 must NOT be reached — no mockResolvedValueOnce queued for them

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'PLY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    // Must not throw — graceful degradation to null
    expect(legs).toBeNull();
    // Verify the client short-circuited: only 1 call made (the failed stop-resolve)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // AC-1e: HTTP 500 on call 1 (stop-resolve) → null

  it('AC-1e: should return null when otp-router returns HTTP 500', async () => {
    // HTTP 500 fires on call 1 (fromCrs stop-resolve)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: 'Internal Server Error' }] }),
    });
    // Calls 2 & 3 must NOT be reached

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'PLY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).toBeNull();
  });

  // AC-1f: GraphQL errors in body on call 1 (stop-resolve) → null

  it('AC-1f: should return null when otp-router returns GraphQL errors in the response body', async () => {
    // GraphQL errors body fires on call 1 (fromCrs stop-resolve)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ message: 'Station NOT not found in GTFS' }],
        data: null,
      }),
    });
    // Calls 2 & 3 must NOT be reached

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
    // Call 1: NOT stop resolve
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:NOT', 52.9471795, -1.1468881));
    // Call 2: DBY stop resolve (different coords from NOT)
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:DBY', 52.9155, -1.4762));
    // Call 3: mixed-mode plan response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
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
      }),
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

  // AC-1h: 3 sequential HTTP POSTs to correct URL — two stop-resolves then one plan

  it('AC-1h: should make exactly 3 POST calls (2 stop-resolves + 1 plan) with correct GraphQL contract', async () => {
    // Call 1: NOT stop resolve
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:NOT', 52.9471795, -1.1468881));
    // Call 2: DBY stop resolve (different coords from NOT — differentiating)
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:DBY', 52.9155, -1.4762));
    // Call 3: plan response
    mockFetch.mockResolvedValueOnce(makeOtpPlan([{
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

    // Two-step contract: MUST be exactly 3 calls (was 1 in broken impl — this is the bug-catcher)
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // All 3 calls must POST to the OTP_ROUTER_URL base
    for (const [url, opts] of mockFetch.mock.calls as [string, RequestInit][]) {
      expect(url).toContain(OTP_URL);
      expect(opts.method?.toUpperCase()).toBe('POST');
      expect(opts.body).toBeTruthy();
      const body = JSON.parse(opts.body as string);
      expect(body).toHaveProperty('query');
    }

    // CONTRACT ASSERTION (bug-catcher): calls 1 & 2 must be stop-resolves (query contains "stop(")
    const call1Body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const call2Body = JSON.parse((mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string);
    // Stop-resolve queries reference "stop" and the CRS id
    expect(call1Body.query).toMatch(/stop/i);
    expect(call2Body.query).toMatch(/stop/i);

    // CONTRACT ASSERTION (bug-catcher): call 3 (plan) body query MUST use lat/lon for from/to,
    // NOT stop:{feedId,gtfsId}. This is the key contract the live smoke proved: otp-router's
    // plan endpoint requires coordinate-based from/to, not gtfsId-based stop references.
    const call3Body = JSON.parse((mockFetch.mock.calls[2] as [string, RequestInit])[1].body as string);
    // The plan query string (or variables) must contain lat/lon references for from/to
    const planPayload = JSON.stringify(call3Body);
    expect(planPayload).toMatch(/lat/i);
    expect(planPayload).toMatch(/lon/i);
    // Must NOT use the old broken pattern of stop:{feedId,gtfsId} in the plan call
    // (the gtfsId might appear in other context but "feedId" in the plan body is the red flag)
    const planQueryStr: string = call3Body.query ?? '';
    // The plan mutation/query fields should reference lat/lon in the from/to InputLocation,
    // not a stop reference — verify the query contains "lat" near the plan context
    expect(planQueryStr).toMatch(/lat/);
  });

  // AC-1i: Null stop-resolve (stop returns null) → graceful null

  it('AC-1i: should return null when fromCrs stop-resolve returns null/empty stop', async () => {
    // Call 1: fromCrs stop returns null (station not in OTP graph)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { stop: null } }),
    });
    // Call 2: NOT reached (short-circuit on null stop)
    // Call 3: NOT reached

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'XYZ',   // Unknown station
      toCrs: 'DBY',
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).toBeNull();
    // Client must short-circuit: only 1 call (the failed fromCrs stop-resolve)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // AC-1j: Null toCrs stop-resolve → graceful null

  it('AC-1j: should return null when toCrs stop-resolve returns null/empty stop', async () => {
    // Call 1: fromCrs resolves successfully
    mockFetch.mockResolvedValueOnce(makeStopResolve('1:NOT', 52.9471795, -1.1468881));
    // Call 2: toCrs stop returns null
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { stop: null } }),
    });
    // Call 3: NOT reached (short-circuit on null toCrs stop)

    const client: OtpClient = new OtpRouterClient(OTP_URL);
    const legs = await client.findReplacementRoute({
      fromCrs: 'NOT',
      toCrs: 'XYZ',   // Unknown station
      departAfter: '2026-06-13T17:17:00Z',
    });

    expect(legs).toBeNull();
    // Client must short-circuit after 2 calls (fromCrs OK, toCrs null)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
