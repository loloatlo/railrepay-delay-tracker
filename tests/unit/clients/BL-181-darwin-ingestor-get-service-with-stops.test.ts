/**
 * Unit Tests: BL-181 Wiring — DarwinIngestorClient.getServiceWithStops()
 *
 * Phase: TD-1 — Test Specification (Jessie)
 * Workflow ID: TD-BL181-WIRING-001
 * BL Item: BL-181 (TD-DELAY-CALC-001)
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation
 * Service: delay-tracker
 *
 * PROBLEM:
 *   DarwinIngestorClient has no getServiceWithStops(rid) method.
 *   SequentialLegWalk requires a DarwinClient interface with exactly this method.
 *   Without it, the Sequential Leg Walk cannot be wired into the handler.
 *
 * INTERFACES VERIFIED:
 *   // Verified: services/delay-tracker/src/services/sequential-leg-walk.ts
 *   export interface DarwinClient {
 *     getServiceWithStops(rid: string): Promise<DarwinServiceWithStops>;
 *   }
 *   export interface DarwinServiceWithStops {
 *     rid: string;
 *     delay_minutes: number | null;
 *     is_cancelled: boolean;
 *     delay_reasons: Record<string, unknown>[] | null;
 *     status: 'on_time' | 'delayed' | 'cancelled' | 'no_data';
 *     stops: DarwinStop[] | null;
 *   }
 *   export interface DarwinStop {
 *     tiploc_code: string;
 *     scheduled_arrival: string | null;
 *     actual_arrival: string | null;
 *     delay_minutes: number;
 *   }
 *
 *   // Verified: darwin-ingestor-prototype/src/api/batch-delay-routes.ts
 *   // POST /api/v1/delays endpoint returns status + stops fields (after BL-181 Sub-task 2)
 *
 * ACCEPTANCE CRITERIA:
 *   AC-W4: DarwinDelayInfo type in types.ts MUST be extended with status and stops fields
 *   AC-W5: DarwinIngestorClient MUST have getServiceWithStops(rid) method satisfying
 *          the DarwinClient interface in sequential-leg-walk.ts
 *
 * FAIL REASON:
 *   DarwinIngestorClient has no getServiceWithStops() method.
 *   DarwinDelayInfo type has no status or stops fields.
 *   These tests will FAIL until Blake adds both.
 *
 * Test Lock Rule: Blake MUST NOT modify these tests.
 * Per ADR-014 (TDD) and ADR-004 (Vitest).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';
import type { DarwinDelayInfo } from '../../../src/types.js';
// Verified: services/delay-tracker/src/services/sequential-leg-walk.ts
//   DarwinServiceWithStops, DarwinClient, DarwinStop are exported from this module
import type { DarwinServiceWithStops, DarwinClient } from '../../../src/services/sequential-leg-walk.js';

// ============================================================================
// Fixtures
// Source: live E2E evidence for RID 202604058023515 (SIT→GLM, 2026-04-05)
// Darwin DB stops: STNGBRN(53m), RAINHMK(52m), GLNGHMK(51m), CHATHAM(52m),
//                  RCHT(52m), STROOD(52m), GRVSEND(56m), EBSFLTI(58m)
// ============================================================================

const LIVE_RID = '202604058023515';

/**
 * _fixtureMetadata:
 *   source: darwin_ingestor.delay_services + delay_service_stops
 *   rid: 202604058023515 (SIT→GLM, 2026-04-05)
 *   sampledAt: 2026-04-05
 *   description: Live service demonstrating stops join gap
 */
const serviceWithStopsResponse = {
  services: [
    {
      rid: LIVE_RID,
      delay_minutes: 58,
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: [
        { tiploc_code: 'STNGBRN', scheduled_arrival: '2026-04-05T10:00:00Z', actual_arrival: '2026-04-05T10:53:00Z', delay_minutes: 53 },
        { tiploc_code: 'RAINHMK', scheduled_arrival: '2026-04-05T10:10:00Z', actual_arrival: '2026-04-05T11:02:00Z', delay_minutes: 52 },
        { tiploc_code: 'GLNGHMK', scheduled_arrival: '2026-04-05T10:20:00Z', actual_arrival: '2026-04-05T11:11:00Z', delay_minutes: 51 },
        { tiploc_code: 'CHATHAM', scheduled_arrival: '2026-04-05T10:30:00Z', actual_arrival: '2026-04-05T11:22:00Z', delay_minutes: 52 },
        { tiploc_code: 'RCHT',    scheduled_arrival: '2026-04-05T10:35:00Z', actual_arrival: '2026-04-05T11:27:00Z', delay_minutes: 52 },
        { tiploc_code: 'STROOD',  scheduled_arrival: '2026-04-05T10:42:00Z', actual_arrival: '2026-04-05T11:34:00Z', delay_minutes: 52 },
        { tiploc_code: 'GRVSEND', scheduled_arrival: '2026-04-05T10:48:00Z', actual_arrival: '2026-04-05T11:44:00Z', delay_minutes: 56 },
        { tiploc_code: 'EBSFLTI', scheduled_arrival: '2026-04-05T10:58:00Z', actual_arrival: '2026-04-05T11:56:00Z', delay_minutes: 58 },
      ],
    },
  ] as DarwinServiceWithStops[],
};

const noDataServiceResponse = {
  services: [
    {
      rid: 'RID-NO-DATA',
      delay_minutes: null,
      is_cancelled: false,
      delay_reasons: null,
      status: 'no_data',
      stops: null,
    },
  ] as DarwinServiceWithStops[],
};

const cancelledServiceResponse = {
  services: [
    {
      rid: 'RID-CANCELLED',
      delay_minutes: null,
      is_cancelled: true,
      delay_reasons: null,
      status: 'cancelled',
      stops: null,
    },
  ] as DarwinServiceWithStops[],
};

const onTimeServiceResponse = {
  services: [
    {
      rid: 'RID-ONTIME',
      delay_minutes: 0,
      is_cancelled: false,
      delay_reasons: null,
      status: 'on_time',
      stops: [],
    },
  ] as DarwinServiceWithStops[],
};

// ============================================================================
// MSW Server
// ============================================================================

const TEST_BASE_URL = 'http://darwin-ingestor.test:3000';

const server = setupServer(
  // Default handler: returns service with stops for LIVE_RID
  http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
    const body = await request.json() as { rids: string[] };
    const rid = body.rids[0];
    if (rid === LIVE_RID) {
      return HttpResponse.json(serviceWithStopsResponse);
    }
    return HttpResponse.json({ services: [] });
  })
);

// ============================================================================
// Test Suite
// ============================================================================

describe('BL-181 Wiring: DarwinIngestorClient.getServiceWithStops()', () => {
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
  // AC-W4: DarwinDelayInfo type extended with status and stops fields
  // ==========================================================================

  describe('AC-W4: DarwinDelayInfo type includes status and stops', () => {
    it('should accept a DarwinDelayInfo object with status field (type check)', () => {
      // This test verifies that the TypeScript type DarwinDelayInfo includes 'status'.
      // If it compiles, the type has the field. If DarwinDelayInfo lacks 'status',
      // TypeScript will error and the test suite cannot run.
      //
      // FAILS CURRENTLY: DarwinDelayInfo in types.ts has no 'status' field.
      const delayInfo: DarwinDelayInfo = {
        rid: LIVE_RID,
        delay_minutes: 58,
        is_cancelled: false,
        delay_reasons: null,
        // AC-W4: these fields must exist on DarwinDelayInfo
        status: 'delayed',
        stops: [
          { tiploc_code: 'GLNGHMK', scheduled_arrival: '2026-04-05T10:20:00Z', actual_arrival: '2026-04-05T11:11:00Z', delay_minutes: 51 },
        ],
      };

      expect(delayInfo.status).toBe('delayed');
      expect(Array.isArray(delayInfo.stops)).toBe(true);
    });

    it('should accept DarwinDelayInfo with status: "no_data" and stops: null', () => {
      // FAILS CURRENTLY: DarwinDelayInfo has no status or stops fields
      const delayInfo: DarwinDelayInfo = {
        rid: 'RID-NO-DATA',
        delay_minutes: null,
        is_cancelled: false,
        delay_reasons: null,
        status: 'no_data',
        stops: null,
      };

      expect(delayInfo.status).toBe('no_data');
      expect(delayInfo.stops).toBeNull();
    });

    it('should accept DarwinDelayInfo with status: "on_time" and empty stops array', () => {
      // FAILS CURRENTLY: DarwinDelayInfo has no status or stops fields
      const delayInfo: DarwinDelayInfo = {
        rid: 'RID-ONTIME',
        delay_minutes: 0,
        is_cancelled: false,
        delay_reasons: null,
        status: 'on_time',
        stops: [],
      };

      expect(delayInfo.status).toBe('on_time');
      expect(delayInfo.stops).toEqual([]);
    });
  });

  // ==========================================================================
  // AC-W5: DarwinIngestorClient has getServiceWithStops() method
  // ==========================================================================

  describe('AC-W5: getServiceWithStops() method exists and calls POST /api/v1/delays', () => {
    it('should expose a getServiceWithStops method on the client', () => {
      // FAILS CURRENTLY: DarwinIngestorClient has no getServiceWithStops method
      expect(typeof (client as unknown as { getServiceWithStops: unknown }).getServiceWithStops).toBe('function');
    });

    it('should return a DarwinServiceWithStops object for a known RID', async () => {
      // FAILS CURRENTLY: method does not exist
      // Verified endpoint: darwin-ingestor-prototype/src/api/batch-delay-routes.ts
      //   POST /api/v1/delays (after BL-181 Sub-task 2)
      const result = await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops(LIVE_RID);

      expect(result.rid).toBe(LIVE_RID);
      expect(result.status).toBeDefined();
      expect(result).toHaveProperty('stops');
    });

    it('should return stop-level data with tiploc_code, scheduled_arrival, actual_arrival, delay_minutes', async () => {
      // FAILS CURRENTLY: method does not exist
      const result = await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops(LIVE_RID);

      expect(result.stops).not.toBeNull();
      expect(result.stops!).toHaveLength(8);

      // Verify the Gillingham (GLM) stop — TIPLOC GLNGHMK — is present with 51 min delay
      const glmStop = result.stops!.find(s => s.tiploc_code === 'GLNGHMK');
      expect(glmStop).toBeDefined();
      expect(glmStop!.delay_minutes).toBe(51);
      expect(glmStop!.actual_arrival).toBe('2026-04-05T11:11:00Z');
    });

    it('should return status "delayed" for the live SIT→GLM service', async () => {
      // FAILS CURRENTLY: method does not exist
      const result = await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops(LIVE_RID);

      expect(result.status).toBe('delayed');
      expect(result.is_cancelled).toBe(false);
    });

    it('should return status "no_data" and stops: null when darwin-ingestor has no data', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json(noDataServiceResponse);
        })
      );

      // FAILS CURRENTLY: method does not exist
      const result = await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops('RID-NO-DATA');

      expect(result.status).toBe('no_data');
      expect(result.stops).toBeNull();
    });

    it('should return status "cancelled" and is_cancelled: true for a cancelled service', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json(cancelledServiceResponse);
        })
      );

      // FAILS CURRENTLY: method does not exist
      const result = await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops('RID-CANCELLED');

      expect(result.status).toBe('cancelled');
      expect(result.is_cancelled).toBe(true);
    });

    it('should return a no_data sentinel when darwin-ingestor returns empty services array', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return HttpResponse.json({ services: [] });
        })
      );

      // FAILS CURRENTLY: method does not exist
      const result = await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops('RID-NOT-FOUND');

      // When no service is found, the method should return a no_data sentinel
      expect(result.status).toBe('no_data');
      expect(result.stops).toBeNull();
      expect(result.rid).toBe('RID-NOT-FOUND');
    });

    it('should throw when darwin-ingestor returns a non-2xx status', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, () => {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        })
      );

      // FAILS CURRENTLY: method does not exist
      await expect(
        (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
          .getServiceWithStops(LIVE_RID)
      ).rejects.toThrow();
    });

    it('should strip GTFS prefix from RID before calling darwin-ingestor (BL-179 parity)', async () => {
      // BL-179 established that GTFS-prefixed RIDs must be stripped.
      // getServiceWithStops should apply the same stripping as getDelaysByRids.
      let capturedBody: { rids: string[] } | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/delays`, async ({ request }) => {
          capturedBody = await request.json() as { rids: string[] };
          return HttpResponse.json(serviceWithStopsResponse);
        })
      );

      const prefixedRid = `1:${LIVE_RID}`;
      await (client as unknown as { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> })
        .getServiceWithStops(prefixedRid);

      // FAILS CURRENTLY: method does not exist
      expect(capturedBody).not.toBeNull();
      // Must strip the "1:" prefix before sending to darwin-ingestor
      expect(capturedBody!.rids[0]).toBe(LIVE_RID);
    });
  });

  // ==========================================================================
  // DarwinClient interface satisfaction
  // ==========================================================================

  describe('AC-W5: DarwinIngestorClient satisfies DarwinClient interface', () => {
    it('should be assignable to the DarwinClient interface from sequential-leg-walk', () => {
      // This is a compile-time check — if it fails TypeScript won't compile the file.
      // DarwinClient requires: getServiceWithStops(rid: string): Promise<DarwinServiceWithStops>
      //
      // FAILS CURRENTLY: DarwinIngestorClient has no getServiceWithStops method,
      // so it does not satisfy the DarwinClient interface.
      //
      // Type-level assertion: assign client to the DarwinClient interface type.
      // DarwinClient is imported at the top of this file from sequential-leg-walk.ts.
      // Verified: services/delay-tracker/src/services/sequential-leg-walk.ts
      //   export interface DarwinClient { getServiceWithStops(rid: string): Promise<DarwinServiceWithStops> }
      //
      // If DarwinIngestorClient doesn't satisfy DarwinClient (i.e. lacks getServiceWithStops),
      // the test will fail at runtime when getServiceWithStops is undefined.
      const darwinClient: DarwinClient = client as unknown as DarwinClient;

      expect(darwinClient).toBeDefined();
      expect(typeof darwinClient.getServiceWithStops).toBe('function');
    });
  });
});
