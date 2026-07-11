/**
 * Migration Tests: TD-DELAY-TRACKER-002 - darwin_unavailable Status
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * Service: delay-tracker
 * Workflow: Technical Debt Remediation
 *
 * Tests the migration: 1770714617404_add-darwin-unavailable-status.cjs
 * Validates the CHECK constraint change on monitored_journeys.monitoring_status
 *
 * Test scenarios (from RFC-001):
 * - Test 1: New status value 'darwin_unavailable' accepted
 * - Test 2: Invalid status rejected by CHECK constraint
 * - Test 3: Existing 5 statuses still valid
 * - Test 4: Rollback data cleanup (darwin_unavailable → pending_rid)
 *
 * NOTE: These tests use REAL PostgreSQL via Testcontainers.
 * They WILL FAIL if migration is incorrect.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import path from 'path';

describe('Migration: add-darwin-unavailable-status', () => {
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

    // Run ALL migrations to get to current state (including darwin_unavailable)
    // Test Lock reconcile (dt-ci-green): --create-migrations-schema added —
    // --create-schema only creates the --schema option's schema (unset here),
    // so the pgmigrations table creation failed deterministically on every
    // fresh database ("schema delay_tracker does not exist").
    const migrationDir = path.join(__dirname, '../../migrations');
    execSync(
      `npx node-pg-migrate up -m "${migrationDir}" --migrations-schema delay_tracker --migrations-table pgmigrations --create-schema --create-migrations-schema`,
      {
        cwd: path.join(__dirname, '../..'),
        env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      }
    );
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    // Clean up tables before each test
    await pool.query('DELETE FROM delay_tracker.delay_alerts');
    await pool.query('DELETE FROM delay_tracker.monitored_journeys');
  });

  describe('Test 1: New status value darwin_unavailable accepted', () => {
    it('should allow INSERT with monitoring_status = darwin_unavailable', async () => {
      const result = await pool.query(
        `
        INSERT INTO delay_tracker.monitored_journeys
          (journey_id, user_id, service_date, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival, monitoring_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'darwin_unavailable')
        RETURNING *
        `,
        [
          '550e8400-e29b-41d4-a716-446655440100',
          '123e4567-e89b-12d3-a456-426614174100',
          '2026-02-15',
          'PAD',
          'CDF',
          '2026-02-15T10:00:00Z',
          '2026-02-15T12:00:00Z',
        ]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].monitoring_status).toBe('darwin_unavailable');
    });

    it('should allow UPDATE to monitoring_status = darwin_unavailable', async () => {
      // Insert with pending_rid
      const inserted = await pool.query(
        `
        INSERT INTO delay_tracker.monitored_journeys
          (journey_id, user_id, service_date, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival, monitoring_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_rid')
        RETURNING id
        `,
        [
          '550e8400-e29b-41d4-a716-446655440101',
          '123e4567-e89b-12d3-a456-426614174101',
          '2026-02-15',
          'KGX',
          'EDN',
          '2026-02-15T08:00:00Z',
          '2026-02-15T12:30:00Z',
        ]
      );

      // Update to darwin_unavailable
      const updated = await pool.query(
        `
        UPDATE delay_tracker.monitored_journeys
        SET monitoring_status = 'darwin_unavailable'
        WHERE id = $1
        RETURNING *
        `,
        [inserted.rows[0].id]
      );

      expect(updated.rows[0].monitoring_status).toBe('darwin_unavailable');
    });
  });

  describe('Test 2: Invalid status rejected', () => {
    it('should reject INSERT with invalid monitoring_status', async () => {
      await expect(
        pool.query(
          `
          INSERT INTO delay_tracker.monitored_journeys
            (journey_id, user_id, service_date, origin_crs, destination_crs,
             scheduled_departure, scheduled_arrival, monitoring_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'invalid_status')
          `,
          [
            '550e8400-e29b-41d4-a716-446655440102',
            '123e4567-e89b-12d3-a456-426614174102',
            '2026-02-15',
            'MAN',
            'LDS',
            '2026-02-15T09:00:00Z',
            '2026-02-15T10:00:00Z',
          ]
        )
      ).rejects.toThrow(/violates check constraint|check constraint.*monitoring_status/i);
    });

    it('should reject UPDATE to invalid monitoring_status', async () => {
      // Insert valid row
      const inserted = await pool.query(
        `
        INSERT INTO delay_tracker.monitored_journeys
          (journey_id, user_id, service_date, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival, monitoring_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
        RETURNING id
        `,
        [
          '550e8400-e29b-41d4-a716-446655440103',
          '123e4567-e89b-12d3-a456-426614174103',
          '2026-02-15',
          'BRI',
          'BTM',
          '2026-02-15T11:00:00Z',
          '2026-02-15T12:15:00Z',
        ]
      );

      // Attempt UPDATE to invalid status
      await expect(
        pool.query(
          `
          UPDATE delay_tracker.monitored_journeys
          SET monitoring_status = 'not_a_valid_status'
          WHERE id = $1
          `,
          [inserted.rows[0].id]
        )
      ).rejects.toThrow(/violates check constraint|check constraint.*monitoring_status/i);
    });
  });

  describe('Test 3: Existing 5 statuses still valid', () => {
    const originalStatuses = ['pending_rid', 'active', 'delayed', 'completed', 'cancelled'];

    originalStatuses.forEach((status, index) => {
      it(`should allow INSERT with monitoring_status = ${status}`, async () => {
        const result = await pool.query(
          `
          INSERT INTO delay_tracker.monitored_journeys
            (journey_id, user_id, service_date, origin_crs, destination_crs,
             scheduled_departure, scheduled_arrival, monitoring_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
          `,
          [
            `550e8400-e29b-41d4-a716-44665544010${index}`,
            `123e4567-e89b-12d3-a456-42661417410${index}`,
            '2026-02-16',
            'PAD',
            'CDF',
            '2026-02-16T10:00:00Z',
            '2026-02-16T12:00:00Z',
            status,
          ]
        );

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].monitoring_status).toBe(status);
      });
    });

    it('should allow all 6 status values (5 original + darwin_unavailable)', async () => {
      const allStatuses = [...originalStatuses, 'darwin_unavailable'];

      for (let i = 0; i < allStatuses.length; i++) {
        const result = await pool.query(
          `
          INSERT INTO delay_tracker.monitored_journeys
            (journey_id, user_id, service_date, origin_crs, destination_crs,
             scheduled_departure, scheduled_arrival, monitoring_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING monitoring_status
          `,
          [
            `550e8400-e29b-41d4-a716-44665544020${i}`,
            `123e4567-e89b-12d3-a456-42661417420${i}`,
            '2026-02-17',
            'KGX',
            'EDN',
            '2026-02-17T08:00:00Z',
            '2026-02-17T12:30:00Z',
            allStatuses[i],
          ]
        );

        expect(result.rows[0].monitoring_status).toBe(allStatuses[i]);
      }

      // Verify count
      const count = await pool.query('SELECT COUNT(*) FROM delay_tracker.monitored_journeys');
      expect(parseInt(count.rows[0].count)).toBe(6);
    });
  });

  describe('Test 4: Rollback data cleanup', () => {
    it('should verify down migration resets darwin_unavailable to pending_rid', async () => {
      // Insert multiple journeys with darwin_unavailable status
      await pool.query(
        `
        INSERT INTO delay_tracker.monitored_journeys
          (journey_id, user_id, service_date, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival, monitoring_status)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'darwin_unavailable'),
          ($8, $9, $10, $11, $12, $13, $14, 'darwin_unavailable'),
          ($15, $16, $17, $18, $19, $20, $21, 'active')
        `,
        [
          '550e8400-e29b-41d4-a716-446655440200',
          '123e4567-e89b-12d3-a456-426614174200',
          '2026-02-18',
          'PAD',
          'CDF',
          '2026-02-18T10:00:00Z',
          '2026-02-18T12:00:00Z',
          '550e8400-e29b-41d4-a716-446655440201',
          '123e4567-e89b-12d3-a456-426614174201',
          '2026-02-18',
          'KGX',
          'EDN',
          '2026-02-18T08:00:00Z',
          '2026-02-18T12:30:00Z',
          '550e8400-e29b-41d4-a716-446655440202',
          '123e4567-e89b-12d3-a456-426614174202',
          '2026-02-18',
          'MAN',
          'LDS',
          '2026-02-18T09:00:00Z',
          '2026-02-18T10:00:00Z',
        ]
      );

      // Verify darwin_unavailable rows exist
      const beforeRollback = await pool.query(
        "SELECT COUNT(*) FROM delay_tracker.monitored_journeys WHERE monitoring_status = 'darwin_unavailable'"
      );
      expect(parseInt(beforeRollback.rows[0].count)).toBe(2);

      // Run down migration
      // Test Lock reconcile (dt-ci-green): the original `--count 1` had two
      // defects. (1) node-pg-migrate's down count is POSITIONAL (`down N`);
      // `--count` is silently ignored, so the flag only ever exercised the
      // default of 1. (2) A count of 1 assumed this migration (1770714617404)
      // was the newest — true when the test was written, but three migrations
      // have landed on top since, so only the latest was rolled back and the
      // darwin_unavailable rows were never reset (verified against a live
      // Postgres 15 container). Compute the count so the rollback always
      // reaches THIS migration's down() regardless of how many later
      // migrations exist. Semantic intent unchanged: the down() of
      // add-darwin-unavailable-status must reset darwin_unavailable -> pending_rid.
      const migrationDir = path.join(__dirname, '../../migrations');
      const fs = await import('fs');
      const DARWIN_MIGRATION_TS = 1770714617404;
      const downCount = fs
        .readdirSync(migrationDir)
        .filter((f) => /^\d+_.+\.c?js$/.test(f))
        .filter((f) => parseInt(f.split('_')[0], 10) >= DARWIN_MIGRATION_TS)
        .length;
      execSync(
        `npx node-pg-migrate down ${downCount} -m "${migrationDir}" --migrations-schema delay_tracker --migrations-table pgmigrations`,
        {
          cwd: path.join(__dirname, '../..'),
          env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
        }
      );

      // Verify darwin_unavailable rows were reset to pending_rid
      const afterRollback = await pool.query(
        "SELECT COUNT(*) FROM delay_tracker.monitored_journeys WHERE monitoring_status = 'darwin_unavailable'"
      );
      expect(parseInt(afterRollback.rows[0].count)).toBe(0);

      const pendingRidCount = await pool.query(
        "SELECT COUNT(*) FROM delay_tracker.monitored_journeys WHERE monitoring_status = 'pending_rid'"
      );
      expect(parseInt(pendingRidCount.rows[0].count)).toBeGreaterThanOrEqual(2);

      // Re-run up migration for subsequent tests
      execSync(
        `npx node-pg-migrate up -m "${migrationDir}" --migrations-schema delay_tracker --migrations-table pgmigrations --create-schema --create-migrations-schema`,
        {
          cwd: path.join(__dirname, '../..'),
          env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
        }
      );
    });
  });

  describe('Constraint Verification', () => {
    it('should verify monitoring_status CHECK constraint exists', async () => {
      const constraintCheck = await pool.query(
        `
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'delay_tracker.monitored_journeys'::regclass
          AND conname = 'monitored_journeys_monitoring_status_check'
        `
      );

      expect(constraintCheck.rows).toHaveLength(1);
      expect(constraintCheck.rows[0].conname).toBe('monitored_journeys_monitoring_status_check');
      expect(constraintCheck.rows[0].definition).toMatch(/darwin_unavailable/);
    });

    it('should verify all 6 status values are in CHECK constraint', async () => {
      const constraintCheck = await pool.query(
        `
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'delay_tracker.monitored_journeys'::regclass
          AND conname = 'monitored_journeys_monitoring_status_check'
        `
      );

      const definition = constraintCheck.rows[0].definition;

      // Verify all 6 status values present
      expect(definition).toMatch(/pending_rid/);
      expect(definition).toMatch(/active/);
      expect(definition).toMatch(/delayed/);
      expect(definition).toMatch(/completed/);
      expect(definition).toMatch(/cancelled/);
      expect(definition).toMatch(/darwin_unavailable/);
    });
  });
});
