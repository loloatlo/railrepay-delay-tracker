/**
 * RED Tests: JourneyRepository.findSegmentsByJourneyId — new method
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-315
 * ADR     : ADR-031 — Option (f) synchronous ensure-on-404
 * Date    : 2026-06-12
 * Bug     : Bug 1 (primary, delay-tracker) — JourneyRepository has no
 *           findSegmentsByJourneyId method. The ensure handler needs it to
 *           load segments from journey_matcher.journey_segments when the BFF
 *           sends only {journey_id, user_id} (no segments in body).
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * AC mapping (Bug 1):
 *   BL315-repo-seg-1: JourneyRepository.prototype.findSegmentsByJourneyId exists
 *     as a function. FAILS today: method does not exist on the class.
 *
 *   BL315-repo-seg-2: findSegmentsByJourneyId calls pool.query with:
 *     - SQL targeting journey_matcher.journey_segments (cross-schema read)
 *     - WHERE journey_id = $1
 *     - ORDER BY segment_order
 *     - $1 parameter = the journey_id argument
 *     FAILS today: method does not exist.
 *
 *   BL315-repo-seg-3: findSegmentsByJourneyId maps rows to EvaluationSegment
 *     shape: { segment_order, origin_crs, destination_crs, scheduled_departure,
 *     scheduled_arrival, rid, toc_code }. scheduled_departure and
 *     scheduled_arrival must be ISO strings (Date objects converted).
 *     FAILS today: method does not exist.
 *
 *   BL315-repo-seg-4: findSegmentsByJourneyId returns [] (empty array) when no
 *     rows match. FAILS today: method does not exist.
 *
 * Expected RED failure mode for all tests: TypeError — repo.findSegmentsByJourneyId
 * is not a function (method does not exist on JourneyRepository).
 *
 * Real journey data (source: journey_matcher.journey_segments DB query):
 *   journey_id: <BL-315 attested journey>
 *   rid: 202606036701968, toc_code: GR
 *   origin_crs: YRK, destination_crs: KGX
 *   scheduled_departure: 2026-06-03T07:30:00Z
 *
 * SQL Blake must implement (cross-schema read — delay_tracker reads journey_matcher):
 *   SELECT segment_order, origin_crs, destination_crs,
 *          scheduled_departure, scheduled_arrival, rid, toc_code
 *   FROM journey_matcher.journey_segments
 *   WHERE journey_id = $1
 *   ORDER BY segment_order
 *
 * ADR references:
 *   ADR-001 — Schema-per-service isolation (delay_tracker reads journey_matcher r/o)
 *   ADR-014 — TDD
 *   ADR-031 — Synchronous ensure-on-404
 */

import { describe, it, expect, vi } from 'vitest';

// Import the REAL JourneyRepository (not mocked) to test the actual class
import { JourneyRepository } from '../../../src/repositories/journey-repository.js';

// ─── Test journey ID ──────────────────────────────────────────────────────────

const JOURNEY_YRK_KGX = 'b0315000-0001-4000-8000-000000000001';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('BL315 Bug 1: JourneyRepository.findSegmentsByJourneyId — new method', () => {

  // ── BL315-repo-seg-1: method must exist ───────────────────────────────────

  describe('BL315-repo-seg-1: method exists on JourneyRepository', () => {

    it('should expose findSegmentsByJourneyId as a function on JourneyRepository instances', () => {
      /**
       * RED proof: JourneyRepository has no findSegmentsByJourneyId method today.
       * Expected RED failure: typeof repo.findSegmentsByJourneyId === 'undefined'
       * → expect(...).toBe('function') FAILS.
       *
       * Blake must add the method to services/delay-tracker/src/repositories/journey-repository.ts.
       */
      const repo = new JourneyRepository({ pool: {} as any });
      // RED today: method does not exist on the class
      expect(typeof (repo as any).findSegmentsByJourneyId).toBe('function');
    });
  });

  // ── BL315-repo-seg-2: SQL query shape ─────────────────────────────────────

  describe('BL315-repo-seg-2: calls pool.query with correct SQL and params', () => {

    it('should query journey_matcher.journey_segments WHERE journey_id=$1 ORDER BY segment_order', async () => {
      /**
       * Verifies the exact SQL contract Blake must implement:
       *   - Cross-schema table: journey_matcher.journey_segments
       *   - Filter: WHERE journey_id = $1
       *   - Order: ORDER BY segment_order
       *   - Parameter: [journeyId]
       *
       * RED failure: method does not exist → TypeError on call.
       */
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              segment_order: 0,
              origin_crs: 'YRK',
              destination_crs: 'KGX',
              scheduled_departure: new Date('2026-06-03T07:30:00.000Z'),
              scheduled_arrival: new Date('2026-06-03T09:45:00.000Z'),
              rid: '202606036701968',
              toc_code: 'GR',
            },
          ],
        }),
      };

      const repo = new JourneyRepository({ pool: mockPool as any });

      // RED: method does not exist → throws
      await (repo as any).findSegmentsByJourneyId(JOURNEY_YRK_KGX);

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];

      // Must target journey_matcher.journey_segments (cross-schema)
      expect(sql).toMatch(/journey_matcher\.journey_segments/i);
      // Must filter by journey_id
      expect(sql).toMatch(/WHERE\s+journey_id\s*=\s*\$1/i);
      // Must order by segment_order
      expect(sql).toMatch(/ORDER BY\s+segment_order/i);
      // Parameter must be the journey_id
      expect(params[0]).toBe(JOURNEY_YRK_KGX);
    });
  });

  // ── BL315-repo-seg-3: row mapping ─────────────────────────────────────────

  describe('BL315-repo-seg-3: maps DB rows to EvaluationSegment shape', () => {

    it('should map DB row to EvaluationSegment with ISO string dates', async () => {
      /**
       * DB rows have scheduled_departure/arrival as Date objects (pg driver).
       * EvaluationSegment expects ISO strings (for DelayEvaluationService.evaluate()).
       *
       * RED failure: method does not exist.
       * GREEN: returns array with segment_order=0, rid='202606036701968',
       *   origin_crs='YRK', destination_crs='KGX', toc_code='GR',
       *   scheduled_departure='2026-06-03T07:30:00.000Z' (ISO string).
       */
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              segment_order: 0,
              origin_crs: 'YRK',
              destination_crs: 'KGX',
              scheduled_departure: new Date('2026-06-03T07:30:00.000Z'),
              scheduled_arrival: new Date('2026-06-03T09:45:00.000Z'),
              rid: '202606036701968',
              toc_code: 'GR',
            },
          ],
        }),
      };

      const repo = new JourneyRepository({ pool: mockPool as any });
      const segments = await (repo as any).findSegmentsByJourneyId(JOURNEY_YRK_KGX);

      expect(Array.isArray(segments)).toBe(true);
      expect(segments).toHaveLength(1);

      const seg = segments[0] as Record<string, unknown>;
      expect(seg.segment_order).toBe(0);
      expect(seg.origin_crs).toBe('YRK');
      expect(seg.destination_crs).toBe('KGX');
      expect(seg.rid).toBe('202606036701968');
      expect(seg.toc_code).toBe('GR');

      // Dates must be ISO strings, not Date objects
      expect(typeof seg.scheduled_departure).toBe('string');
      expect(typeof seg.scheduled_arrival).toBe('string');
      expect((seg.scheduled_departure as string)).toMatch(/^2026-06-03T07:30:00/);
      expect((seg.scheduled_arrival as string)).toMatch(/^2026-06-03T09:45:00/);
    });

    it('should handle multiple segments ordered by segment_order', async () => {
      /**
       * Multi-segment journey: segments must be in segment_order order.
       * Real journeys can have connections (e.g., YRK→LDS→KGX).
       *
       * RED failure: method does not exist.
       */
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              segment_order: 0,
              origin_crs: 'YRK',
              destination_crs: 'LDS',
              scheduled_departure: new Date('2026-06-03T07:30:00.000Z'),
              scheduled_arrival: new Date('2026-06-03T08:00:00.000Z'),
              rid: '202606036701968',
              toc_code: 'GR',
            },
            {
              segment_order: 1,
              origin_crs: 'LDS',
              destination_crs: 'KGX',
              scheduled_departure: new Date('2026-06-03T08:10:00.000Z'),
              scheduled_arrival: new Date('2026-06-03T10:30:00.000Z'),
              rid: '202606036701969',
              toc_code: 'GR',
            },
          ],
        }),
      };

      const repo = new JourneyRepository({ pool: mockPool as any });
      const segments = await (repo as any).findSegmentsByJourneyId(JOURNEY_YRK_KGX);

      expect(segments).toHaveLength(2);
      expect((segments[0] as Record<string, unknown>).segment_order).toBe(0);
      expect((segments[1] as Record<string, unknown>).segment_order).toBe(1);
      expect((segments[0] as Record<string, unknown>).rid).toBe('202606036701968');
      expect((segments[1] as Record<string, unknown>).rid).toBe('202606036701969');
    });
  });

  // ── BL315-repo-seg-4: empty result ─────────────────────────────────────────

  describe('BL315-repo-seg-4: returns empty array when no segments found', () => {

    it('should return [] when journey_matcher.journey_segments has no row for journey_id', async () => {
      /**
       * Edge case: journey_id has no segments yet (e.g., journey-matcher has not
       * persisted them). The handler must handle [] gracefully (return no_data
       * rather than crashing).
       *
       * RED failure: method does not exist.
       */
      const mockPool = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const repo = new JourneyRepository({ pool: mockPool as any });
      const segments = await (repo as any).findSegmentsByJourneyId('no-such-journey');

      expect(Array.isArray(segments)).toBe(true);
      expect(segments).toHaveLength(0);
    });
  });
});
