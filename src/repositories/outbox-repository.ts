/**
 * Outbox Repository
 *
 * Handles CRUD operations for outbox table
 * Per ADR-007: Transactional outbox pattern
 * Per ADR-001: Schema-per-service isolation (delay_tracker schema)
 */

import { Pool, PoolClient } from 'pg';
import { OutboxEvent, OutboxStatus } from '../types.js';

interface OutboxRepositoryConfig {
  pool: Pool;
}

export class OutboxRepository {
  private pool: Pool;
  private schema = 'delay_tracker';
  private table = 'outbox';

  constructor(config: OutboxRepositoryConfig) {
    this.pool = config.pool;
  }

  /**
   * Create a new outbox event
   */
  async create(event: OutboxEvent, client?: PoolClient): Promise<OutboxEvent> {
    const queryClient = client || this.pool;

    const query = `
      INSERT INTO ${this.schema}.${this.table} (
        event_type, aggregate_type, aggregate_id, payload, status, retry_count
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [
      event.event_type,
      event.aggregate_type,
      event.aggregate_id,
      JSON.stringify(event.payload),
      'pending',
      0,
    ];

    const result = await queryClient.query(query, values);
    return this.mapRow(result.rows[0]);
  }

  /**
   * Find an outbox event by ID
   */
  async findById(id: string): Promise<OutboxEvent | null> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE id = $1
    `;

    const result = await this.pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find pending events ordered by creation time (oldest first)
   */
  async findPending(limit = 100): Promise<OutboxEvent[]> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
    `;

    const result = await this.pool.query(query, [limit]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Find pending events with row locking for concurrent processing
   */
  async findPendingForProcessing(limit = 100): Promise<OutboxEvent[]> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const result = await this.pool.query(query, [limit]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Mark an event as processed
   */
  async markProcessed(id: string): Promise<void> {
    const query = `
      UPDATE ${this.schema}.${this.table}
      SET status = 'processed', processed_at = NOW()
      WHERE id = $1
    `;

    await this.pool.query(query, [id]);
  }

  /**
   * Mark an event as failed with error message and increment retry count
   */
  async markFailed(id: string, errorMessage: string): Promise<void> {
    const query = `
      UPDATE ${this.schema}.${this.table}
      SET status = 'failed',
          error_message = $2,
          retry_count = retry_count + 1
      WHERE id = $1
    `;

    await this.pool.query(query, [id, errorMessage]);
  }

  /**
   * Reset a failed event to pending for retry
   */
  async resetToPending(id: string): Promise<void> {
    const query = `
      UPDATE ${this.schema}.${this.table}
      SET status = 'pending', error_message = NULL
      WHERE id = $1
    `;

    await this.pool.query(query, [id]);
  }

  /**
   * Find failed events that are below the max retry count
   */
  async findFailedForRetry(maxRetries: number): Promise<OutboxEvent[]> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE status = 'failed'
        AND retry_count < $1
      ORDER BY created_at ASC
    `;

    const result = await this.pool.query(query, [maxRetries]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Clean up old processed events
   * @param retentionDays Number of days to retain processed events
   * @returns Number of deleted events
   */
  async cleanupOldEvents(retentionDays: number): Promise<number> {
    const query = `
      DELETE FROM ${this.schema}.${this.table}
      WHERE status = 'processed'
        AND created_at < NOW() - INTERVAL '1 day' * $1
    `;

    const result = await this.pool.query(query, [retentionDays]);
    return result.rowCount ?? 0;
  }

  /**
   * Map database row to OutboxEvent type
   */
  private mapRow(row: Record<string, unknown>): OutboxEvent {
    return {
      id: row.id as string,
      event_type: row.event_type as string,
      aggregate_type: row.aggregate_type as string,
      aggregate_id: row.aggregate_id as string,
      payload: row.payload as Record<string, unknown>,
      status: row.status as OutboxStatus,
      retry_count: row.retry_count as number,
      error_message: row.error_message as string | null,
      created_at: row.created_at as Date,
      processed_at: row.processed_at as Date | null,
    };
  }
}
