/**
 * Journey Repository
 *
 * Handles CRUD operations for monitored_journeys table
 * Per ADR-001: Schema-per-service isolation (delay_tracker schema)
 */

import { Pool, PoolClient } from 'pg';
import { MonitoredJourney, MonitoringStatus } from '../types.js';

interface JourneyRepositoryConfig {
  pool: Pool;
}

export class JourneyRepository {
  private pool: Pool;
  private schema = 'delay_tracker';
  private table = 'monitored_journeys';

  constructor(config: JourneyRepositoryConfig) {
    this.pool = config.pool;
  }

  /**
   * Create a new monitored journey
   */
  async create(journey: Omit<MonitoredJourney, 'id' | 'created_at' | 'updated_at'>, client?: PoolClient): Promise<MonitoredJourney> {
    const queryClient = client || this.pool;

    const query = `
      INSERT INTO ${this.schema}.${this.table} (
        user_id, journey_id, rid, service_date, origin_crs, destination_crs,
        scheduled_departure, scheduled_arrival, monitoring_status,
        last_checked_at, next_check_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const values = [
      journey.user_id,
      journey.journey_id,
      journey.rid || null,
      journey.service_date,
      journey.origin_crs,
      journey.destination_crs,
      journey.scheduled_departure,
      journey.scheduled_arrival,
      journey.monitoring_status || 'pending_rid',
      journey.last_checked_at || null,
      journey.next_check_at || null,
    ];

    const result = await queryClient.query(query, values);
    return this.mapRow(result.rows[0]);
  }

  /**
   * Find a journey by its ID
   */
  async findById(id: string): Promise<MonitoredJourney | null> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE id = $1
    `;

    const result = await this.pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find journeys by user ID
   */
  async findByUserId(userId: string): Promise<MonitoredJourney[]> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE user_id = $1
      ORDER BY scheduled_departure DESC
    `;

    const result = await this.pool.query(query, [userId]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Find a journey by its journey_id (external reference)
   */
  async findByJourneyId(journeyId: string): Promise<MonitoredJourney | null> {
    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE journey_id = $1
    `;

    const result = await this.pool.query(query, [journeyId]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find journeys that are due for checking (next_check_at <= now)
   * Only returns active and pending_rid status journeys
   * Accepts optional timestamp for testing with fake timers
   */
  async findJourneysDueForCheck(limit = 100, now?: Date): Promise<MonitoredJourney[]> {
    // Use provided timestamp or default to current time via JavaScript Date
    // This allows tests with fake timers to work correctly
    const checkTime = now ?? new Date();

    const query = `
      SELECT * FROM ${this.schema}.${this.table}
      WHERE next_check_at <= $1
        AND monitoring_status IN ('active', 'pending_rid')
      ORDER BY next_check_at ASC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [checkTime, limit]);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Update a journey with partial data
   */
  async update(id: string, updates: Partial<MonitoredJourney>): Promise<MonitoredJourney | null> {
    const allowedFields = [
      'rid', 'monitoring_status', 'last_checked_at', 'next_check_at',
    ];

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (field in updates) {
        setClauses.push(`${field} = $${paramIndex}`);
        values.push((updates as Record<string, unknown>)[field]);
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

    const result = await this.pool.query(query, values);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Update monitoring status for a journey
   */
  async updateStatus(id: string, status: MonitoringStatus, additionalData?: { rid?: string }): Promise<void> {
    let query = `
      UPDATE ${this.schema}.${this.table}
      SET monitoring_status = $1
      WHERE id = $2
    `;
    const values: unknown[] = [status, id];

    if (additionalData?.rid) {
      query = `
        UPDATE ${this.schema}.${this.table}
        SET monitoring_status = $1, rid = $3
        WHERE id = $2
      `;
      values.push(additionalData.rid);
    }

    await this.pool.query(query, values);
  }

  /**
   * Update last_checked_at and next_check_at for multiple journeys
   */
  async updateLastChecked(ids: string[], checkedAt: Date, nextCheckAt?: Date): Promise<void> {
    if (ids.length === 0) return;

    const query = `
      UPDATE ${this.schema}.${this.table}
      SET last_checked_at = $1, next_check_at = $2
      WHERE id = ANY($3)
    `;

    await this.pool.query(query, [checkedAt, nextCheckAt || null, ids]);
  }

  /**
   * Delete a journey by ID
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
   * Map database row to MonitoredJourney type
   */
  private mapRow(row: Record<string, unknown>): MonitoredJourney {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      journey_id: row.journey_id as string,
      rid: row.rid as string | null,
      service_date: row.service_date instanceof Date
        ? row.service_date.toISOString().split('T')[0]
        : row.service_date as string,
      origin_crs: row.origin_crs as string,
      destination_crs: row.destination_crs as string,
      scheduled_departure: row.scheduled_departure as Date,
      scheduled_arrival: row.scheduled_arrival as Date,
      monitoring_status: row.monitoring_status as MonitoringStatus,
      last_checked_at: row.last_checked_at as Date | null,
      next_check_at: row.next_check_at as Date | null,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    };
  }
}
