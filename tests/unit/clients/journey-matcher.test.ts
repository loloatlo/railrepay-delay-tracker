/**
 * Unit Tests: JourneyMatcherClient
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * TD Item: TD-DELAY-001 - External HTTP Clients Not Tested + Architectural Correction
 * Service: delay-tracker
 *
 * Tests for the NEW JourneyMatcherClient that will be created to replace
 * DarwinIngestorClient.resolveRid(). RIDs should be obtained from
 * journey-matcher segments, not from darwin-ingestor.
 *
 * ACCEPTANCE CRITERIA:
 * - AC-3.1: getJourneyWithSegments(journeyId) returns journey with segments including RIDs
 * - AC-3.2: Returns null on 404
 * - AC-3.3: Throws on HTTP error (non-404)
 * - AC-3.4: Throws on timeout
 *
 * NOTE: These tests should FAIL until Blake creates the JourneyMatcherClient.
 * DO NOT modify these tests to make them pass - implement the code instead.
 *
 * TEST LOCK RULE: Blake MUST NOT modify these tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// This import will FAIL until Blake creates the module (TDD RED phase)
// @ts-expect-error - Module does not exist yet
import { JourneyMatcherClient, JourneyWithSegments, JourneySegment } from '../../../src/clients/journey-matcher.js';

// ============================================================================
// Test Fixtures - Real data patterns from journey_matcher schema
// ============================================================================

/**
 * _fixtureMetadata:
 *   source: journey_matcher.journeys + journey_matcher.journey_segments
 *   query: SELECT j.id, j.user_id, s.rid, s.origin_crs, s.destination_crs FROM journeys j JOIN journey_segments s ON j.id = s.journey_id LIMIT 1
 *   sampledAt: 2026-01-17
 *   description: Real journey with segments including RIDs
 */
interface JourneyWithSegmentsFixture {
  id: string;
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  travel_date: string;
  status: string;
  segments: JourneySegmentFixture[];
}

interface JourneySegmentFixture {
  id: string;
  journey_id: string;
  sequence: number;
  rid: string | null;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  toc_code: string;
}

const journeyWithSegmentsResponse: JourneyWithSegmentsFixture = {
  id: 'b2c3d4e5-f6a7-8901-bcde-f23456789012',
  user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  origin_crs: 'KGX',
  destination_crs: 'EDB',
  travel_date: '2026-01-15',
  status: 'confirmed',
  segments: [
    {
      id: 'seg-001-abc123',
      journey_id: 'b2c3d4e5-f6a7-8901-bcde-f23456789012',
      sequence: 1,
      rid: '202601150800123', // RID resolved from GTFS/Darwin
      origin_crs: 'KGX',
      destination_crs: 'EDB',
      scheduled_departure: '2026-01-15T08:00:00Z',
      scheduled_arrival: '2026-01-15T12:30:00Z',
      toc_code: 'GR',
    },
  ],
};

/**
 * Multi-segment journey (with connection)
 */
const multiSegmentJourneyResponse: JourneyWithSegmentsFixture = {
  id: 'c3d4e5f6-a7b8-9012-cdef-34567890abcd',
  user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  origin_crs: 'PAD',
  destination_crs: 'BRI',
  travel_date: '2026-01-20',
  status: 'confirmed',
  segments: [
    {
      id: 'seg-002-def456',
      journey_id: 'c3d4e5f6-a7b8-9012-cdef-34567890abcd',
      sequence: 1,
      rid: '202601200930111',
      origin_crs: 'PAD',
      destination_crs: 'RDG', // Reading (connection point)
      scheduled_departure: '2026-01-20T09:30:00Z',
      scheduled_arrival: '2026-01-20T10:00:00Z',
      toc_code: 'GW',
    },
    {
      id: 'seg-003-ghi789',
      journey_id: 'c3d4e5f6-a7b8-9012-cdef-34567890abcd',
      sequence: 2,
      rid: '202601201030222',
      origin_crs: 'RDG',
      destination_crs: 'BRI',
      scheduled_departure: '2026-01-20T10:30:00Z',
      scheduled_arrival: '2026-01-20T11:45:00Z',
      toc_code: 'GW',
    },
  ],
};

/**
 * Journey with segments pending RID resolution
 */
const journeyWithPendingRidResponse: JourneyWithSegmentsFixture = {
  id: 'd4e5f6a7-b8c9-0123-def0-456789abcdef',
  user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  origin_crs: 'MAN',
  destination_crs: 'LDS',
  travel_date: '2026-01-25',
  status: 'pending',
  segments: [
    {
      id: 'seg-004-jkl012',
      journey_id: 'd4e5f6a7-b8c9-0123-def0-456789abcdef',
      sequence: 1,
      rid: null, // Not yet resolved
      origin_crs: 'MAN',
      destination_crs: 'LDS',
      scheduled_departure: '2026-01-25T14:00:00Z',
      scheduled_arrival: '2026-01-25T15:00:00Z',
      toc_code: 'TP',
    },
  ],
};

// ============================================================================
// MSW Server Setup
// ============================================================================

const TEST_BASE_URL = 'http://journey-matcher.test:3000';

const handlers = [
  // Success handler for getJourneyWithSegments
  http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, ({ params }) => {
    const journeyId = params.journeyId;

    if (journeyId === journeyWithSegmentsResponse.id) {
      return HttpResponse.json(journeyWithSegmentsResponse);
    }
    if (journeyId === multiSegmentJourneyResponse.id) {
      return HttpResponse.json(multiSegmentJourneyResponse);
    }
    if (journeyId === journeyWithPendingRidResponse.id) {
      return HttpResponse.json(journeyWithPendingRidResponse);
    }

    // Journey not found
    return new HttpResponse(null, { status: 404, statusText: 'Not Found' });
  }),
];

const server = setupServer(...handlers);

// ============================================================================
// Test Suite
// ============================================================================

describe('TD-DELAY-001: JourneyMatcherClient', () => {
  /**
   * TD CONTEXT: DarwinIngestorClient.resolveRid() calls non-existent endpoint
   * ROOT CAUSE: RIDs are already available in journey-matcher segments
   * REQUIRED FIX: Create JourneyMatcherClient to get journeys with segments (including RIDs)
   * IMPACT: HIGH - Without this, pending_rid journeys cannot transition to active
   */

  let client: JourneyMatcherClient;

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
    client = new JourneyMatcherClient({
      baseUrl: TEST_BASE_URL,
      timeout: 5000,
    });
  });

  // ==========================================================================
  // AC-3.1: getJourneyWithSegments(journeyId) returns journey with segments including RIDs
  // ==========================================================================

  describe('AC-3.1: getJourneyWithSegments() returns journey with segments including RIDs', () => {
    it('should return journey with segments containing RID', async () => {
      const journeyId = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';

      const result = await client.getJourneyWithSegments(journeyId);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(journeyId);
      expect(result!.segments).toHaveLength(1);
      expect(result!.segments[0].rid).toBe('202601150800123');
    });

    it('should return multi-segment journey with all RIDs', async () => {
      const journeyId = 'c3d4e5f6-a7b8-9012-cdef-34567890abcd';

      const result = await client.getJourneyWithSegments(journeyId);

      expect(result).not.toBeNull();
      expect(result!.segments).toHaveLength(2);
      expect(result!.segments[0].rid).toBe('202601200930111');
      expect(result!.segments[1].rid).toBe('202601201030222');
    });

    it('should return journey with null RID when not yet resolved', async () => {
      const journeyId = 'd4e5f6a7-b8c9-0123-def0-456789abcdef';

      const result = await client.getJourneyWithSegments(journeyId);

      expect(result).not.toBeNull();
      expect(result!.segments).toHaveLength(1);
      expect(result!.segments[0].rid).toBeNull();
    });

    it('should include all segment fields', async () => {
      const journeyId = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';

      const result = await client.getJourneyWithSegments(journeyId);

      const segment = result!.segments[0];
      expect(segment).toHaveProperty('id');
      expect(segment).toHaveProperty('journey_id');
      expect(segment).toHaveProperty('sequence');
      expect(segment).toHaveProperty('rid');
      expect(segment).toHaveProperty('origin_crs');
      expect(segment).toHaveProperty('destination_crs');
      expect(segment).toHaveProperty('scheduled_departure');
      expect(segment).toHaveProperty('scheduled_arrival');
      expect(segment).toHaveProperty('toc_code');
    });

    it('should include journey metadata', async () => {
      const journeyId = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';

      const result = await client.getJourneyWithSegments(journeyId);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('user_id');
      expect(result).toHaveProperty('origin_crs');
      expect(result).toHaveProperty('destination_crs');
      expect(result).toHaveProperty('travel_date');
      expect(result).toHaveProperty('status');
    });
  });

  // ==========================================================================
  // AC-3.2: Returns null on 404
  // ==========================================================================

  describe('AC-3.2: Returns null on 404', () => {
    it('should return null when journey not found', async () => {
      const nonExistentJourneyId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

      const result = await client.getJourneyWithSegments(nonExistentJourneyId);

      expect(result).toBeNull();
    });

    it('should return null for any non-existent journey ID', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, () => {
          return new HttpResponse(null, { status: 404, statusText: 'Not Found' });
        })
      );

      const result = await client.getJourneyWithSegments('any-non-existent-id');

      expect(result).toBeNull();
    });

    it('should not throw on 404 response', async () => {
      const nonExistentJourneyId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

      await expect(client.getJourneyWithSegments(nonExistentJourneyId)).resolves.toBeNull();
    });
  });

  // ==========================================================================
  // AC-3.3: Throws on HTTP error (non-404)
  // ==========================================================================

  describe('AC-3.3: Throws on HTTP error (non-404)', () => {
    it('should throw on 500 Internal Server Error', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, () => {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        })
      );

      await expect(client.getJourneyWithSegments('any-id')).rejects.toThrow(
        'Journey Matcher API error: 500 Internal Server Error'
      );
    });

    it('should throw on 503 Service Unavailable', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, () => {
          return new HttpResponse(null, { status: 503, statusText: 'Service Unavailable' });
        })
      );

      await expect(client.getJourneyWithSegments('any-id')).rejects.toThrow(
        'Journey Matcher API error: 503 Service Unavailable'
      );
    });

    it('should throw on 400 Bad Request', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, () => {
          return new HttpResponse(null, { status: 400, statusText: 'Bad Request' });
        })
      );

      await expect(client.getJourneyWithSegments('any-id')).rejects.toThrow(
        'Journey Matcher API error: 400 Bad Request'
      );
    });

    it('should throw on 401 Unauthorized', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, () => {
          return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
        })
      );

      await expect(client.getJourneyWithSegments('any-id')).rejects.toThrow(
        'Journey Matcher API error: 401 Unauthorized'
      );
    });
  });

  // ==========================================================================
  // AC-3.4: Throws on timeout
  // ==========================================================================

  describe('AC-3.4: Throws on timeout', () => {
    it('should throw timeout error when request exceeds timeout', async () => {
      const shortTimeoutClient = new JourneyMatcherClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1, // 1ms timeout
      });

      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(journeyWithSegmentsResponse);
        })
      );

      await expect(
        shortTimeoutClient.getJourneyWithSegments('b2c3d4e5-f6a7-8901-bcde-f23456789012')
      ).rejects.toThrow('Journey Matcher API request timeout');
    });

    it('should throw Error with timeout message', async () => {
      const shortTimeoutClient = new JourneyMatcherClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1,
      });

      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(journeyWithSegmentsResponse);
        })
      );

      try {
        await shortTimeoutClient.getJourneyWithSegments('b2c3d4e5-f6a7-8901-bcde-f23456789012');
        expect.fail('Expected timeout error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('timeout');
      }
    });
  });

  // ==========================================================================
  // Additional Edge Cases for Coverage
  // ==========================================================================

  describe('Configuration and Edge Cases', () => {
    it('should use default timeout of 30000ms when not specified', () => {
      const defaultClient = new JourneyMatcherClient({
        baseUrl: TEST_BASE_URL,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((defaultClient as any).timeout).toBe(30000);
    });

    it('should remove trailing slash from baseUrl', () => {
      const clientWithSlash = new JourneyMatcherClient({
        baseUrl: `${TEST_BASE_URL}/`,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((clientWithSlash as any).baseUrl).toBe(TEST_BASE_URL);
    });

    it('should handle network errors gracefully', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, () => {
          return HttpResponse.error();
        })
      );

      await expect(
        client.getJourneyWithSegments('b2c3d4e5-f6a7-8901-bcde-f23456789012')
      ).rejects.toThrow();
    });

    it('should make GET request to correct endpoint', async () => {
      let capturedUrl: string | null = null;

      server.use(
        http.get(`${TEST_BASE_URL}/api/v1/journeys/:journeyId/segments`, ({ request }) => {
          capturedUrl = new URL(request.url).pathname;
          return HttpResponse.json(journeyWithSegmentsResponse);
        })
      );

      await client.getJourneyWithSegments('b2c3d4e5-f6a7-8901-bcde-f23456789012');

      expect(capturedUrl).toBe('/api/v1/journeys/b2c3d4e5-f6a7-8901-bcde-f23456789012/segments');
    });
  });

  // ==========================================================================
  // Helper Method Tests (for extracting RIDs from segments)
  // ==========================================================================

  describe('Helper Methods', () => {
    it('should provide method to extract all RIDs from segments', async () => {
      const journeyId = 'c3d4e5f6-a7b8-9012-cdef-34567890abcd';

      const result = await client.getJourneyWithSegments(journeyId);
      const rids = client.extractRidsFromSegments(result!.segments);

      expect(rids).toEqual(['202601200930111', '202601201030222']);
    });

    it('should filter out null RIDs when extracting', async () => {
      const journeyId = 'd4e5f6a7-b8c9-0123-def0-456789abcdef';

      const result = await client.getJourneyWithSegments(journeyId);
      const rids = client.extractRidsFromSegments(result!.segments);

      expect(rids).toEqual([]);
    });

    it('should provide method to check if all segments have RIDs', async () => {
      // Journey with all RIDs resolved
      const resolvedJourneyId = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
      const resolvedResult = await client.getJourneyWithSegments(resolvedJourneyId);
      expect(client.allSegmentsHaveRids(resolvedResult!.segments)).toBe(true);

      // Journey with pending RID
      const pendingJourneyId = 'd4e5f6a7-b8c9-0123-def0-456789abcdef';
      const pendingResult = await client.getJourneyWithSegments(pendingJourneyId);
      expect(client.allSegmentsHaveRids(pendingResult!.segments)).toBe(false);
    });
  });
});
