/**
 * Integration Test: BL-179 - Darwin lookup succeeds with GTFS-prefixed RID
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * BL Item: BL-179 - delay-tracker sends GTFS-prefixed RIDs to Darwin API
 * Service: delay-tracker
 *
 * AC-5: Integration test verifies Darwin lookup succeeds when given a prefixed RID
 *
 * This test exercises the full DarwinIngestorClient against a realistic Darwin
 * Ingestor mock server. It proves the complete fix works end-to-end:
 *   Input:  prefixed RID "1:202603117664795"
 *   Strip:  stripGtfsPrefix removes "1:" prefix
 *   Send:   bare RID "202603117664795" sent in POST body
 *   Result: Darwin finds the service and returns delay data
 *
 * WHY INTEGRATION (not unit):
 * The unit tests above assert the request body. This test asserts that the
 * complete lookup pipeline - including the response parsing and delay data
 * extraction - works correctly when stripping is applied. It also validates
 * that both getDelaysByRids() and getDelayInfo() work consistently.
 *
 * This test WILL FAIL on the current codebase because:
 * 1. DarwinIngestorClient does NOT strip prefixes
 * 2. @railrepay/gtfs-utils does NOT exist yet
 *
 * DO NOT modify these tests. Blake must implement the fix.
 *
 * TEST LOCK RULE: Blake MUST NOT modify these tests.
 *
 * Verified: darwin-ingestor exposes POST /api/v1/delays
 * (verified in existing darwin-ingestor.test.ts and TD-DELAY-TRACKER-004)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { DarwinIngestorClient } from '../../src/clients/darwin-ingestor.js';
import type { DarwinDelayInfo } from '../../src/types.js';

// ============================================================================
// Fixtures
//
// _fixtureMetadata:
//   source: darwin_ingestor.delay_services
//   description: Realistic delay service records mirroring Darwin Ingestor data
//   sampledAt: 2026-04-05
//   note: Darwin stores bare RIDs; GTFS data carries prefixed RIDs.
//         The fix must bridge this format mismatch.
// ============================================================================

const BARE_RID_DELAYED = '202603117664795'; // Bare RID as stored in Darwin
const PREFIXED_RID_DELAYED = '1:202603117664795'; // Same RID as received from GTFS

const BARE_RID_CANCELLED = '202602098022634';
const PREFIXED_RID_CANCELLED = '1:202602098022634';

const BARE_RID_ON_TIME = '202601150800999';
const PREFIXED_RID_ON_TIME = '1:202601150800999';

/**
 * Simulates Darwin Ingestor's delay_services dataset.
 * Keyed by bare RID - prefixed RIDs will NOT match.
 * This faithfully replicates why the bug causes lookups to fail.
 */
const darwinDatabase: Record<string, DarwinDelayInfo> = {
  [BARE_RID_DELAYED]: {
    rid: BARE_RID_DELAYED,
    delay_minutes: 32,
    is_cancelled: false,
    delay_reasons: { reason: 'Signalling failure south of Bristol Parkway' },
  },
  [BARE_RID_CANCELLED]: {
    rid: BARE_RID_CANCELLED,
    delay_minutes: 0,
    is_cancelled: true,
    delay_reasons: { reason: 'Fleet availability' },
  },
  // BARE_RID_ON_TIME has no entry - train was on time
};

// ============================================================================
// MSW Server - Simulates Darwin Ingestor POST /api/v1/delays
// Verified: POST /api/v1/delays exists in darwin-ingestor service
// ============================================================================

const TEST_BASE_URL = 'http://darwin-ingestor-integration.test:3000';

const handlers = [
  http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
    const body = (await request.json()) as { rids: string[] };
    const requestedRids = body.rids;

    // Darwin only returns results for bare RIDs that exist in its database
    // Prefixed RIDs (e.g. "1:202603117664795") will find NO matches - simulating the bug
    const services: DarwinDelayInfo[] = requestedRids
      .map((rid) => darwinDatabase[rid])
      .filter((service): service is DarwinDelayInfo => service !== undefined);

    return HttpResponse.json({ services });
  }),
];

const server = setupServer(...handlers);

// ============================================================================
// Integration Test Suite
// ============================================================================

describe('BL-179 Integration: Darwin lookup succeeds with GTFS-prefixed RID (AC-5)', () => {
  /**
   * AC-5: Integration test verifies Darwin lookup succeeds when given a prefixed RID
   *
   * The Darwin Ingestor mock only responds to BARE RIDs.
   * If the client sends a prefixed RID, it gets an empty response.
   * These tests verify the client correctly strips the prefix so Darwin can find the service.
   */

  let client: DarwinIngestorClient;

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    client = new DarwinIngestorClient({
      baseUrl: TEST_BASE_URL,
      timeout: 10000,
    });
  });

  // ==========================================================================
  // AC-5a: getDelaysByRids() with prefixed RID returns delay data
  // ==========================================================================

  describe('AC-5a: getDelaysByRids() succeeds with prefixed RID input', () => {
    it('should return delay data for a delayed service when given a prefixed RID', async () => {
      // AC-5: Core integration scenario
      // BEFORE fix: sends "1:202603117664795", Darwin finds nothing, returns []
      // AFTER fix:  sends "202603117664795",   Darwin finds it,    returns delay data
      const result = await client.getDelaysByRids([PREFIXED_RID_DELAYED]);

      expect(result).toHaveLength(1);
      expect(result[0].rid).toBe(BARE_RID_DELAYED);
      expect(result[0].delay_minutes).toBe(32);
      expect(result[0].is_cancelled).toBe(false);
    });

    it('should return cancellation data when given a prefixed RID for a cancelled service', async () => {
      // AC-5: Cancellation detection requires correct RID lookup
      // BEFORE fix: prefixed RID returns empty, cancellation is missed
      // AFTER fix:  bare RID returned, cancellation correctly detected
      const result = await client.getDelaysByRids([PREFIXED_RID_CANCELLED]);

      expect(result).toHaveLength(1);
      expect(result[0].rid).toBe(BARE_RID_CANCELLED);
      expect(result[0].is_cancelled).toBe(true);
      expect(result[0].delay_minutes).toBe(0);
    });

    it('should return empty array for prefixed RID of on-time service not in Darwin', async () => {
      // AC-5: On-time services not stored in Darwin return empty (expected behaviour)
      // Prefix stripping still happens but Darwin legitimately has no record
      const result = await client.getDelaysByRids([PREFIXED_RID_ON_TIME]);

      expect(result).toHaveLength(0);
    });

    it('should return data for all services in a batch of prefixed RIDs', async () => {
      // AC-5: Batch stripping - multiple prefixed RIDs in one call
      const result = await client.getDelaysByRids([
        PREFIXED_RID_DELAYED,
        PREFIXED_RID_CANCELLED,
      ]);

      expect(result).toHaveLength(2);

      const delayedResult = result.find((s) => s.rid === BARE_RID_DELAYED);
      const cancelledResult = result.find((s) => s.rid === BARE_RID_CANCELLED);

      expect(delayedResult).toBeDefined();
      expect(delayedResult!.delay_minutes).toBe(32);

      expect(cancelledResult).toBeDefined();
      expect(cancelledResult!.is_cancelled).toBe(true);
    });

    it('should handle mixed batch of prefixed and bare RIDs correctly', async () => {
      // AC-5 + AC-3: One prefixed (needs stripping), one bare (passes through)
      // Both should return data from Darwin
      const result = await client.getDelaysByRids([
        PREFIXED_RID_DELAYED, // Needs stripping -> BARE_RID_DELAYED
        BARE_RID_CANCELLED,   // Already bare -> BARE_RID_CANCELLED
      ]);

      expect(result).toHaveLength(2);
      const rids = result.map((s) => s.rid);
      expect(rids).toContain(BARE_RID_DELAYED);
      expect(rids).toContain(BARE_RID_CANCELLED);
    });

    it('should still return empty array for empty RIDs input (unaffected)', async () => {
      // Regression: existing short-circuit for empty input must be preserved
      const result = await client.getDelaysByRids([]);
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // AC-5b: getDelayInfo() with prefixed RID returns delay data
  // ==========================================================================

  describe('AC-5b: getDelayInfo() succeeds with prefixed RID input', () => {
    it('should return delay data for a delayed service when given a prefixed RID', async () => {
      // AC-5: Single-RID path
      // BEFORE fix: sends "1:202603117664795", Darwin returns empty, sentinel returned (delay_minutes=0)
      // AFTER fix:  sends "202603117664795",   Darwin returns real data (delay_minutes=32)
      const result = await client.getDelayInfo({
        rid: PREFIXED_RID_DELAYED,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.rid).toBe(BARE_RID_DELAYED);
      expect(result.delay_minutes).toBe(32);
      expect(result.is_cancelled).toBe(false);
      expect(result.delay_reasons).toEqual({ reason: 'Signalling failure south of Bristol Parkway' });
    });

    it('should correctly detect cancellation when given a prefixed RID for a cancelled service', async () => {
      // AC-5: Cancellation data must be returned (not zero-delay sentinel)
      // This is critical - missed cancellations mean missed compensation
      const result = await client.getDelayInfo({
        rid: PREFIXED_RID_CANCELLED,
        service_date: '2026-02-09',
        origin_crs: 'MAN',
        destination_crs: 'EUS',
      });

      expect(result.rid).toBe(BARE_RID_CANCELLED);
      expect(result.is_cancelled).toBe(true);
      expect(result.delay_minutes).toBe(0);
    });

    it('should return zero-delay sentinel for prefixed RID of on-time service', async () => {
      // AC-5: On-time services not in Darwin legitimately return sentinel
      // Prefix stripping still applies but Darwin has no record (service was on time)
      const result = await client.getDelayInfo({
        rid: PREFIXED_RID_ON_TIME,
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
      });

      // Zero-delay sentinel is correct for on-time services
      expect(result.delay_minutes).toBe(0);
      expect(result.is_cancelled).toBe(false);
      expect(result.delay_reasons).toBeNull();
    });

    it('should work correctly for bare RID (regression - existing behaviour preserved)', async () => {
      // AC-3: Bare RID still returns correct data (no regression from fix)
      const result = await client.getDelayInfo({
        rid: BARE_RID_DELAYED,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.rid).toBe(BARE_RID_DELAYED);
      expect(result.delay_minutes).toBe(32);
    });
  });

  // ==========================================================================
  // AC-5c: Demonstrates the pre-fix failure (documents the bug)
  // ==========================================================================

  describe('AC-5c: documents the bug behaviour that the fix resolves', () => {
    it('should NOT return empty result for a delayed service with prefixed RID (was: bug)', async () => {
      // AC-5: This test was ALWAYS returning [] before the fix because Darwin
      // does not know "1:202603117664795" - only "202603117664795".
      // After fix, this returns the real delay data.
      // The name "was: bug" documents what the pre-fix behaviour was.
      const result = await client.getDelaysByRids([PREFIXED_RID_DELAYED]);

      // BEFORE fix: result would be [] (empty - Darwin found nothing)
      // AFTER fix:  result has 1 service with delay_minutes=32
      expect(result).not.toHaveLength(0);
      expect(result[0].delay_minutes).toBeGreaterThan(0);
    });

    it('should NOT return zero-delay sentinel for genuinely delayed service with prefixed RID (was: bug)', async () => {
      // AC-5: getDelayInfo() used to return { delay_minutes: 0 } for delayed services
      // because prefixed RID found nothing in Darwin and the sentinel was returned.
      // This caused the journey-confirmed handler to publish "below_threshold" instead
      // of "delay.detected", meaning eligible customers never received compensation.
      const result = await client.getDelayInfo({
        rid: PREFIXED_RID_DELAYED,
        service_date: '2026-03-11',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      // BEFORE fix: delay_minutes=0 (zero-delay sentinel returned for "not found")
      // AFTER fix:  delay_minutes=32 (real delay data from Darwin)
      expect(result.delay_minutes).toBeGreaterThan(0);
    });
  });
});
