/**
 * Unit Tests: BL-179 - DarwinIngestorClient RID Prefix Stripping
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * BL Item: BL-179 - delay-tracker sends GTFS-prefixed RIDs to Darwin API
 * Service: delay-tracker
 *
 * Problem: delay-tracker receives RIDs from GTFS data with feed-index prefixes
 * (e.g. "1:202603117664795"). Darwin Ingestor stores bare RIDs ("202603117664795").
 * Prefixed lookups return empty results, causing false "below_threshold" or
 * "darwin_unavailable" outcomes for genuinely delayed journeys.
 *
 * Fix scope: DarwinIngestorClient must strip GTFS prefix from all RIDs before
 * sending to Darwin Ingestor API. Both getDelaysByRids() and getDelayInfo()
 * are affected.
 *
 * These tests WILL FAIL on the current codebase because:
 * 1. DarwinIngestorClient does NOT strip prefixes from RIDs
 * 2. stripGtfsPrefix from @railrepay/gtfs-utils does NOT exist yet
 *
 * DO NOT modify these tests. Blake must update DarwinIngestorClient to
 * import stripGtfsPrefix and apply it before the fetch call.
 *
 * TEST LOCK RULE: Blake MUST NOT modify these tests.
 *
 * AC Mapping (from Quinn's BL-179 spec):
 * - AC-1: delay-tracker strips GTFS prefix from all RIDs before querying Darwin API
 * - AC-3: Bare RIDs are passed through unchanged
 * - AC-4: Edge cases handled (empty string, null, non-digit prefix)
 *
 * Verified: darwin-ingestor exposes POST /api/v1/delays (verified in TD-DELAY-TRACKER-004)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';
import type { DarwinDelayInfo } from '../../../src/types.js';

// ============================================================================
// Test Fixtures
//
// _fixtureMetadata:
//   source: darwin_ingestor.delay_services (sampled 2026-04-05)
//   description: Real bare RID format stored in Darwin Ingestor database
//   note: Darwin stores "202603117664795" NOT "1:202603117664795"
// ============================================================================

const BARE_RID_A = '202603117664795';
const PREFIXED_RID_A = '1:202603117664795'; // GTFS feed prefix "1:"

const BARE_RID_B = '202602098022634';
const PREFIXED_RID_B = '1:202602098022634';

const BARE_RID_C = '202601150800123';
const PREFIXED_RID_C = '12:202601150800123'; // Double-digit prefix

/**
 * Darwin response for BARE_RID_A - delayed service
 * Source: representative delay_services row
 */
const delayedServiceForRidA: DarwinDelayInfo = {
  rid: BARE_RID_A,
  delay_minutes: 25,
  is_cancelled: false,
  delay_reasons: { reason: 'Signal failure at Peterborough' },
};

/**
 * Darwin response for BARE_RID_B - cancelled service
 */
const cancelledServiceForRidB: DarwinDelayInfo = {
  rid: BARE_RID_B,
  delay_minutes: 0,
  is_cancelled: true,
  delay_reasons: { reason: 'Driver shortage' },
};

/**
 * Darwin response for BARE_RID_C - delayed above threshold
 */
const delayedServiceForRidC: DarwinDelayInfo = {
  rid: BARE_RID_C,
  delay_minutes: 34,
  is_cancelled: false,
  delay_reasons: null,
};

// ============================================================================
// MSW Server Setup
// Verified: darwin-ingestor exposes POST /api/v1/delays
// (See TD-DELAY-TRACKER-004 verification notes)
// ============================================================================

const TEST_BASE_URL = 'http://darwin-ingestor.test:3000';

/**
 * The MSW handler captures the RIDs actually sent in the request body.
 * Tests assert these captured RIDs are BARE (no prefix), proving stripping occurred.
 */
let capturedRequestBody: { rids: string[] } | null = null;

const handlers = [
  http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
    capturedRequestBody = (await request.json()) as { rids: string[] };
    const rids = capturedRequestBody.rids;

    // Respond with data only for bare RIDs (simulates Darwin's actual behaviour)
    const services: DarwinDelayInfo[] = [];
    for (const rid of rids) {
      if (rid === BARE_RID_A) services.push(delayedServiceForRidA);
      if (rid === BARE_RID_B) services.push(cancelledServiceForRidB);
      if (rid === BARE_RID_C) services.push(delayedServiceForRidC);
      // Prefixed RIDs (e.g. "1:202603117664795") return NO results
      // This simulates Darwin's actual behaviour and proves why stripping is needed
    }

    return HttpResponse.json({ services });
  }),
];

const server = setupServer(...handlers);

// ============================================================================
// Test Suite
// ============================================================================

describe('BL-179: DarwinIngestorClient - GTFS prefix stripping', () => {
  /**
   * TD CONTEXT: DarwinIngestorClient sends raw GTFS-prefixed RIDs to Darwin.
   * Darwin stores bare RIDs, so "1:202603117664795" finds nothing.
   * REQUIRED FIX: Apply stripGtfsPrefix() from @railrepay/gtfs-utils
   * before the fetch call in both getDelaysByRids() and getDelayInfo().
   */

  let client: DarwinIngestorClient;

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
    capturedRequestBody = null;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    client = new DarwinIngestorClient({
      baseUrl: TEST_BASE_URL,
      timeout: 5000,
    });
  });

  // ==========================================================================
  // AC-1: getDelaysByRids() strips GTFS prefix before sending to Darwin
  // ==========================================================================

  describe('AC-1: getDelaysByRids() strips GTFS prefix from all RIDs', () => {
    it('should send bare RID to Darwin when input has single-digit prefix "1:"', async () => {
      // AC-1: "1:202603117664795" must be sent as "202603117664795"
      await client.getDelaysByRids([PREFIXED_RID_A]);

      // The key assertion: the HTTP body MUST contain the bare RID, not the prefixed one
      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain(BARE_RID_A);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_A);
    });

    it('should send bare RID to Darwin when input has double-digit prefix "12:"', async () => {
      // AC-1: "12:202601150800123" must be sent as "202601150800123"
      await client.getDelaysByRids([PREFIXED_RID_C]);

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain(BARE_RID_C);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_C);
    });

    it('should strip prefix from ALL RIDs in a batch of mixed prefixed RIDs', async () => {
      // AC-1: Multiple prefixed RIDs in one call - all must be stripped
      await client.getDelaysByRids([PREFIXED_RID_A, PREFIXED_RID_B, PREFIXED_RID_C]);

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain(BARE_RID_A);
      expect(capturedRequestBody!.rids).toContain(BARE_RID_B);
      expect(capturedRequestBody!.rids).toContain(BARE_RID_C);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_A);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_B);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_C);
    });

    it('should return delay data when called with prefixed RID (proves end-to-end stripping works)', async () => {
      // AC-1: The complete flow - prefixed input, stripped before Darwin, results returned
      // Currently this returns [] because Darwin finds nothing with the prefixed RID.
      // After fix: Darwin receives the bare RID and returns delay data.
      const result = await client.getDelaysByRids([PREFIXED_RID_A]);

      expect(result).toHaveLength(1);
      expect(result[0].rid).toBe(BARE_RID_A);
      expect(result[0].delay_minutes).toBe(25);
    });

    it('should return delay data for all services when batch contains prefixed RIDs', async () => {
      // AC-1: Batch with multiple prefixed RIDs should return all matching services
      const result = await client.getDelaysByRids([PREFIXED_RID_A, PREFIXED_RID_B]);

      expect(result).toHaveLength(2);
      const rids = result.map((s) => s.rid);
      expect(rids).toContain(BARE_RID_A);
      expect(rids).toContain(BARE_RID_B);
    });

    // AC-3: Bare RIDs pass through unchanged
    it('should not modify bare RID that has no prefix', async () => {
      // AC-3: Bare RID must reach Darwin exactly as provided
      await client.getDelaysByRids([BARE_RID_A]);

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain(BARE_RID_A);
    });

    it('should return delay data for bare RID unchanged', async () => {
      // AC-3: Bare RID call continues to work correctly after fix
      const result = await client.getDelaysByRids([BARE_RID_A]);

      expect(result).toHaveLength(1);
      expect(result[0].rid).toBe(BARE_RID_A);
      expect(result[0].delay_minutes).toBe(25);
    });

    it('should handle mixed batch of prefixed and bare RIDs', async () => {
      // AC-1 + AC-3: One prefixed, one bare - both must arrive at Darwin as bare
      await client.getDelaysByRids([PREFIXED_RID_A, BARE_RID_B]);

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain(BARE_RID_A);
      expect(capturedRequestBody!.rids).toContain(BARE_RID_B);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_A);
    });

    it('should deduplicate RIDs after stripping (if prefix and bare RID both present)', async () => {
      // AC-1 edge case: if "1:202603117664795" and "202603117664795" both appear,
      // after stripping both become "202603117664795" - only one should be sent
      const result = await client.getDelaysByRids([PREFIXED_RID_A, BARE_RID_A]);

      expect(capturedRequestBody).not.toBeNull();
      // Each bare RID should appear only once in the request
      const countOfBareRidA = capturedRequestBody!.rids.filter((r) => r === BARE_RID_A).length;
      expect(countOfBareRidA).toBe(1);
      // Result should not contain duplicates
      expect(result).toHaveLength(1);
    });

    // AC-4: Edge case - empty string RID
    it('should handle empty string RID gracefully in batch', async () => {
      // AC-4: Empty string should pass through (or be filtered out) without crashing
      // The important thing is no exception is thrown
      await expect(client.getDelaysByRids([''])).resolves.toBeDefined();
    });

    // AC-1: Error handling - non-OK HTTP response from Darwin API in getDelaysByRids()
    it('should throw with Darwin API error message when Darwin returns non-OK status', async () => {
      // Covers darwin-ingestor.ts lines 99-100: the !response.ok throw branch
      // This branch exists in the BL-179 implementation and must be covered.
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        }),
      );

      await expect(client.getDelaysByRids([PREFIXED_RID_A])).rejects.toThrow(
        'Darwin API error: 500 Internal Server Error',
      );
    });

    // AC-1: Error handling - request timeout in getDelaysByRids()
    it('should throw timeout error when Darwin API does not respond within timeout', async () => {
      // Covers darwin-ingestor.ts lines 118-123: the AbortError timeout branch
      // Uses a very short timeout client to trigger the abort signal.
      const shortTimeoutClient = new DarwinIngestorClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1, // 1ms - will time out immediately
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async () => {
          // Delay longer than the timeout to trigger the AbortController
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({ services: [] });
        }),
      );

      await expect(shortTimeoutClient.getDelaysByRids([PREFIXED_RID_A])).rejects.toThrow(
        'Darwin API request timeout',
      );
    });
  });

  // ==========================================================================
  // AC-1: getDelayInfo() strips GTFS prefix before sending to Darwin
  // ==========================================================================

  describe('AC-1: getDelayInfo() strips GTFS prefix from single RID', () => {
    it('should send bare RID to Darwin when input has single-digit prefix "1:"', async () => {
      // AC-1: getDelayInfo() must strip prefix before the POST request
      await client.getDelayInfo({
        rid: PREFIXED_RID_A,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain(BARE_RID_A);
      expect(capturedRequestBody!.rids).not.toContain(PREFIXED_RID_A);
    });

    it('should send exactly one RID in the request body (single-RID wrapper)', async () => {
      // AC-1: getDelayInfo wraps RID in array { rids: [strippedRid] } for POST
      await client.getDelayInfo({
        rid: PREFIXED_RID_A,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toHaveLength(1);
      expect(capturedRequestBody!.rids[0]).toBe(BARE_RID_A);
    });

    it('should return delay data when called with prefixed RID', async () => {
      // AC-1: Full round-trip - prefixed in, stripped before Darwin, data returned
      // Currently returns zero-delay sentinel because Darwin finds nothing with prefixed RID.
      // After fix: Darwin receives bare RID and returns real delay data.
      const result = await client.getDelayInfo({
        rid: PREFIXED_RID_A,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.rid).toBe(BARE_RID_A);
      expect(result.delay_minutes).toBe(25);
      expect(result.is_cancelled).toBe(false);
    });

    it('should return cancelled service data when prefixed RID resolves to cancelled service', async () => {
      // AC-1: Prefix stripping also affects cancellation detection
      const result = await client.getDelayInfo({
        rid: PREFIXED_RID_B,
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.is_cancelled).toBe(true);
      expect(result.rid).toBe(BARE_RID_B);
    });

    it('should strip double-digit prefix "12:" from RID in getDelayInfo', async () => {
      // AC-1: Multi-digit prefix also stripped in single-RID lookup
      await client.getDelayInfo({
        rid: PREFIXED_RID_C,
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDN',
      });

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids[0]).toBe(BARE_RID_C);
      expect(capturedRequestBody!.rids[0]).not.toContain('12:');
    });

    // AC-3: Bare RIDs in getDelayInfo pass through unchanged
    it('should not modify bare RID in getDelayInfo when no prefix present', async () => {
      // AC-3: Bare RID must not be mangled
      await client.getDelayInfo({
        rid: BARE_RID_A,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids[0]).toBe(BARE_RID_A);
    });

    it('should still return zero-delay sentinel for unknown bare RID (existing behaviour preserved)', async () => {
      // AC-3: Existing zero-delay sentinel behaviour must not be broken by prefix stripping
      const result = await client.getDelayInfo({
        rid: 'unknown-rid-that-darwin-does-not-know',
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_minutes).toBe(0);
      expect(result.is_cancelled).toBe(false);
      expect(result.delay_reasons).toBeNull();
    });

    it('should preserve the original RID in the zero-delay sentinel when no Darwin match', async () => {
      // AC-3: The sentinel object should carry the (stripped) RID for traceability
      const unknownRid = 'unknown-bare-rid-99999';
      const result = await client.getDelayInfo({
        rid: unknownRid,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.rid).toBe(unknownRid);
    });
  });

  // ==========================================================================
  // AC-4: Non-digit prefix edge cases in client methods
  // ==========================================================================

  describe('AC-4: non-digit prefixes are not stripped by the client', () => {
    it('should pass "AB:RID" RID to Darwin unchanged (not a GTFS prefix)', async () => {
      // AC-4: Only /^\d+:/ pattern is stripped; alphabetic prefix is not
      // This tests that the client uses the correct stripGtfsPrefix implementation
      await client.getDelaysByRids(['AB:RID']);

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids).toContain('AB:RID');
    });

    it('should pass "AB:RID" to Darwin in getDelayInfo unchanged', async () => {
      // AC-4: Alphabetic prefix is not a GTFS prefix and must not be stripped
      await client.getDelayInfo({
        rid: 'AB:RID',
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedRequestBody).not.toBeNull();
      expect(capturedRequestBody!.rids[0]).toBe('AB:RID');
    });
  });
});
