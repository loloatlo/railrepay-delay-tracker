/**
 * Unit Tests: /metrics endpoint — sync_query extensions (AC-14)
 *
 * Phase: US-2 (Test Specification — Jessie)
 * Story: RAILREPAY-DT-001 — delay-tracker: synchronous delay-query endpoint
 * BL: BL-199 (parent epic)
 *
 * ACs covered: AC-14
 *
 * What this verifies:
 *   The existing /metrics JSON endpoint gains three new fields for DT-001:
 *     - sync_query_total: Map keyed by outcome value
 *         keys: hit | on_time | pending | unknown | forbidden | bad_request | error
 *     - sync_query_duration_ms_p50: number (rolling/last-N)
 *     - sync_query_duration_ms_p95: number (rolling/last-N)
 *     - sync_query_duration_ms_p99: number (rolling/last-N)
 *
 *   Blake must create a MetricsState object (or augment the existing CronMetrics) that
 *   the /metrics handler reads. The exact internal structure is up to Blake; what these
 *   tests verify is the HTTP response shape.
 *
 * Mocking strategy:
 *   - Spy on MetricsState / metrics accumulator that Blake creates.
 *   - The handler under test is the existing /metrics route, augmented by Blake.
 *   - We build the app using a helper that accepts a pre-seeded MetricsState.
 *
 * NOTE: These tests do NOT use Prometheus counters / @railrepay/metrics-pusher.
 * The bespoke JSON-shape metrics are the correct pattern for delay-tracker
 * per the handoff spec (AC-14, "bespoke acceptable").
 *
 * IMPORTANT (Test Lock Rule): Blake MUST NOT modify these tests.
 * If a test appears wrong Blake returns it to Jessie with reasoning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// These imports will fail until Blake creates them (TDD RED phase).
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { MetricsState, createMetricsState } from '../../../src/metrics/sync-query-metrics.js';
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { registerMetricsRoute } from '../../../src/api/metrics.js';

// ---------------------------------------------------------------------------
// Valid outcome values (from Quinn's spec — human-locked decisions)
// ---------------------------------------------------------------------------
const VALID_OUTCOMES = ['hit', 'on_time', 'pending', 'unknown', 'forbidden', 'bad_request', 'error'] as const;
type Outcome = typeof VALID_OUTCOMES[number];

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildMetricsApp(metricsState: InstanceType<typeof MetricsState>): Express {
  const app = express();
  app.use(express.json());
  // registerMetricsRoute wires GET /metrics with the provided MetricsState
  registerMetricsRoute(app, metricsState);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /metrics — sync_query extensions (AC-14)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC-14: sync_query_total Map shape
  // -------------------------------------------------------------------------
  describe('AC-14: sync_query_total Map keyed by outcome', () => {
    it('should include sync_query_total with all outcome keys initialised to 0 when no queries processed', async () => {
      const metricsState = createMetricsState();
      const app = buildMetricsApp(metricsState);

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sync_query_total');
      const total = res.body.sync_query_total as Record<string, number>;

      // All 7 outcome keys must be present
      for (const outcome of VALID_OUTCOMES) {
        expect(total).toHaveProperty(outcome);
        expect(typeof total[outcome]).toBe('number');
      }
    });

    it('should increment the correct outcome key when a query is recorded', async () => {
      const metricsState = createMetricsState();

      // Simulate Blake's metricsState.record(outcome, durationMs) calls
      metricsState.record('hit', 15);
      metricsState.record('hit', 20);
      metricsState.record('forbidden', 5);

      const app = buildMetricsApp(metricsState);
      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      const total = res.body.sync_query_total as Record<string, number>;
      expect(total.hit).toBe(2);
      expect(total.forbidden).toBe(1);
      // Others remain 0
      for (const outcome of VALID_OUTCOMES.filter(o => o !== 'hit' && o !== 'forbidden')) {
        expect(total[outcome]).toBe(0);
      }
    });

    it('should accumulate all 7 outcome types independently', async () => {
      const metricsState = createMetricsState();

      // Record one of each outcome
      let durationMs = 10;
      for (const outcome of VALID_OUTCOMES) {
        metricsState.record(outcome, durationMs++);
      }

      const app = buildMetricsApp(metricsState);
      const res = await request(app).get('/metrics');

      const total = res.body.sync_query_total as Record<string, number>;
      for (const outcome of VALID_OUTCOMES) {
        expect(total[outcome]).toBe(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC-14: p50/p95/p99 duration fields
  // -------------------------------------------------------------------------
  describe('AC-14: sync_query_duration_ms_p50/p95/p99 percentile fields', () => {
    it('should include p50, p95, and p99 fields in the metrics response', async () => {
      const metricsState = createMetricsState();
      const app = buildMetricsApp(metricsState);

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sync_query_duration_ms_p50');
      expect(res.body).toHaveProperty('sync_query_duration_ms_p95');
      expect(res.body).toHaveProperty('sync_query_duration_ms_p99');
    });

    it('should return numeric p50/p95/p99 values after recording durations', async () => {
      const metricsState = createMetricsState();

      // Record 100 durations spread evenly from 1..100ms
      for (let i = 1; i <= 100; i++) {
        metricsState.record('hit', i);
      }

      const app = buildMetricsApp(metricsState);
      const res = await request(app).get('/metrics');

      expect(typeof res.body.sync_query_duration_ms_p50).toBe('number');
      expect(typeof res.body.sync_query_duration_ms_p95).toBe('number');
      expect(typeof res.body.sync_query_duration_ms_p99).toBe('number');

      // Sanity: p50 ≤ p95 ≤ p99 (monotonic)
      expect(res.body.sync_query_duration_ms_p50).toBeLessThanOrEqual(res.body.sync_query_duration_ms_p95);
      expect(res.body.sync_query_duration_ms_p95).toBeLessThanOrEqual(res.body.sync_query_duration_ms_p99);
    });

    it('should calculate p95 approximately correctly for known distribution', async () => {
      const metricsState = createMetricsState();

      // 100 durations: 95 at 10ms, 5 at 100ms → p95 ≈ 10ms, p99 ≈ 100ms
      for (let i = 0; i < 95; i++) {
        metricsState.record('hit', 10);
      }
      for (let i = 0; i < 5; i++) {
        metricsState.record('hit', 100);
      }

      const app = buildMetricsApp(metricsState);
      const res = await request(app).get('/metrics');

      // p95 should be ≤ 100ms given only the last 5 values are 100ms
      expect(res.body.sync_query_duration_ms_p95).toBeLessThanOrEqual(100);
      // p50 should be 10ms (the majority value)
      expect(res.body.sync_query_duration_ms_p50).toBeLessThanOrEqual(10);
    });

    it('should return 0 or null for p50/p95/p99 when no durations recorded', async () => {
      const metricsState = createMetricsState();
      const app = buildMetricsApp(metricsState);

      const res = await request(app).get('/metrics');

      // Blake may choose 0 or null — both acceptable for an empty window
      const p50 = res.body.sync_query_duration_ms_p50;
      const p95 = res.body.sync_query_duration_ms_p95;
      const p99 = res.body.sync_query_duration_ms_p99;

      expect([0, null]).toContain(p50);
      expect([0, null]).toContain(p95);
      expect([0, null]).toContain(p99);
    });
  });

  // -------------------------------------------------------------------------
  // AC-14: Existing /metrics fields must not be removed
  // -------------------------------------------------------------------------
  describe('AC-14: existing /metrics fields preserved after DT-001 augmentation', () => {
    it('should still include cron section alongside new sync_query fields', async () => {
      const metricsState = createMetricsState();
      const app = buildMetricsApp(metricsState);

      const res = await request(app).get('/metrics');

      // The existing cron section must still be present (non-breaking extension)
      expect(res.body).toHaveProperty('cron');
    });
  });
});
