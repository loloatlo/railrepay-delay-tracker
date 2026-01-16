import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import path from 'path';

describe('delay_tracker schema migrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('test_db')
      .start();

    // Create connection pool
    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });

    // Run migrations
    const migrationDir = path.join(__dirname, '../../migrations');
    execSync(`npx node-pg-migrate up -m "${migrationDir}"`, {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  // === Schema Tests ===

  it('should create delay_tracker schema', async () => {
    const result = await pool.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'delay_tracker'
    `);
    expect(result.rows).toHaveLength(1);
  });

  // === monitored_journeys Table Tests ===

  it('should create monitored_journeys table with correct columns', async () => {
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'delay_tracker' AND table_name = 'monitored_journeys'
      ORDER BY ordinal_position
    `);

    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toContain('id');
    expect(columns).toContain('user_id');
    expect(columns).toContain('journey_id');
    expect(columns).toContain('rid');
    expect(columns).toContain('service_date');
    expect(columns).toContain('origin_crs');
    expect(columns).toContain('destination_crs');
    expect(columns).toContain('scheduled_departure');
    expect(columns).toContain('scheduled_arrival');
    expect(columns).toContain('monitoring_status');
    expect(columns).toContain('last_checked_at');
    expect(columns).toContain('next_check_at');
    expect(columns).toContain('created_at');
    expect(columns).toContain('updated_at');
  });

  it('should have unique constraint on journey_id', async () => {
    const result = await pool.query(`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'delay_tracker'
        AND table_name = 'monitored_journeys'
        AND constraint_type = 'UNIQUE'
    `);

    const constraintNames = result.rows.map((r) => r.constraint_name);
    expect(constraintNames.some((name) => name.includes('journey_id'))).toBe(true);
  });

  it('should enforce check constraint on monitoring_status', async () => {
    // First insert a valid row to get a valid user_id/journey_id
    await expect(
      pool.query(`
        INSERT INTO delay_tracker.monitored_journeys (
          user_id, journey_id, service_date, origin_crs, destination_crs,
          scheduled_departure, scheduled_arrival, monitoring_status
        )
        VALUES (
          gen_random_uuid(), gen_random_uuid(), '2026-01-15', 'KGX', 'EDB',
          '2026-01-15 08:00:00+00', '2026-01-15 12:30:00+00', 'invalid_status'
        )
      `)
    ).rejects.toThrow();
  });

  it('should allow valid monitoring_status values', async () => {
    const validStatuses = ['pending_rid', 'active', 'delayed', 'completed', 'cancelled'];

    for (const status of validStatuses) {
      const result = await pool.query(`
        INSERT INTO delay_tracker.monitored_journeys (
          user_id, journey_id, service_date, origin_crs, destination_crs,
          scheduled_departure, scheduled_arrival, monitoring_status
        )
        VALUES (
          gen_random_uuid(), gen_random_uuid(), '2026-01-15', 'KGX', 'EDB',
          '2026-01-15 08:00:00+00', '2026-01-15 12:30:00+00', $1
        )
        RETURNING id
      `, [status]);

      expect(result.rows).toHaveLength(1);
    }
  });

  it('should have partial index on next_check_at for active journeys', async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'delay_tracker' AND tablename = 'monitored_journeys'
    `);

    const nextCheckIndex = result.rows.find((r) =>
      r.indexname.includes('next_check')
    );
    expect(nextCheckIndex).toBeDefined();
    expect(nextCheckIndex.indexdef.toLowerCase()).toContain('where');
  });

  it('should have index on rid and service_date', async () => {
    const result = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'delay_tracker' AND tablename = 'monitored_journeys'
    `);

    const indexNames = result.rows.map((r) => r.indexname);
    expect(indexNames.some((name) => name.includes('rid'))).toBe(true);
  });

  it('should have index on user_id', async () => {
    const result = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'delay_tracker' AND tablename = 'monitored_journeys'
    `);

    const indexNames = result.rows.map((r) => r.indexname);
    expect(indexNames.some((name) => name.includes('user_id'))).toBe(true);
  });

  // === delay_alerts Table Tests ===

  it('should create delay_alerts table with correct columns', async () => {
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'delay_tracker' AND table_name = 'delay_alerts'
    `);

    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toContain('id');
    expect(columns).toContain('monitored_journey_id');
    expect(columns).toContain('delay_minutes');
    expect(columns).toContain('delay_detected_at');
    expect(columns).toContain('delay_reasons');
    expect(columns).toContain('claim_triggered');
    expect(columns).toContain('claim_triggered_at');
    expect(columns).toContain('claim_reference_id');
    expect(columns).toContain('notification_sent');
    expect(columns).toContain('notification_sent_at');
    expect(columns).toContain('created_at');
    expect(columns).toContain('updated_at');
  });

  it('should have FK from delay_alerts to monitored_journeys', async () => {
    const result = await pool.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'delay_tracker'
        AND tc.table_name = 'delay_alerts'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].column_name).toBe('monitored_journey_id');
    expect(result.rows[0].foreign_table_name).toBe('monitored_journeys');
  });

  it('should enforce check constraint on delay_minutes (positive)', async () => {
    // First create a valid monitored_journey
    const journeyResult = await pool.query(`
      INSERT INTO delay_tracker.monitored_journeys (
        user_id, journey_id, service_date, origin_crs, destination_crs,
        scheduled_departure, scheduled_arrival, monitoring_status
      )
      VALUES (
        gen_random_uuid(), gen_random_uuid(), '2026-01-15', 'KGX', 'EDB',
        '2026-01-15 08:00:00+00', '2026-01-15 12:30:00+00', 'active'
      )
      RETURNING id
    `);
    const journeyId = journeyResult.rows[0].id;

    // Try to insert with zero delay - should fail
    await expect(
      pool.query(`
        INSERT INTO delay_tracker.delay_alerts (monitored_journey_id, delay_minutes)
        VALUES ($1, 0)
      `, [journeyId])
    ).rejects.toThrow();

    // Try to insert with negative delay - should fail
    await expect(
      pool.query(`
        INSERT INTO delay_tracker.delay_alerts (monitored_journey_id, delay_minutes)
        VALUES ($1, -5)
      `, [journeyId])
    ).rejects.toThrow();
  });

  it('should allow positive delay_minutes values', async () => {
    // Create a valid monitored_journey
    const journeyResult = await pool.query(`
      INSERT INTO delay_tracker.monitored_journeys (
        user_id, journey_id, service_date, origin_crs, destination_crs,
        scheduled_departure, scheduled_arrival, monitoring_status
      )
      VALUES (
        gen_random_uuid(), gen_random_uuid(), '2026-01-15', 'PAD', 'BRI',
        '2026-01-15 10:00:00+00', '2026-01-15 11:45:00+00', 'delayed'
      )
      RETURNING id
    `);
    const journeyId = journeyResult.rows[0].id;

    // Insert with positive delay - should succeed
    const result = await pool.query(`
      INSERT INTO delay_tracker.delay_alerts (monitored_journey_id, delay_minutes)
      VALUES ($1, 25)
      RETURNING id
    `, [journeyId]);

    expect(result.rows).toHaveLength(1);
  });

  it('should have partial index on delay_alerts for untriggered claims', async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'delay_tracker' AND tablename = 'delay_alerts'
    `);

    const claimIndex = result.rows.find((r) =>
      r.indexdef.toLowerCase().includes('claim_triggered = false')
    );
    expect(claimIndex).toBeDefined();
  });

  it('should cascade delete delay_alerts when monitored_journey is deleted', async () => {
    // Create a monitored_journey
    const journeyResult = await pool.query(`
      INSERT INTO delay_tracker.monitored_journeys (
        user_id, journey_id, service_date, origin_crs, destination_crs,
        scheduled_departure, scheduled_arrival, monitoring_status
      )
      VALUES (
        gen_random_uuid(), gen_random_uuid(), '2026-01-15', 'MAN', 'LDS',
        '2026-01-15 09:00:00+00', '2026-01-15 10:00:00+00', 'delayed'
      )
      RETURNING id
    `);
    const journeyId = journeyResult.rows[0].id;

    // Create a delay_alert linked to it
    await pool.query(`
      INSERT INTO delay_tracker.delay_alerts (monitored_journey_id, delay_minutes)
      VALUES ($1, 20)
    `, [journeyId]);

    // Verify the alert exists
    const beforeDelete = await pool.query(`
      SELECT id FROM delay_tracker.delay_alerts WHERE monitored_journey_id = $1
    `, [journeyId]);
    expect(beforeDelete.rows).toHaveLength(1);

    // Delete the journey
    await pool.query(`
      DELETE FROM delay_tracker.monitored_journeys WHERE id = $1
    `, [journeyId]);

    // Verify the alert was cascade deleted
    const afterDelete = await pool.query(`
      SELECT id FROM delay_tracker.delay_alerts WHERE monitored_journey_id = $1
    `, [journeyId]);
    expect(afterDelete.rows).toHaveLength(0);
  });

  // === outbox Table Tests ===

  it('should create outbox table per standard pattern', async () => {
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'delay_tracker' AND table_name = 'outbox'
    `);

    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toContain('id');
    expect(columns).toContain('aggregate_id');
    expect(columns).toContain('aggregate_type');
    expect(columns).toContain('event_type');
    expect(columns).toContain('payload');
    expect(columns).toContain('correlation_id');
    expect(columns).toContain('status');
    expect(columns).toContain('retry_count');
    expect(columns).toContain('error_message');
    expect(columns).toContain('created_at');
    expect(columns).toContain('processed_at');
    expect(columns).toContain('published_at');
  });

  it('should have partial index on outbox for pending events', async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'delay_tracker' AND tablename = 'outbox'
    `);

    // Index predicate may use different quoting styles
    const pendingIndex = result.rows.find((r) =>
      r.indexdef.toLowerCase().includes('status') &&
      r.indexdef.toLowerCase().includes('pending')
    );
    expect(pendingIndex).toBeDefined();
  });

  it('should allow inserting events to outbox', async () => {
    const result = await pool.query(`
      INSERT INTO delay_tracker.outbox (
        aggregate_id, aggregate_type, event_type, payload, status
      )
      VALUES (
        'journey-123', 'monitored_journey', 'delay.detected',
        '{"delay_minutes": 25, "rid": "202601150800123"}'::jsonb,
        $1
      )
      RETURNING id
    `, ['pending']);

    expect(result.rows).toHaveLength(1);
  });

  // === Rollback Test ===

  it('should rollback cleanly', async () => {
    // Create a fresh container for rollback test
    const rollbackContainer = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('rollback_test')
      .start();

    const rollbackPool = new Pool({
      connectionString: rollbackContainer.getConnectionUri(),
    });

    try {
      const migrationDir = path.join(__dirname, '../../migrations');

      // Run up migration
      execSync(`npx node-pg-migrate up -m "${migrationDir}"`, {
        cwd: path.join(__dirname, '../..'),
        env: { ...process.env, DATABASE_URL: rollbackContainer.getConnectionUri() },
      });

      // Verify schema exists
      let result = await rollbackPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'delay_tracker'
      `);
      expect(result.rows).toHaveLength(1);

      // Run down migration
      execSync(`npx node-pg-migrate down -m "${migrationDir}"`, {
        cwd: path.join(__dirname, '../..'),
        env: { ...process.env, DATABASE_URL: rollbackContainer.getConnectionUri() },
      });

      // Verify schema no longer exists
      result = await rollbackPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'delay_tracker'
      `);
      expect(result.rows).toHaveLength(0);
    } finally {
      await rollbackPool.end();
      await rollbackContainer.stop();
    }
  }, 120000);
});
