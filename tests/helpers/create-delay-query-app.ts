/**
 * Test helper: createDelayQueryApp
 *
 * Returns a real Express app with GET /delays/:journeyId wired up,
 * using a supplied pg.Pool against a Testcontainers PostgreSQL instance.
 *
 * Used by: tests/integration/api/delay-query-endpoint.test.ts
 *
 * This file is in Blake's explicit scope per Jessie's Phase US-2 handoff.
 * Signature: createDelayQueryApp(pool: Pool): Express
 */

import express, { type Express } from 'express';
import { Pool } from 'pg';
import { JourneyRepository } from '../../src/repositories/journey-repository.js';
import { DelayAlertRepository } from '../../src/repositories/delay-alert-repository.js';
import { DelayQueryHandler } from '../../src/api/delay-query.handler.js';
import { createMetricsState } from '../../src/metrics/sync-query-metrics.js';

/**
 * Create a minimal Express app containing only the delay-query endpoint.
 * Real repositories backed by the provided pool — no mocks.
 */
export function createDelayQueryApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());

  // CRITICAL: Required for Railway/proxy environments (Deployment Readiness Standard)
  app.set('trust proxy', true);

  const journeyRepository = new JourneyRepository({ pool });
  const delayAlertRepository = new DelayAlertRepository({ pool });
  const metricsState = createMetricsState();

  const handler = new DelayQueryHandler({
    journeyRepository,
    delayAlertRepository,
    metricsState,
  });

  handler.register(app);

  return app;
}
