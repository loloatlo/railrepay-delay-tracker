/**
 * Sync-query metrics state for GET /delays/:journeyId endpoint
 *
 * DT-001: Bespoke JSON-shape metrics (existing delay-tracker pattern).
 * Per AC-14: JSON shape, bespoke acceptable — NOT Prometheus exposition format.
 * TD-DELAY-TRACKER-007 tracks future migration to Prometheus.
 */

import { OutcomeKind } from '../types.js';

const ALL_OUTCOMES: OutcomeKind[] = [
  'hit',
  'on_time',
  'pending',
  'unknown',
  'forbidden',
  'bad_request',
  'error',
];

/**
 * Percentile computation: sort + index lookup.
 * Returns 0 if the array is empty.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  // Clamp to valid index range
  const clampedIdx = Math.min(idx, sorted.length - 1);
  return sorted[clampedIdx];
}

export class MetricsState {
  /** Counters per outcome kind */
  private totals: Map<OutcomeKind, number>;

  /** Rolling duration observations (unbounded — bespoke acceptable per AC-14) */
  private durations: number[];

  constructor() {
    this.totals = new Map(ALL_OUTCOMES.map(o => [o, 0]));
    this.durations = [];
  }

  /**
   * Record a single query outcome and its duration.
   * Called by the handler after each request.
   */
  record(outcome: OutcomeKind, durationMs: number): void {
    const current = this.totals.get(outcome) ?? 0;
    this.totals.set(outcome, current + 1);
    this.durations.push(durationMs);
  }

  /**
   * Return a plain snapshot for JSON serialisation.
   * sync_query_total: plain object keyed by outcome.
   * p50/p95/p99: computed from sorted durations array.
   */
  getSnapshot(): {
    sync_query_total: Record<OutcomeKind, number>;
    sync_query_duration_ms_p50: number | null;
    sync_query_duration_ms_p95: number | null;
    sync_query_duration_ms_p99: number | null;
  } {
    const total = Object.fromEntries(this.totals.entries()) as Record<OutcomeKind, number>;

    if (this.durations.length === 0) {
      return {
        sync_query_total: total,
        sync_query_duration_ms_p50: 0,
        sync_query_duration_ms_p95: 0,
        sync_query_duration_ms_p99: 0,
      };
    }

    const sorted = [...this.durations].sort((a, b) => a - b);

    return {
      sync_query_total: total,
      sync_query_duration_ms_p50: percentile(sorted, 0.5),
      sync_query_duration_ms_p95: percentile(sorted, 0.95),
      sync_query_duration_ms_p99: percentile(sorted, 0.99),
    };
  }
}

/** Factory function used by tests to create a fresh MetricsState instance. */
export function createMetricsState(): MetricsState {
  return new MetricsState();
}
