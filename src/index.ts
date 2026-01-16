/**
 * Delay Tracker Service - Main Entry Point
 *
 * A cron-based service that monitors registered journeys for delays
 * and triggers claims when eligible.
 *
 * Responsibilities:
 *   - Expose health endpoints (GET /health, /health/live, /health/ready)
 *   - Run delay detection cycle every 5 minutes
 *   - Graceful shutdown handling
 *
 * Per ADR-008: Health endpoint requirements
 * Per ADR-001: Schema-per-service isolation (delay_tracker schema)
 * Per Deployment Readiness Standards: Configured for Railway proxy environment
 */

import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import 'dotenv/config';

import { HealthController } from './api/health.js';
import { DatabaseHealthChecker } from './health/database-checker.js';
import { CronScheduler } from './cron/scheduler.js';
import { DelayChecker } from './services/delay-checker.js';
import { JourneyMonitor } from './services/journey-monitor.js';
import { JourneyRepository } from './repositories/journey-repository.js';
import { DarwinIngestorClient } from './clients/darwin-ingestor.js';
import { DelayDetector } from './services/delay-detector.js';

// Configuration from environment
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'railrepay',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  },
  cron: {
    expression: process.env.CRON_EXPRESSION || '*/5 * * * *',
    enabled: process.env.CRON_ENABLED !== 'false',
  },
  services: {
    darwinIngestorUrl: process.env.DARWIN_INGESTOR_URL || 'http://darwin-ingestor:3000',
    eligibilityEngineUrl: process.env.ELIGIBILITY_ENGINE_URL || 'http://eligibility-engine:3000',
  },
  delayThreshold: parseInt(process.env.DELAY_THRESHOLD_MINUTES || '15', 10),
};

// Initialize Express app
const app = express();

// CRITICAL: Required for Railway/proxy environments (Deployment Readiness Standard)
app.set('trust proxy', true);

// Middleware
app.use(express.json());

// Initialize database pool
const pool = new Pool(
  config.database.connectionString
    ? { connectionString: config.database.connectionString, ssl: config.database.ssl }
    : {
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        database: config.database.database,
        ssl: config.database.ssl,
      }
);

// Initialize components
const journeyRepository = new JourneyRepository({ pool });
// Note: DelayAlertRepository is used by DelayTrackerService for full detection cycles
// The simple cron flow doesn't persist alerts directly - it just checks delays

const darwinClient = new DarwinIngestorClient({
  baseUrl: config.services.darwinIngestorUrl,
});

const journeyMonitor = new JourneyMonitor({
  repository: journeyRepository,
});

const delayDetector = new DelayDetector({
  thresholdMinutes: config.delayThreshold,
});

const delayChecker = new DelayChecker({
  delayDetector,
  darwinClient,
});

const cronScheduler = new CronScheduler({
  delayChecker,
  journeyMonitor,
  cronExpression: config.cron.expression,
});

const databaseChecker = new DatabaseHealthChecker({ pool });
const healthController = new HealthController({
  databaseChecker,
  serviceName: 'delay-tracker',
  version: process.env.npm_package_version || '0.1.0',
});

// Health endpoints
app.get('/health', async (_req: Request, res: Response) => {
  const response = await healthController.getHealth();
  res.status(response.status).type(response.contentType).json(response.body);
});

app.get('/health/live', async (_req: Request, res: Response) => {
  const response = await healthController.getLiveness();
  res.status(response.status).json(response.body);
});

app.get('/health/ready', async (_req: Request, res: Response) => {
  const response = await healthController.getReadiness();
  res.status(response.status).json(response.body);
});

// Metrics endpoint (basic for now - can be enhanced with prom-client)
app.get('/metrics', async (_req: Request, res: Response) => {
  const cronMetrics = cronScheduler.getMetrics();
  res.json({
    cron: {
      running: cronScheduler.isRunning(),
      executing: cronScheduler.isExecuting(),
      ...cronMetrics,
    },
  });
});

// Start server
let server: ReturnType<typeof app.listen>;

async function start() {
  try {
    // Verify database connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('[delay-tracker] Database connection verified');

    // Start HTTP server
    server = app.listen(config.port, () => {
      console.log(`[delay-tracker] Server started on port ${config.port}`);
      console.log(`[delay-tracker] Environment: ${config.nodeEnv}`);
      console.log(`[delay-tracker] Cron enabled: ${config.cron.enabled}`);
    });

    // Start cron scheduler if enabled
    if (config.cron.enabled) {
      await cronScheduler.start();
      console.log(`[delay-tracker] Cron scheduler started with expression: ${config.cron.expression}`);
    }
  } catch (error) {
    console.error('[delay-tracker] Failed to start service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[delay-tracker] ${signal} received, shutting down gracefully`);

  // Stop cron scheduler
  if (cronScheduler.isRunning()) {
    await cronScheduler.stop();
    console.log('[delay-tracker] Cron scheduler stopped');
  }

  // Close HTTP server
  if (server) {
    server.close(() => {
      console.log('[delay-tracker] HTTP server closed');
    });
  }

  // Close database pool
  await pool.end();
  console.log('[delay-tracker] Database pool closed');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the service
start();

export { app, pool };
