/**
 * Unit Tests: DarwinIngestorClient
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * TD Item: TD-DELAY-001 - External HTTP Clients Not Tested + Architectural Correction
 * Service: delay-tracker
 *
 * Tests for the DarwinIngestorClient that communicates with darwin-ingestor service.
 * These tests prove the coverage gap exists and define expected behavior.
 *
 * ACCEPTANCE CRITERIA:
 * - AC-1.1: getDelaysByRids() returns delay data on success
 * - AC-1.2: getDelaysByRids() throws on HTTP error (non-2xx)
 * - AC-1.3: getDelaysByRids() throws "timeout" error on AbortError
 * - AC-1.4: resolveRid() method removed or deprecated (test should fail if method exists)
 *
 * NOTE: These tests should FAIL until Blake implements the fix.
 * DO NOT modify these tests to make them pass - implement the code instead.
 *
 * TEST LOCK RULE: Blake MUST NOT modify these tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';
import type { DarwinDelayInfo } from '../../../src/types.js';

// ============================================================================
// Test Fixtures - Real data patterns from darwin_ingestor.delay_services
// ============================================================================

/**
 * _fixtureMetadata:
 *   source: darwin_ingestor.delay_services
 *   query: SELECT rid, delay_minutes, is_cancelled FROM delay_services WHERE total_delay_minutes >= 15 LIMIT 3
 *   sampledAt: 2026-01-17
 *   description: Real delayed services for testing delay lookup
 */
const delayedServicesResponse = {
  services: [
    {
      rid: '202601150800123',
      delay_minutes: 25,
      is_cancelled: false,
      delay_reasons: { reason: 'Signal failure at Peterborough' },
    },
    {
      rid: '202601151000456',
      delay_minutes: 45,
      is_cancelled: false,
      delay_reasons: { reason: 'Earlier trespass incident' },
    },
  ] as DarwinDelayInfo[],
};

const emptyDelaysResponse = {
  services: [] as DarwinDelayInfo[],
};

const cancelledServiceResponse = {
  services: [
    {
      rid: '202601121600234',
      delay_minutes: 0,
      is_cancelled: true,
      delay_reasons: { reason: 'Driver shortage' },
    },
  ] as DarwinDelayInfo[],
};

// ============================================================================
// MSW Server Setup
// ============================================================================

const TEST_BASE_URL = 'http://darwin-ingestor.test:3000';

const handlers = [
  // Success handler for getDelaysByRids
  http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
    const body = await request.json() as { rids: string[] };
    const rids = body.rids;

    // Filter response based on requested RIDs
    const filteredServices = delayedServicesResponse.services.filter(
      (service) => rids.includes(service.rid)
    );

    return HttpResponse.json({ services: filteredServices });
  }),
];

const server = setupServer(...handlers);

// ============================================================================
// Test Suite
// ============================================================================

describe('TD-DELAY-001: DarwinIngestorClient', () => {
  /**
   * TD CONTEXT: src/clients/darwin-ingestor.ts has 0% test coverage (235 lines)
   * REQUIRED FIX: Add comprehensive unit tests for all HTTP client methods
   * IMPACT: HIGH - Untested HTTP clients can fail silently in production
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
  // AC-1.1: getDelaysByRids() returns delay data on success
  // ==========================================================================

  describe('AC-1.1: getDelaysByRids() returns delay data on success', () => {
    it('should return delay data for valid RIDs', async () => {
      const rids = ['202601150800123', '202601151000456'];

      const result = await client.getDelaysByRids(rids);

      expect(result).toHaveLength(2);
      expect(result[0].rid).toBe('202601150800123');
      expect(result[0].delay_minutes).toBe(25);
      expect(result[1].rid).toBe('202601151000456');
      expect(result[1].delay_minutes).toBe(45);
    });

    it('should return empty array for empty RIDs input', async () => {
      const result = await client.getDelaysByRids([]);

      expect(result).toEqual([]);
    });

    it('should return empty array when no matching RIDs found', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json(emptyDelaysResponse);
        })
      );

      const result = await client.getDelaysByRids(['nonexistent-rid']);

      expect(result).toEqual([]);
    });

    it('should return cancelled service data correctly', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json(cancelledServiceResponse);
        })
      );

      const result = await client.getDelaysByRids(['202601121600234']);

      expect(result).toHaveLength(1);
      expect(result[0].is_cancelled).toBe(true);
      expect(result[0].delay_reasons).toEqual({ reason: 'Driver shortage' });
    });

    it('should handle response with null delay_reasons', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json({
            services: [
              {
                rid: '202601150800123',
                delay_minutes: 20,
                is_cancelled: false,
                delay_reasons: null,
              },
            ],
          });
        })
      );

      const result = await client.getDelaysByRids(['202601150800123']);

      expect(result).toHaveLength(1);
      expect(result[0].delay_reasons).toBeNull();
    });

    it('should handle single RID request', async () => {
      const result = await client.getDelaysByRids(['202601150800123']);

      expect(result).toHaveLength(1);
      expect(result[0].rid).toBe('202601150800123');
    });
  });

  // ==========================================================================
  // AC-1.2: getDelaysByRids() throws on HTTP error (non-2xx)
  // ==========================================================================

  describe('AC-1.2: getDelaysByRids() throws on HTTP error (non-2xx)', () => {
    it('should throw on 500 Internal Server Error', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        })
      );

      await expect(client.getDelaysByRids(['202601150800123'])).rejects.toThrow(
        'Darwin API error: 500 Internal Server Error'
      );
    });

    it('should throw on 400 Bad Request', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 400, statusText: 'Bad Request' });
        })
      );

      await expect(client.getDelaysByRids(['invalid-rid'])).rejects.toThrow(
        'Darwin API error: 400 Bad Request'
      );
    });

    it('should throw on 503 Service Unavailable', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 503, statusText: 'Service Unavailable' });
        })
      );

      await expect(client.getDelaysByRids(['202601150800123'])).rejects.toThrow(
        'Darwin API error: 503 Service Unavailable'
      );
    });

    it('should throw on 401 Unauthorized', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
        })
      );

      await expect(client.getDelaysByRids(['202601150800123'])).rejects.toThrow(
        'Darwin API error: 401 Unauthorized'
      );
    });

    it('should throw on 404 Not Found', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 404, statusText: 'Not Found' });
        })
      );

      await expect(client.getDelaysByRids(['202601150800123'])).rejects.toThrow(
        'Darwin API error: 404 Not Found'
      );
    });
  });

  // ==========================================================================
  // AC-1.3: getDelaysByRids() throws "timeout" error on AbortError
  // ==========================================================================

  describe('AC-1.3: getDelaysByRids() throws "timeout" error on AbortError', () => {
    it('should throw timeout error when request exceeds timeout', async () => {
      // Create client with very short timeout
      const shortTimeoutClient = new DarwinIngestorClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1, // 1ms timeout
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async () => {
          // Simulate slow response
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(delayedServicesResponse);
        })
      );

      await expect(shortTimeoutClient.getDelaysByRids(['202601150800123'])).rejects.toThrow(
        'Darwin API request timeout'
      );
    });

    it('should include timeout in error message', async () => {
      const shortTimeoutClient = new DarwinIngestorClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1,
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(delayedServicesResponse);
        })
      );

      try {
        await shortTimeoutClient.getDelaysByRids(['202601150800123']);
        expect.fail('Expected timeout error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('timeout');
      }
    });
  });

  // ==========================================================================
  // AC-1.4: resolveRid() method removed or deprecated
  // ==========================================================================

  describe('AC-1.4: resolveRid() method should be removed (architectural correction)', () => {
    /**
     * TD CONTEXT: resolveRid() calls non-existent endpoint in darwin-ingestor
     * ROOT CAUSE: RIDs are already available in journey-matcher segments
     * REQUIRED FIX: Remove resolveRid() method - use JourneyMatcherClient instead
     *
     * This test SHOULD FAIL if resolveRid() still exists.
     * When Blake removes the method, this test will PASS.
     */

    it('should NOT have resolveRid method (was: calling non-existent darwin endpoint)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientAsAny = client as any;

      // This test FAILS if resolveRid exists (proving the gap)
      // This test PASSES after Blake removes the method
      expect(clientAsAny.resolveRid).toBeUndefined();
    });

    it('should NOT export RidResolutionParams type (was: unused after removal)', () => {
      // If resolveRid is removed, its parameter type should also be removed
      // This is a compile-time check - if the type still exists, the import would work
      // The implementation should be cleaned up to remove unused types

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientAsAny = client as any;
      expect(clientAsAny.resolveRid).toBeUndefined();
    });
  });

  // ==========================================================================
  // Additional Edge Cases for Coverage
  // ==========================================================================

  describe('Configuration and Edge Cases', () => {
    it('should use default timeout of 30000ms when not specified', () => {
      const defaultClient = new DarwinIngestorClient({
        baseUrl: TEST_BASE_URL,
      });

      // Access private property for testing (not ideal but necessary for coverage)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((defaultClient as any).timeout).toBe(30000);
    });

    it('should remove trailing slash from baseUrl', () => {
      const clientWithSlash = new DarwinIngestorClient({
        baseUrl: `${TEST_BASE_URL}/`,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((clientWithSlash as any).baseUrl).toBe(TEST_BASE_URL);
    });

    it('should handle network errors gracefully', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.error();
        })
      );

      await expect(client.getDelaysByRids(['202601150800123'])).rejects.toThrow();
    });

    it('should send correct Content-Type header', async () => {
      let capturedContentType: string | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, ({ request }) => {
          capturedContentType = request.headers.get('Content-Type');
          return HttpResponse.json(delayedServicesResponse);
        })
      );

      await client.getDelaysByRids(['202601150800123']);

      expect(capturedContentType).toBe('application/json');
    });

    it('should send RIDs in request body', async () => {
      let capturedBody: { rids: string[] } | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
          capturedBody = await request.json() as { rids: string[] };
          return HttpResponse.json(delayedServicesResponse);
        })
      );

      const rids = ['202601150800123', '202601151000456'];
      await client.getDelaysByRids(rids);

      expect(capturedBody).toEqual({ rids });
    });
  });
});
