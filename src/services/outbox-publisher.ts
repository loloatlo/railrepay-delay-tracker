/**
 * Outbox Publisher Service
 *
 * Implements transactional outbox pattern for reliable event publishing
 * Per ADR-007: Transactional outbox pattern
 */

import { Pool, PoolClient } from 'pg';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { OutboxEvent, MessageBroker } from '../types.js';
import { randomUUID } from 'crypto';

interface OutboxPublisherConfig {
  repository: OutboxRepository;
  pool: Pool;
  messageBroker?: MessageBroker;
  maxRetries?: number;
}

// Data for delay detected event
interface DelayDetectedData {
  journeyId: string;
  alertId: string;
  userId: string;
  delayMinutes: number;
  delayReasons?: Record<string, unknown>;
  correlationId?: string;
}

// Data for claim triggered event
interface ClaimTriggeredData {
  alertId: string;
  journeyId: string;
  userId: string;
  claimReferenceId: string;
  delayMinutes: number;
  correlationId?: string;
}

// Data for journey completed event
interface JourneyCompletedData {
  journeyId: string;
  userId: string;
  completedAt: Date;
  hadDelay: boolean;
  delayMinutes?: number;
  correlationId?: string;
}

// Data for journey monitoring started event
interface JourneyMonitoringStartedData {
  journeyId: string;
  userId: string;
  monitoredJourneyId: string;
  origin: string;
  destination: string;
  scheduledDeparture: string;
  correlationId?: string;
}

// Re-export OutboxEvent for test imports
export { OutboxEvent };

export class OutboxPublisher {
  private repository: OutboxRepository;
  private pool: Pool;
  private messageBroker?: MessageBroker;
  private maxRetries: number;

  constructor(config: OutboxPublisherConfig) {
    this.repository = config.repository;
    this.pool = config.pool;
    this.messageBroker = config.messageBroker;
    this.maxRetries = config.maxRetries ?? 3;
  }

  /**
   * Publish a delay.detected event
   */
  async publishDelayDetected(data: DelayDetectedData, client?: PoolClient): Promise<void> {
    const correlationId = data.correlationId ?? randomUUID();

    const event: OutboxEvent = {
      event_type: 'delay.detected',
      aggregate_type: 'delay_alert',
      aggregate_id: data.alertId,
      payload: {
        journeyId: data.journeyId,
        alertId: data.alertId,
        userId: data.userId,
        delayMinutes: data.delayMinutes,
        delayReasons: data.delayReasons,
        correlationId,
      },
    };

    await this.repository.create(event, client);
  }

  /**
   * Publish a claim.triggered event
   */
  async publishClaimTriggered(data: ClaimTriggeredData, client?: PoolClient): Promise<void> {
    const correlationId = data.correlationId ?? randomUUID();

    const event: OutboxEvent = {
      event_type: 'claim.triggered',
      aggregate_type: 'delay_alert',
      aggregate_id: data.alertId,
      payload: {
        alertId: data.alertId,
        journeyId: data.journeyId,
        userId: data.userId,
        claimReferenceId: data.claimReferenceId,
        delayMinutes: data.delayMinutes,
        correlationId,
      },
    };

    await this.repository.create(event, client);
  }

  /**
   * Publish a journey.monitoring_started event
   */
  async publishJourneyMonitoringStarted(data: JourneyMonitoringStartedData, client?: PoolClient): Promise<void> {
    const correlationId = data.correlationId ?? randomUUID();

    const event: OutboxEvent = {
      event_type: 'journey.monitoring_started',
      aggregate_type: 'monitored_journey',
      aggregate_id: data.monitoredJourneyId,
      payload: {
        journeyId: data.journeyId,
        userId: data.userId,
        monitoredJourneyId: data.monitoredJourneyId,
        origin: data.origin,
        destination: data.destination,
        scheduledDeparture: data.scheduledDeparture,
        correlationId,
      },
    };

    await this.repository.create(event, client);
  }

  /**
   * Publish a journey.completed event
   */
  async publishJourneyCompleted(data: JourneyCompletedData, client?: PoolClient): Promise<void> {
    const correlationId = data.correlationId ?? randomUUID();

    const event: OutboxEvent = {
      event_type: 'journey.completed',
      aggregate_type: 'monitored_journey',
      aggregate_id: data.journeyId,
      payload: {
        journeyId: data.journeyId,
        userId: data.userId,
        completedAt: data.completedAt.toISOString(),
        hadDelay: data.hadDelay,
        delayMinutes: data.delayMinutes,
        correlationId,
      },
    };

    await this.repository.create(event, client);
  }

  /**
   * Process pending events in the outbox
   * Uses row locking to prevent duplicate processing
   */
  async processOutbox(): Promise<void> {
    if (!this.messageBroker) {
      return;
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Find pending events with row locking
      const events = await this.repository.findPendingForProcessing(100);

      for (const event of events) {
        try {
          await this.messageBroker.publish(event);
          await this.repository.markProcessed(event.id!);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this.repository.markFailed(event.id!, errorMessage);
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retry failed events that haven't exceeded max retries
   */
  async retryFailedEvents(): Promise<void> {
    if (!this.messageBroker) {
      return;
    }

    const failedEvents = await this.repository.findFailedForRetry(this.maxRetries);

    for (const event of failedEvents) {
      try {
        // Reset to pending before retry
        await this.repository.resetToPending(event.id!);
        await this.messageBroker.publish(event);
        await this.repository.markProcessed(event.id!);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await this.repository.markFailed(event.id!, errorMessage);
      }
    }
  }
}
