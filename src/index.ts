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
import { DelayAlertRepository } from './repositories/delay-alert-repository.js';
import { DarwinIngestorClient } from './clients/darwin-ingestor.js';
import { DelayDetector } from './services/delay-detector.js';
import { EventConsumer } from './consumers/event-consumer.js';
import { createConsumerConfig, ConsumerConfigError } from './consumers/config.js';
import { DelayQueryHandler } from './api/delay-query.handler.js';
import { DelayEnsureHandler } from './api/delay-ensure.handler.js';
import { DelayEvaluationService } from './services/delay-evaluation.service.js';
import { OutboxRepository } from './repositories/outbox-repository.js';
import { createMetricsState } from './metrics/sync-query-metrics.js';
import { TiplocRepository } from './repositories/tiploc-repository.js';
import { SequentialLegWalk, type OtpClient } from './services/sequential-leg-walk.js';

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
const delayAlertRepository = new DelayAlertRepository({ pool });
const outboxRepository = new OutboxRepository({ pool });
// Note: DelayAlertRepository is used by DelayTrackerService for full detection cycles
// The simple cron flow doesn't persist alerts directly - it just checks delays

// DT-001: sync-query metrics state (singleton for this process)
const syncQueryMetricsState = createMetricsState();

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

// Event consumer instance (initialized in start() if Kafka config available)
let eventConsumer: EventConsumer | null = null;

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

// DT-001: GET /delays/:journeyId — synchronous delay-query endpoint
const delayQueryHandler = new DelayQueryHandler({
  journeyRepository,
  delayAlertRepository,
  metricsState: syncQueryMetricsState,
});
delayQueryHandler.register(app);

// ADR-031 / BL-337: POST /delays/ensure — synchronous ensure-on-404 endpoint
// BL-337: Wire SequentialLegWalk for multi-leg final-destination delay (ADR-021)
// Mirrors the pattern in event-consumer.ts:126-151

// BL-181: TiplocRepository — wraps Pool.query to match TiplocRepositoryDeps.dbClient interface
const tiplocRepository = new TiplocRepository({
  dbClient: {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
  },
});

// BL-181: Stub OtpClient — OTP graph is expired; replacement route lookups are deferred.
// Returns null (triggers needs_manual_review → no_data in evaluate()).
// See TD-OTP-REPLACEMENT-001 for remediation tracking.
const stubOtpClient: OtpClient = {
  async findReplacementRoute() {
    return null;
  },
};

const sequentialLegWalk = new SequentialLegWalk({
  tiplocRepository,
  darwinClient,
  otpClient: stubOtpClient,
});

const delayEvaluationService = new DelayEvaluationService({
  journeyRepository,
  delayAlertRepository,
  outboxRepository,
  darwinClient,
  sequentialLegWalk,
});
const delayEnsureHandler = new DelayEnsureHandler({
  journeyRepository,
  delayEvaluationService,
});
delayEnsureHandler.register(app);

// Metrics endpoint (augmented with DT-001 sync-query stats)
app.get('/metrics', async (_req: Request, res: Response) => {
  const cronMetrics = cronScheduler.getMetrics();
  const syncSnapshot = syncQueryMetricsState.getSnapshot();

  const response: any = {
    cron: {
      running: cronScheduler.isRunning(),
      executing: cronScheduler.isExecuting(),
      ...cronMetrics,
    },
    ...syncSnapshot,
  };

  // Include consumer stats if consumer is initialized
  if (eventConsumer) {
    const consumerStats = eventConsumer.getStats();
    response.consumer = {
      running: eventConsumer.isRunning(),
      processedCount: consumerStats.processedCount,
      errorCount: consumerStats.errorCount,
      lastProcessedAt: consumerStats.lastProcessedAt,
      lastError: (consumerStats as any).lastError || null,
      lastErrorAt: (consumerStats as any).lastErrorAt || null,
    };
  }

  res.json(response);
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

    // Start Kafka event consumer (TD-DELAY-TRACKER-003)
    // Graceful degradation: if Kafka env vars missing or connection fails, continue with cron only
    try {
      const consumerConfig = createConsumerConfig();

      // Create simple console logger for EventConsumer (follows journey-matcher pattern)
      const logger = {
        info: (message: string, meta?: Record<string, unknown>) => {
          console.log(`[delay-tracker] ${message}`, meta || '');
        },
        error: (message: string, meta?: Record<string, unknown>) => {
          console.error(`[delay-tracker] ${message}`, meta || '');
        },
        warn: (message: string, meta?: Record<string, unknown>) => {
          console.warn(`[delay-tracker] ${message}`, meta || '');
        },
        debug: (message: string, meta?: Record<string, unknown>) => {
          console.debug(`[delay-tracker] ${message}`, meta || '');
        },
      };

      eventConsumer = new EventConsumer({
        ...consumerConfig,
        db: pool,
        logger,
      });

      console.log('[delay-tracker] Starting Kafka event consumer...', {
        groupId: consumerConfig.groupId,
        brokers: consumerConfig.brokers,
      });
      await eventConsumer.start();
      console.log('[delay-tracker] Kafka event consumer started successfully');
    } catch (error) {
      if (error instanceof ConsumerConfigError) {
        // Missing Kafka config - log warning but continue (cron still works)
        console.warn('[delay-tracker] Kafka consumer not started - missing configuration:', error.message);
      } else {
        // Other errors - log but don't fail startup (graceful degradation)
        console.error('[delay-tracker] Failed to start Kafka consumer:', error instanceof Error ? error.message : String(error));
      }
    }

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

  // Stop cron scheduler FIRST
  if (cronScheduler.isRunning()) {
    await cronScheduler.stop();
    console.log('[delay-tracker] Cron scheduler stopped');
  }

  // Stop event consumer SECOND (TD-DELAY-TRACKER-003)
  if (eventConsumer) {
    console.log('[delay-tracker] Stopping Kafka event consumer...');
    await eventConsumer.stop();
    console.log('[delay-tracker] Kafka event consumer stopped');
  }

  // Close HTTP server THIRD
  if (server) {
    server.close(() => {
      console.log('[delay-tracker] HTTP server closed');
    });
  }

  // Close database pool LAST
  await pool.end();
  console.log('[delay-tracker] Database pool closed');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the service
start();

export { app, pool };
