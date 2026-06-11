/**
 * TD-DELAY-TRACKER-003: Event Consumer Wrapper
 *
 * Main EventConsumer wrapper that manages KafkaConsumer lifecycle
 * and wires up JourneyConfirmedHandler to journey.confirmed topic.
 *
 * Pattern reference: journey-matcher/src/consumers/event-consumer.ts
 */

import { Pool } from 'pg';
import { KafkaConsumer } from '@railrepay/kafka-client';
import { JourneyConfirmedHandler } from '../kafka/journey-confirmed-handler.js';
import { JourneyRepository } from '../repositories/journey-repository.js';
import { DelayAlertRepository } from '../repositories/delay-alert-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { DarwinIngestorClient } from '../clients/darwin-ingestor.js';
import { TiplocRepository } from '../repositories/tiploc-repository.js';
import type { OtpClient } from '../services/sequential-leg-walk.js';

/**
 * Logger interface for dependency injection
 */
interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * EventConsumer configuration
 */
export interface EventConsumerConfig {
  serviceName: string;
  brokers: string[];
  username: string;
  password: string;
  groupId: string;
  db: Pool;
  logger: Logger;
  ssl?: boolean;
  /** AC-10 (ADR-031): Kafka session timeout in ms. Must be >= 30000 to survive long Darwin/SLW calls. */
  sessionTimeout?: number;
  /** AC-10 (ADR-031): Kafka heartbeat interval in ms. Must be <= sessionTimeout/3. */
  heartbeatInterval?: number;
}

/**
 * Handler statistics
 */
interface HandlerStats {
  processedCount: number;
  errorCount: number;
  lastProcessedAt: Date | null;
}

/**
 * Consumer statistics
 */
interface ConsumerStats {
  processedCount: number;
  errorCount: number;
  lastProcessedAt: Date | null;
  isRunning: boolean;
  handlers: {
    'journey.confirmed': HandlerStats;
  };
}

/**
 * EventConsumer class
 */
export class EventConsumer {
  private kafkaConsumer: KafkaConsumer;
  private db: Pool;
  private logger: Logger;
  private started: boolean = false;

  // Handler
  private journeyConfirmedHandler: JourneyConfirmedHandler;

  // Stats tracking
  private stats: ConsumerStats = {
    processedCount: 0,
    errorCount: 0,
    lastProcessedAt: null,
    isRunning: false,
    handlers: {
      'journey.confirmed': { processedCount: 0, errorCount: 0, lastProcessedAt: null },
    },
  };

  constructor(config: EventConsumerConfig) {
    this.db = config.db;
    this.logger = config.logger;

    // AC-10 (ADR-031): tuned session/heartbeat so long Darwin/SLW work does not kick the consumer.
    // sessionTimeout defaults to 60000 ms (60 s); heartbeatInterval defaults to 10000 ms (10 s).
    const sessionTimeout = config.sessionTimeout ?? 60000;
    const heartbeatInterval = config.heartbeatInterval ?? Math.floor(sessionTimeout / 3);

    // Create KafkaConsumer with config
    this.kafkaConsumer = new KafkaConsumer({
      serviceName: config.serviceName,
      brokers: config.brokers,
      username: config.username,
      password: config.password,
      groupId: config.groupId,
      logger: config.logger,
      ssl: config.ssl,
      sessionTimeout,
      heartbeatInterval,
    });

    // Get DARWIN_INGESTOR_URL from env (required for handler)
    const darwinIngestorUrl = process.env.DARWIN_INGESTOR_URL || 'http://darwin-ingestor:3000';

    // Create handler dependencies
    const journeyRepository = new JourneyRepository({ pool: this.db });
    const delayAlertRepository = new DelayAlertRepository({ pool: this.db });
    const outboxRepository = new OutboxRepository({ pool: this.db });
    const darwinClient = new DarwinIngestorClient({ baseUrl: darwinIngestorUrl });

    // BL-181: Wire TiplocRepository for Sequential Leg Walk TIPLOC↔CRS resolution
    // Wraps Pool.query to match TiplocRepositoryDeps.dbClient interface (returns rows directly)
    const tiplocRepository = new TiplocRepository({
      dbClient: {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
          const result = await config.db.query(sql, params);
          return result.rows as T[];
        },
      },
    });

    // BL-181: Stub OtpClient — OTP graph is expired and replacement route lookups
    // are not yet functional. Returns null (triggers assessment_pending fallback).
    const otpClient: OtpClient = {
      async findReplacementRoute() {
        return null;
      },
    };

    // Create handler with SequentialLegWalk dependencies (BL-181 AC-W6)
    this.journeyConfirmedHandler = new JourneyConfirmedHandler({
      journeyRepository,
      delayAlertRepository,
      outboxRepository,
      darwinClient,
      tiplocRepository,
      otpClient,
    });
  }

  /**
   * Start the event consumer
   */
  async start(): Promise<void> {
    this.logger.info('Connecting to Kafka', {
      serviceName: 'delay-tracker',
    });

    try {
      // Connect to Kafka
      await this.kafkaConsumer.connect();

      this.logger.info('Successfully connected to Kafka', {
        serviceName: 'delay-tracker',
      });

      // Subscribe to journey.confirmed topic with handler
      this.logger.info('Subscribing to topic', { topic: 'journey.confirmed' });
      await this.kafkaConsumer.subscribe('journey.confirmed', async (message) => {
        try {
          // Parse the Kafka message value to get the actual payload
          if (!message.message.value) {
            this.logger.error('Empty message value received', {
              topic: message.topic,
              offset: message.message.offset,
            });
            return;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(message.message.value.toString());
          } catch (parseError) {
            this.logger.error('Failed to parse message payload', {
              error: parseError instanceof Error ? parseError.message : String(parseError),
              topic: message.topic,
              offset: message.message.offset,
            });
            return;
          }

          // Call handler with parsed payload
          await this.journeyConfirmedHandler.handle(payload as any);
          this.stats.handlers['journey.confirmed'].processedCount++;
          this.stats.handlers['journey.confirmed'].lastProcessedAt = new Date();
          this.stats.processedCount++;
          this.stats.lastProcessedAt = new Date();
        } catch (error) {
          this.stats.handlers['journey.confirmed'].errorCount++;
          this.stats.errorCount++;
          this.logger.error('Handler error for journey.confirmed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          // Store last error for diagnostics via /metrics
          (this.stats as any).lastError = error instanceof Error ? error.message : String(error);
          (this.stats as any).lastErrorAt = new Date().toISOString();
          throw error;
        }
      });

      // Start consuming from all subscribed topics
      this.logger.info('Starting Kafka consumer for all subscribed topics', {
        topics: this.kafkaConsumer.getSubscribedTopics(),
      });
      await this.kafkaConsumer.start();

      this.started = true;
      this.stats.isRunning = true;
    } catch (error) {
      this.logger.error('Failed to connect to Kafka', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stop the event consumer
   */
  async stop(): Promise<void> {
    if (!this.started && !this.kafkaConsumer.isConsumerRunning()) {
      this.logger.warn('Consumer not running, nothing to stop', {
        serviceName: 'delay-tracker',
      });
      return;
    }

    this.logger.info('Shutting down Kafka consumer', {
      serviceName: 'delay-tracker',
    });

    try {
      await this.kafkaConsumer.disconnect();
      this.started = false;
      this.stats.isRunning = false;

      this.logger.info('Successfully disconnected from Kafka', {
        serviceName: 'delay-tracker',
      });
    } catch (error) {
      this.logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.started = false;
      this.stats.isRunning = false;
      // Don't throw - graceful shutdown should not fail
    }
  }

  /**
   * Get consumer statistics
   */
  getStats(): ConsumerStats {
    // Update isRunning from kafka consumer
    this.stats.isRunning = this.kafkaConsumer.isConsumerRunning();

    // Get stats from kafka consumer and merge
    const kafkaStats = this.kafkaConsumer.getStats();
    return {
      ...this.stats,
      processedCount: this.stats.processedCount || kafkaStats.processedCount,
      errorCount: this.stats.errorCount || kafkaStats.errorCount,
      isRunning: this.stats.isRunning,
    };
  }

  /**
   * Check if consumer is running
   */
  isRunning(): boolean {
    // Use internal state combined with kafka consumer state
    // When started is false, return false regardless of kafka consumer state
    if (!this.started) {
      return false;
    }
    return this.kafkaConsumer.isConsumerRunning();
  }
}
