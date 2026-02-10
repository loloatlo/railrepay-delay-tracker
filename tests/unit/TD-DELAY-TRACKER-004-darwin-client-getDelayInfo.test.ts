/**
 * Unit Tests: TD-DELAY-TRACKER-004 - DarwinIngestorClient.getDelayInfo() Fix
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * Service: delay-tracker
 * Workflow: Technical Debt Remediation
 *
 * TD Context: getDelayInfo() calls GET /api/v1/delays/:rid which does NOT exist
 * in darwin-ingestor. The darwin-ingestor only exposes POST /api/v1/delays (batch).
 * Every historic journey delay lookup returns 404, causing darwin_unavailable events
 * even when trains were delayed.
 *
 * Required Fix: Switch to POST /api/v1/delays with { rids: [rid] }, extract first
 * element from services array, return zero-delay sentinel for empty array.
 *
 * NOTE: These tests WILL FAIL on current code (getDelayInfo uses GET method).
 * DO NOT modify these tests - Blake must change the implementation to make them pass.
 *
 * TEST LOCK RULE: Blake MUST NOT modify these tests.
 *
 * AC Mapping (from Quinn's TD-0 spec):
 * - AC-1: Uses POST /api/v1/delays with { rids: [rid] }
 * - AC-2: Response extracted from services[0], mapped to DarwinDelayInfo
 * - AC-3: Empty services array → zero-delay sentinel (NOT throw)
 * - AC-4: delay_minutes >= 15 → returns correct DarwinDelayInfo
 * - AC-5: Network error/timeout → throws (caught by handler)
 * - AC-6: Existing getDelaysByRids() unaffected
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { DarwinIngestorClient } from '../../src/clients/darwin-ingestor.js';
import type { DarwinDelayInfo } from '../../src/types.js';

// ============================================================================
// Test Fixtures - Real Darwin API Response Format
// ============================================================================

/**
 * _fixtureMetadata:
 *   source: darwin-ingestor POST /api/v1/delays endpoint (verified 2026-02-10)
 *   description: Real delayed service response from E2E test
 *   rid: 202602098022634 (PAD to CDF 15:48 GWR, 2026-02-09, 34 minutes delayed)
 */
const delayedServiceResponse = {
  services: [
    {
      rid: '202602098022634',
      delay_minutes: 34,
      is_cancelled: false,
      delay_reasons: [{ code: '576' }],
    },
  ] as DarwinDelayInfo[],
};

/**
 * Empty services array response (RID not found / train on time)
 */
const emptyServicesResponse = {
  services: [] as DarwinDelayInfo[],
};

/**
 * Cancelled service response
 */
const cancelledServiceResponse = {
  services: [
    {
      rid: '202601121600234',
      delay_minutes: 0,
      is_cancelled: true,
      delay_reasons: [{ code: '101' }],
    },
  ] as DarwinDelayInfo[],
};

/**
 * Service with delay >= 15 minutes (threshold exceeded)
 */
const thresholdExceededResponse = {
  services: [
    {
      rid: '202601150800123',
      delay_minutes: 20,
      is_cancelled: false,
      delay_reasons: [{ code: '576', text: 'Signal failure' }],
    },
  ] as DarwinDelayInfo[],
};

/**
 * Service with delay < 15 minutes (below threshold)
 */
const belowThresholdResponse = {
  services: [
    {
      rid: '202601150800456',
      delay_minutes: 10,
      is_cancelled: false,
      delay_reasons: null,
    },
  ] as DarwinDelayInfo[],
};

// ============================================================================
// MSW Server Setup
// ============================================================================

const TEST_BASE_URL = 'http://darwin-ingestor.test:3000';

const handlers = [
  // Default handler for POST /api/v1/delays
  http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
    const body = (await request.json()) as { rids: string[] };
    const rids = body.rids;
    const services: DarwinDelayInfo[] = [];

    // Aggregate all matching RIDs into a single response
    for (const rid of rids) {
      if (rid === '202602098022634') {
        services.push(delayedServiceResponse.services[0]);
      } else if (rid === '202601121600234') {
        services.push(cancelledServiceResponse.services[0]);
      } else if (rid === '202601150800123') {
        services.push(thresholdExceededResponse.services[0]);
      } else if (rid === '202601150800456') {
        services.push(belowThresholdResponse.services[0]);
      }
      // Unknown RIDs are silently omitted (not added to services array)
    }

    return HttpResponse.json({ services });
  }),
];

const server = setupServer(...handlers);

// ============================================================================
// Test Suite
// ============================================================================

describe('TD-DELAY-TRACKER-004: DarwinIngestorClient.getDelayInfo() Fix', () => {
  /**
   * TD CONTEXT: getDelayInfo() calls GET /api/v1/delays/:rid which doesn't exist
   * ROOT CAUSE: darwin-ingestor only exposes POST /api/v1/delays (batch endpoint)
   * REQUIRED FIX: Switch to POST endpoint, extract services[0], handle empty array
   * IMPACT: HIGH - All historic journey delay lookups return 404 (darwin_unavailable)
   */

  let client: DarwinIngestorClient;

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
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
  // AC-1: getDelayInfo() uses POST /api/v1/delays with { rids: [rid] }
  // ==========================================================================

  describe('AC-1: getDelayInfo() uses POST /api/v1/delays with { rids: [rid] }', () => {
    it('should use POST method (not GET)', async () => {
      // Verified: darwin-ingestor POST /api/v1/delays exists
      let capturedMethod: string | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, ({ request }) => {
          capturedMethod = request.method;
          return HttpResponse.json(delayedServiceResponse);
        })
      );

      await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedMethod).toBe('POST');
    });

    it('should send Content-Type: application/json header', async () => {
      let capturedContentType: string | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, ({ request }) => {
          capturedContentType = request.headers.get('Content-Type');
          return HttpResponse.json(delayedServiceResponse);
        })
      );

      await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedContentType).toBe('application/json');
    });

    it('should send { rids: [rid] } in request body', async () => {
      let capturedBody: { rids: string[] } | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
          capturedBody = (await request.json()) as { rids: string[] };
          return HttpResponse.json(delayedServiceResponse);
        })
      );

      await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedBody).toEqual({ rids: ['202602098022634'] });
    });

    it('should call /api/v1/delays endpoint (not /api/v1/delays/:rid)', async () => {
      let capturedUrl: string | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, ({ request }) => {
          capturedUrl = new URL(request.url).pathname;
          return HttpResponse.json(delayedServiceResponse);
        })
      );

      await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(capturedUrl).toBe('/api/v1/delays');
      expect(capturedUrl).not.toContain('202602098022634'); // RID NOT in URL path
    });
  });

  // ==========================================================================
  // AC-2: Response extracted from services[0] and mapped to DarwinDelayInfo
  // ==========================================================================

  describe('AC-2: Response extracted from services[0] and mapped to DarwinDelayInfo', () => {
    it('should return DarwinDelayInfo object from services[0]', async () => {
      const result = await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result).toEqual({
        rid: '202602098022634',
        delay_minutes: 34,
        is_cancelled: false,
        delay_reasons: [{ code: '576' }],
      });
    });

    it('should return correct structure for cancelled service', async () => {
      const result = await client.getDelayInfo({
        rid: '202601121600234',
        service_date: '2026-01-12',
        origin_crs: 'KGX',
        destination_crs: 'EDN',
      });

      expect(result).toEqual({
        rid: '202601121600234',
        delay_minutes: 0,
        is_cancelled: true,
        delay_reasons: [{ code: '101' }],
      });
      expect(result.is_cancelled).toBe(true);
    });

    it('should preserve delay_reasons structure', async () => {
      const result = await client.getDelayInfo({
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_reasons).toEqual([{ code: '576', text: 'Signal failure' }]);
    });

    it('should handle null delay_reasons', async () => {
      const result = await client.getDelayInfo({
        rid: '202601150800456',
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_reasons).toBeNull();
    });
  });

  // ==========================================================================
  // AC-3: Empty services array → zero-delay sentinel (NOT throw)
  // ==========================================================================

  describe('AC-3: Empty services array returns zero-delay sentinel', () => {
    /**
     * CRITICAL BEHAVIOR: When darwin-ingestor returns { services: [] } (RID not found
     * or train on time), getDelayInfo() MUST return a zero-delay sentinel object
     * so the handler publishes delay.not-detected reason=below_threshold.
     *
     * Current code: throws 404 error → handler publishes darwin_unavailable (WRONG)
     * Required code: returns { delay_minutes: 0, is_cancelled: false } (CORRECT)
     */

    it('should return zero-delay sentinel when services array is empty (was: throwing 404)', async () => {
      const result = await client.getDelayInfo({
        rid: 'unknown-rid-12345',
        service_date: '2026-02-10',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      // This is the zero-delay sentinel - allows handler to publish below_threshold
      expect(result).toEqual({
        rid: 'unknown-rid-12345',
        delay_minutes: 0,
        is_cancelled: false,
        delay_reasons: null,
      });
    });

    it('should NOT throw when services array is empty', async () => {
      await expect(
        client.getDelayInfo({
          rid: 'unknown-rid-12345',
          service_date: '2026-02-10',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
        })
      ).resolves.not.toThrow();
    });

    it('should return zero-delay sentinel for train on time (empty darwin response)', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json({ services: [] });
        })
      );

      const result = await client.getDelayInfo({
        rid: 'on-time-rid',
        service_date: '2026-02-10',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_minutes).toBe(0);
      expect(result.is_cancelled).toBe(false);
      expect(result.delay_reasons).toBeNull();
    });
  });

  // ==========================================================================
  // AC-4: delay_minutes >= 15 returns correct DarwinDelayInfo
  // ==========================================================================

  describe('AC-4: delay_minutes >= 15 returns correct DarwinDelayInfo', () => {
    /**
     * Handler threshold logic: delay_minutes >= 15 OR is_cancelled → delay.detected
     * getDelayInfo() must return accurate delay data for threshold checks
     */

    it('should return delay data when delay_minutes = 15 (threshold)', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json({
            services: [
              {
                rid: '202601150800999',
                delay_minutes: 15,
                is_cancelled: false,
                delay_reasons: [{ code: '123' }],
              },
            ],
          });
        })
      );

      const result = await client.getDelayInfo({
        rid: '202601150800999',
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_minutes).toBe(15);
      expect(result.is_cancelled).toBe(false);
    });

    it('should return delay data when delay_minutes = 20 (above threshold)', async () => {
      const result = await client.getDelayInfo({
        rid: '202601150800123',
        service_date: '2026-01-15',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_minutes).toBe(20);
      expect(result.is_cancelled).toBe(false);
      expect(result.delay_reasons).toEqual([{ code: '576', text: 'Signal failure' }]);
    });

    it('should return delay data when delay_minutes = 34 (significant delay)', async () => {
      const result = await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.delay_minutes).toBe(34);
      expect(result.is_cancelled).toBe(false);
    });
  });

  // ==========================================================================
  // AC-5: Network error/timeout throws error (caught by handler)
  // ==========================================================================

  describe('AC-5: Network error/timeout throws error', () => {
    /**
     * When darwin-ingestor is unreachable (network error, timeout), getDelayInfo()
     * MUST throw so the handler catch block publishes darwin_unavailable.
     */

    it('should throw on network error', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.error();
        })
      );

      await expect(
        client.getDelayInfo({
          rid: '202602098022634',
          service_date: '2026-02-09',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
        })
      ).rejects.toThrow();
    });

    it('should throw "timeout" error on AbortError', async () => {
      const shortTimeoutClient = new DarwinIngestorClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1, // 1ms timeout
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(delayedServiceResponse);
        })
      );

      await expect(
        shortTimeoutClient.getDelayInfo({
          rid: '202602098022634',
          service_date: '2026-02-09',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
        })
      ).rejects.toThrow(/timeout/i);
    });

    it('should throw on 500 Internal Server Error', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        })
      );

      await expect(
        client.getDelayInfo({
          rid: '202602098022634',
          service_date: '2026-02-09',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
        })
      ).rejects.toThrow('Darwin API error: 500 Internal Server Error');
    });

    it('should throw on 503 Service Unavailable', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 503, statusText: 'Service Unavailable' });
        })
      );

      await expect(
        client.getDelayInfo({
          rid: '202602098022634',
          service_date: '2026-02-09',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
        })
      ).rejects.toThrow('Darwin API error: 503 Service Unavailable');
    });
  });

  // ==========================================================================
  // AC-6: Existing getDelaysByRids() is unaffected
  // ==========================================================================

  describe('AC-6: Existing getDelaysByRids() batch method unaffected', () => {
    /**
     * getDelaysByRids() already uses POST /api/v1/delays correctly.
     * Verify it continues to work after getDelayInfo() fix.
     */

    it('should still return array of delay data from getDelaysByRids()', async () => {
      const result = await client.getDelaysByRids([
        '202602098022634',
        '202601150800123',
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].rid).toBe('202602098022634');
      expect(result[1].rid).toBe('202601150800123');
    });

    it('should return empty array for empty RIDs input (getDelaysByRids)', async () => {
      const result = await client.getDelaysByRids([]);
      expect(result).toEqual([]);
    });

    it('should return empty array when no matching RIDs found (getDelaysByRids)', async () => {
      const result = await client.getDelaysByRids(['nonexistent-rid']);
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // Additional Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle response with multiple services (extract first)', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json({
            services: [
              {
                rid: '202602098022634',
                delay_minutes: 34,
                is_cancelled: false,
                delay_reasons: [{ code: '576' }],
              },
              {
                rid: 'other-rid',
                delay_minutes: 10,
                is_cancelled: false,
                delay_reasons: null,
              },
            ],
          });
        })
      );

      const result = await client.getDelayInfo({
        rid: '202602098022634',
        service_date: '2026-02-09',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      // Should extract first element only
      expect(result.rid).toBe('202602098022634');
      expect(result.delay_minutes).toBe(34);
    });

    it('should preserve RID in zero-delay sentinel', async () => {
      const result = await client.getDelayInfo({
        rid: 'unique-rid-999',
        service_date: '2026-02-10',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
      });

      expect(result.rid).toBe('unique-rid-999');
    });

    it('should handle delay_minutes = 0 with is_cancelled = true (cancellation)', async () => {
      const result = await client.getDelayInfo({
        rid: '202601121600234',
        service_date: '2026-01-12',
        origin_crs: 'KGX',
        destination_crs: 'EDN',
      });

      expect(result.delay_minutes).toBe(0);
      expect(result.is_cancelled).toBe(true);
    });
  });
});
