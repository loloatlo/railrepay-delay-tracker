/**
 * Metrics route registration helper for DT-001 sync-query extension.
 *
 * Augments the existing /metrics JSON endpoint with sync_query_total
 * and p50/p95/p99 duration fields.
 *
 * Per AC-14: bespoke JSON shape, preserves existing cron/consumer fields.
 */

import { type Express, type Request, type Response } from 'express';
import { MetricsState } from '../metrics/sync-query-metrics.js';

/**
 * Options for additional metrics providers (used by index.ts in production).
 * Both are optional — when absent, cron defaults to {} and consumer is omitted.
 */
export interface MetricsRouteOptions {
  getCronMetrics?: () => Record<string, unknown>;
  getConsumerStats?: () => Record<string, unknown> | null;
}

/**
 * Registers GET /metrics on the provided Express app.
 *
 * When used standalone (tests), the cron section is an empty object stub so
 * the endpoint still satisfies the AC-14 requirement that `cron` is present.
 *
 * When used from index.ts the caller passes options with getCronMetrics/getConsumerStats
 * callbacks so the full cron and consumer stats are included.
 */
export function registerMetricsRoute(
  app: Express,
  metricsState: MetricsState,
  options: MetricsRouteOptions = {},
): void {
  const { getCronMetrics, getConsumerStats } = options;

  app.get('/metrics', (_req: Request, res: Response) => {
    const snapshot = metricsState.getSnapshot();
    const cronData = getCronMetrics ? getCronMetrics() : {};

    const response: Record<string, unknown> = {
      cron: cronData,
      ...snapshot,
    };

    if (getConsumerStats) {
      const consumerStats = getConsumerStats();
      if (consumerStats) {
        response.consumer = consumerStats;
      }
    }

    res.json(response);
  });
}
