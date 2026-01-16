/**
 * Delay Alert Repository
 *
 * Handles CRUD operations for delay_alerts table
 * Per ADR-001: Schema-per-service isolation (delay_tracker schema)
 */

import { Pool, PoolClient } from 'pg';
import { DelayAlert } from '../types.js';

interface DelayAlertRepositoryConfig {
  pool: Pool;
}

export class DelayAlertRepository {
  private pool: Pool;
  private schema = 'delay_tracker';
  private table = 'delay_alerts';

  constructor(config: DelayAlertRepositoryConfig) {
    this.pool = config.pool;
  }

  /**
   * Create a new delay alert
   */
  async create(alert: Omit<DelayAlert, 'id' | 'created_at' | 'updated_at'>, client?: PoolClient): Promise<DelayAlert> {
    const queryClient = client || this.pool;

    const query = `
      INSERT INTO ${this.schema}.${this.table} (
        monitored_journey_id, delay_minutes, delay_detected_at, delay_reasons,
        is_cancellation, threshold_exceeded,
        claim_triggered, claim_triggered_at, claim_reference_id, claim_trigger_response,
        notification_sent, notification_sent_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const values = [
      alert.monitored_journey_id,
      alert.delay_minutes,
      alert.delay_detected_at || new Date(),
      alert.delay_reasons ? JSON.stringify(alert.delay_reasons) : null,
      alert.is_cancellation || false,
      alert.threshold_exceeded || false,
      alert.claim_triggered || false,
      alert.claim_triggered_at || null,
      alert.claim_reference_id || null,
      // claim_trigger_response is JSONB column - wrap string values in JSON object
      alert.claim_trigger_response
        ? JSON.stringify(typeof alert.claim_trigger_response === 'string'
            ? { message: alert.claim_trigger_response }
            : alert.claim_trigger_response)
        : null,
      alert.notification_sent || false,
      alert.notification_sent_at || null,
    ];

    const result = await queryClient.query(query, values);
    return this.mapRow(result.rows[0]);
  }

  /**
   * Find a delay alert by its ID
   */
  async findById(id: string): Promise<DelayAlert | null> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE id = $1
    `;

    const result = await this.pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find delay alerts by journey ID
   */
  async findByJourneyId(journeyId: string): Promise<DelayAlert[]> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE monitored_journey_id = $1
      ORDER BY delay_detected_at DESC
    `;

    const result = await this.pool.query(query, [journeyId]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Find untriggered claim-eligible delay alerts (delay >= 15 minutes)
   */
  async findUntriggeredClaimEligible(limit = 100): Promise<DelayAlert[]> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE claim_triggered = false
        AND delay_minutes >= 15
      ORDER BY delay_detected_at ASC
      LIMIT $1
    `;

    const result = await this.pool.query(query, [limit]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Mark a delay alert as claim triggered
   * Accepts optional client for transaction support
   */
  async markClaimTriggered(id: string, claimReferenceId: string, client?: PoolClient): Promise<DelayAlert | null> {
    const queryClient = client || this.pool;

    const query = `
      UPDATE ${this.schema}.${this.table}
      SET claim_triggered = true,
          claim_triggered_at = NOW(),
          claim_reference_id = $2
      WHERE id = $1
      RETURNING *
    `;

    const result = await queryClient.query(query, [id, claimReferenceId]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Mark a delay alert as notification sent
   */
  async markNotificationSent(id: string): Promise<DelayAlert | null> {
    const query = `
      UPDATE ${this.schema}.${this.table}
      SET notification_sent = true,
          notification_sent_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const result = await this.pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Update delay alert with partial data
   * Accepts optional client for transaction support
   */
  async update(id: string, updates: Partial<DelayAlert>, client?: PoolClient): Promise<DelayAlert | null> {
    const queryClient = client || this.pool;

    const allowedFields = [
      'delay_minutes', 'delay_reasons', 'is_cancellation', 'threshold_exceeded',
      'claim_triggered', 'claim_triggered_at', 'claim_reference_id', 'claim_trigger_response',
      'notification_sent', 'notification_sent_at',
    ];

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (field in updates) {
        setClauses.push(`${field} = $${paramIndex}`);
        const value = (updates as Record<string, unknown>)[field];
        // Handle JSONB fields: delay_reasons and claim_trigger_response
        if (field === 'delay_reasons' && value) {
          values.push(JSON.stringify(value));
        } else if (field === 'claim_trigger_response' && value) {
          // Wrap string values in JSON object for JSONB column
          values.push(JSON.stringify(typeof value === 'string' ? { message: value } : value));
        } else {
          values.push(value);
        }
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const query = `
      UPDATE ${this.schema}.${this.table}
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await queryClient.query(query, values);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Delete a delay alert by ID
   */
  async delete(id: string): Promise<boolean> {
    const query = `
      DELETE FROM ${this.schema}.${this.table}
      WHERE id = $1
    `;

    const result = await this.pool.query(query, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Map database row to DelayAlert type
   */
  private mapRow(row: Record<string, unknown>): DelayAlert {
    // Extract claim_trigger_response - if stored as JSON object with message, extract the message
    let claimTriggerResponse: string | null = null;
    if (row.claim_trigger_response) {
      const response = row.claim_trigger_response as Record<string, unknown> | string;
      if (typeof response === 'object' && response !== null && 'message' in response) {
        claimTriggerResponse = response.message as string;
      } else if (typeof response === 'string') {
        claimTriggerResponse = response;
      }
    }

    return {
      id: row.id as string,
      monitored_journey_id: row.monitored_journey_id as string,
      delay_minutes: row.delay_minutes as number,
      delay_detected_at: row.delay_detected_at as Date,
      delay_reasons: row.delay_reasons as Record<string, unknown> | null,
      is_cancellation: row.is_cancellation as boolean,
      threshold_exceeded: row.threshold_exceeded as boolean,
      claim_triggered: row.claim_triggered as boolean,
      claim_triggered_at: row.claim_triggered_at as Date | null,
      claim_reference_id: row.claim_reference_id as string | null,
      claim_trigger_response: claimTriggerResponse,
      notification_sent: row.notification_sent as boolean,
      notification_sent_at: row.notification_sent_at as Date | null,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    };
  }
}
