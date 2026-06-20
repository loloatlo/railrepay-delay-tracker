/**
 * Integration Tests: GET /delays/:journeyId endpoint (real Testcontainers PG)
 *
 * Phase: US-2 (Test Specification — Jessie)
 * Story: RAILREPAY-DT-001 — delay-tracker: synchronous delay-query endpoint
 * BL: BL-199 (parent epic)
 *
 * ACs covered: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-10, AC-11
 *
 * Tech: Vitest + @testcontainers/postgresql (real DB, no mocks on the data layer).
 * Pattern mirrors: tests/integration/database-operations.test.ts
 *
 * IMPORTANT (Test Lock Rule): Blake MUST NOT modify these tests.
 * If a test appears wrong Blake returns it to Jessie with reasoning.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';

// These imports will fail until Blake creates these modules (TDD RED state).
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createDelayQueryApp } from '../../helpers/create-delay-query-app.js';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedJourneyOpts {
  journeyId: string;
  userId: string;
  monitoringStatus: string;
  lastCheckedAt?: Date | null;
  scheduledArrival?: Date;
}

interface SeedAlertOpts {
  monitoredJourneyId: string;   // PK of monitored_journeys row
  delayMinutes: number;
  isCancellation?: boolean;
  delayDetectedAt?: Date;
}

async function seedJourney(pool: Pool, opts: SeedJourneyOpts): Promise<string> {
  const scheduledArrival = opts.scheduledArrival ?? new Date('2026-04-28T12:00:00Z');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO delay_tracker.monitored_journeys
       (user_id, journey_id, service_date, origin_crs, destination_crs,
        scheduled_departure, scheduled_arrival, monitoring_status, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      opts.userId,
      opts.journeyId,
      '2026-04-28',
      'KGX',
      'EDB',
      new Date('2026-04-28T08:00:00Z'),
      scheduledArrival,
      opts.monitoringStatus,
      opts.lastCheckedAt !== undefined ? opts.lastCheckedAt : new Date('2026-04-28T09:00:00Z'),
    ],
  );
  return result.rows[0].id;
}

async function seedAlert(pool: Pool, opts: SeedAlertOpts): Promise<void> {
  const detectedAt = opts.delayDetectedAt ?? new Date();
  await pool.query(
    `INSERT INTO delay_tracker.delay_alerts
       (monitored_journey_id, delay_minutes, is_cancellation, delay_detected_at)
     VALUES ($1, $2, $3, $4)`,
    [opts.monitoredJourneyId, opts.delayMinutes, opts.isCancellation ?? false, detectedAt],
  );
}

// ---------------------------------------------------------------------------
// UUID constants — unique per scenario (Guideline #6: differentiating data)
// ---------------------------------------------------------------------------

// AC-1: delayed
const INT_USER_DELAYED = 'f1000001-0000-4000-8000-000000000001';
const INT_JOURNEY_DELAYED = 'f2000001-0000-4000-8000-000000000001';

// AC-2: cancelled
const INT_USER_CANCELLED = 'f1000002-0000-4000-8000-000000000002';
const INT_JOURNEY_CANCELLED = 'f2000002-0000-4000-8000-000000000002';

// AC-3: on_time (monitoring_status='completed', no alerts)
const INT_USER_ON_TIME = 'f1000003-0000-4000-8000-000000000003';
const INT_JOURNEY_ON_TIME = 'f2000003-0000-4000-8000-000000000003';

// AC-4: pending (monitoring_status='active', no alerts)
const INT_USER_PENDING_ACTIVE = 'f1000004-0000-4000-8000-000000000004';
const INT_JOURNEY_PENDING_ACTIVE = 'f2000004-0000-4000-8000-000000000004';

// AC-4: pending (monitoring_status='pending_rid')
const INT_USER_PENDING_RID = 'f1000005-0000-4000-8000-000000000005';
const INT_JOURNEY_PENDING_RID = 'f2000005-0000-4000-8000-000000000005';

// AC-4: pending (monitoring_status='darwin_unavailable')
const INT_USER_DARWIN_UNAVAIL = 'f1000006-0000-4000-8000-000000000006';
const INT_JOURNEY_DARWIN_UNAVAIL = 'f2000006-0000-4000-8000-000000000006';

// AC-5: multiple alerts — should pick the most recent
const INT_USER_LATEST = 'f1000007-0000-4000-8000-000000000007';
const INT_JOURNEY_LATEST = 'f2000007-0000-4000-8000-000000000007';

// AC-6: unknown journey
const INT_JOURNEY_UNKNOWN = 'f2000008-0000-4000-8000-000000000008';

// AC-7: forbidden (wrong user_id)
const INT_USER_OWNER = 'f1000009-0000-4000-8000-000000000009';
const INT_USER_STRANGER = 'f100000a-0000-4000-8000-00000000000a';
const INT_JOURNEY_FORBIDDEN = 'f200000a-0000-4000-8000-00000000000a';

// AC-10: no-side-effects journey (100 sequential GETs)
const INT_USER_NOSIDE = 'f100000b-0000-4000-8000-00000000000b';
const INT_JOURNEY_NOSIDE = 'f200000b-0000-4000-8000-00000000000b';

// AC-11: performance (p95 ≤ 100ms)
const INT_USER_PERF = 'f100000c-0000-4000-8000-00000000000c';
const INT_JOURNEY_PERF = 'f200000c-0000-4000-8000-00000000000c';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /delays/:journeyId — integration (Testcontainers PG)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Express;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('test_dt')
      .start();

    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Run all migrations so the full schema including darwin_unavailable status is present
    const migrationDir = path.resolve(__dirname, '../../../migrations');
    execSync(`npx node-pg-migrate up -m "${migrationDir}" --migrations-schema delay_tracker --migrations-table pgmigrations --create-schema`, {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    });

    // createDelayQueryApp is a helper Blake must provide that returns an Express app
    // with GET /delays/:journeyId wired up, using the supplied pool.
    // Signature: createDelayQueryApp(pool: Pool): Express
    app = createDelayQueryApp(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    // Clean between tests — alerts first (FK child), then journeys (FK parent)
    await pool.query('DELETE FROM delay_tracker.delay_alerts');
    await pool.query('DELETE FROM delay_tracker.monitored_journeys');
    await pool.query('DELETE FROM delay_tracker.outbox');
  });

  // -------------------------------------------------------------------------
  // AC-1: delayed (real DB)
  // -------------------------------------------------------------------------
  describe('AC-1: delayed journey', () => {
    it('should return 200 with delay data when delay_alerts row exists', async () => {
      const monitoredId = await seedJourney(pool, {
        journeyId: INT_JOURNEY_DELAYED,
        userId: INT_USER_DELAYED,
        monitoringStatus: 'active',
        lastCheckedAt: new Date('2026-04-28T10:00:00Z'),
      });

      const detectedAt = new Date('2026-04-28T10:30:00.000Z');
      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 23,
        isCancellation: false,
        delayDetectedAt: detectedAt,
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_DELAYED}?user_id=${INT_USER_DELAYED}`);

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBe(INT_JOURNEY_DELAYED);
      expect(res.body.delay_minutes).toBe(23);
      expect(res.body.cancelled).toBe(false);
      expect(res.body.status).toBe('delayed');
      // last_observed_at must be valid ISO 8601 equal to delay_detected_at
      expect(new Date(res.body.last_observed_at).toISOString()).toBe(detectedAt.toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // AC-2: cancelled (real DB)
  // -------------------------------------------------------------------------
  describe('AC-2: cancelled journey', () => {
    it('should return status=cancelled when is_cancellation=true', async () => {
      const monitoredId = await seedJourney(pool, {
        journeyId: INT_JOURNEY_CANCELLED,
        userId: INT_USER_CANCELLED,
        monitoringStatus: 'active',
      });

      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 5,
        isCancellation: true,
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_CANCELLED}?user_id=${INT_USER_CANCELLED}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.cancelled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC-3: completed+no-alert → 404 (real DB) — BL-357
  // -------------------------------------------------------------------------
  // BL-357: A completed+no-alert row is a stale single-leg evaluation.
  // Returning 200 on_time prevented the BFF's ensure branch from firing on
  // multi-leg journeys. The handler must now return 404 so the BFF calls
  // ensureDelay() for a full re-evaluation from journey_segments.
  describe('AC-3: completed+no-alert row returns 404 (BL-357 — stale row forces ensure re-eval)', () => {
    it('should return 404 (not 200 on_time) when monitoring_status=completed and no delay_alerts row exists', async () => {
      const lastCheckedAt = new Date('2026-04-28T11:00:00Z');
      await seedJourney(pool, {
        journeyId: INT_JOURNEY_ON_TIME,
        userId: INT_USER_ON_TIME,
        monitoringStatus: 'completed',
        lastCheckedAt,
      });
      // No seedAlert call — row has no delay_alerts (the stale case)

      const res = await request(app).get(`/delays/${INT_JOURNEY_ON_TIME}?user_id=${INT_USER_ON_TIME}`);

      // BL-357: must be 404 so BFF calls ensureDelay() for re-evaluation
      expect(res.status).toBe(404);
      // Must not serve stale on_time verdict
      expect(res.body.status).not.toBe('on_time');
    });
  });

  // -------------------------------------------------------------------------
  // AC-4: pending — three distinct monitoring statuses (real DB)
  // -------------------------------------------------------------------------
  describe('AC-4: pending when no alerts for non-completed statuses', () => {
    it('should return status=pending for monitoring_status=active with no alerts', async () => {
      await seedJourney(pool, {
        journeyId: INT_JOURNEY_PENDING_ACTIVE,
        userId: INT_USER_PENDING_ACTIVE,
        monitoringStatus: 'active',
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_PENDING_ACTIVE}?user_id=${INT_USER_PENDING_ACTIVE}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.message).toBe('no delay data yet');
    });

    it('should return status=pending for monitoring_status=pending_rid', async () => {
      await seedJourney(pool, {
        journeyId: INT_JOURNEY_PENDING_RID,
        userId: INT_USER_PENDING_RID,
        monitoringStatus: 'pending_rid',
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_PENDING_RID}?user_id=${INT_USER_PENDING_RID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.message).toBe('no delay data yet');
    });

    it('should return status=pending for monitoring_status=darwin_unavailable', async () => {
      await seedJourney(pool, {
        journeyId: INT_JOURNEY_DARWIN_UNAVAIL,
        userId: INT_USER_DARWIN_UNAVAIL,
        monitoringStatus: 'darwin_unavailable',
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_DARWIN_UNAVAIL}?user_id=${INT_USER_DARWIN_UNAVAIL}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.message).toBe('no delay data yet');
    });
  });

  // -------------------------------------------------------------------------
  // AC-5: Latest-row selection — multiple alerts, pick most recent (real DB)
  // -------------------------------------------------------------------------
  describe('AC-5: returns data from the most recent delay_detected_at row', () => {
    it('should return the alert with the highest delay_detected_at when multiple rows exist', async () => {
      const monitoredId = await seedJourney(pool, {
        journeyId: INT_JOURNEY_LATEST,
        userId: INT_USER_LATEST,
        monitoringStatus: 'active',
      });

      // Older alert: 10 minutes
      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 10,
        isCancellation: false,
        delayDetectedAt: new Date('2026-04-28T09:00:00Z'),
      });

      // Newer alert: 35 minutes (THIS should be returned)
      const latestDetected = new Date('2026-04-28T10:45:00Z');
      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 35,
        isCancellation: false,
        delayDetectedAt: latestDetected,
      });

      // Oldest alert: 5 minutes (should NOT be returned)
      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 5,
        isCancellation: false,
        delayDetectedAt: new Date('2026-04-28T08:00:00Z'),
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_LATEST}?user_id=${INT_USER_LATEST}`);

      expect(res.status).toBe(200);
      expect(res.body.delay_minutes).toBe(35);
      expect(new Date(res.body.last_observed_at).toISOString()).toBe(latestDetected.toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // AC-6: Unknown journey → 404 (real DB)
  // -------------------------------------------------------------------------
  describe('AC-6: unknown journey returns 404', () => {
    it('should return 404 when journey_id does not exist in monitored_journeys', async () => {
      const res = await request(app).get(`/delays/${INT_JOURNEY_UNKNOWN}?user_id=${INT_USER_DELAYED}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('unknown_journey');
    });
  });

  // -------------------------------------------------------------------------
  // AC-7: Forbidden — wrong user_id (real DB)
  // -------------------------------------------------------------------------
  describe('AC-7: forbidden when user_id does not match owner', () => {
    it('should return 403 with ONLY error key (no journey_id leak)', async () => {
      await seedJourney(pool, {
        journeyId: INT_JOURNEY_FORBIDDEN,
        userId: INT_USER_OWNER,
        monitoringStatus: 'active',
      });

      const res = await request(app).get(`/delays/${INT_JOURNEY_FORBIDDEN}?user_id=${INT_USER_STRANGER}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
      // Must not leak journey existence via any additional field
      expect(Object.keys(res.body)).toEqual(['error']);
    });
  });

  // -------------------------------------------------------------------------
  // AC-10: No side effects — 100 sequential GETs do not write any rows
  // -------------------------------------------------------------------------
  describe('AC-10: read-only — 100 sequential GETs produce no row writes', () => {
    it('should not change row counts in delay_alerts, monitored_journeys, or outbox after 100 GETs', async () => {
      const monitoredId = await seedJourney(pool, {
        journeyId: INT_JOURNEY_NOSIDE,
        userId: INT_USER_NOSIDE,
        monitoringStatus: 'active',
      });
      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 20,
        isCancellation: false,
      });

      // Capture row counts BEFORE
      const before = await pool.query<{ alerts: string; journeys: string; outbox: string }>(`
        SELECT
          (SELECT COUNT(*) FROM delay_tracker.delay_alerts)::text AS alerts,
          (SELECT COUNT(*) FROM delay_tracker.monitored_journeys)::text AS journeys,
          (SELECT COUNT(*) FROM delay_tracker.outbox)::text AS outbox
      `);

      // 100 sequential GETs
      for (let i = 0; i < 100; i++) {
        await request(app).get(`/delays/${INT_JOURNEY_NOSIDE}?user_id=${INT_USER_NOSIDE}`);
      }

      // Capture row counts AFTER
      const after = await pool.query<{ alerts: string; journeys: string; outbox: string }>(`
        SELECT
          (SELECT COUNT(*) FROM delay_tracker.delay_alerts)::text AS alerts,
          (SELECT COUNT(*) FROM delay_tracker.monitored_journeys)::text AS journeys,
          (SELECT COUNT(*) FROM delay_tracker.outbox)::text AS outbox
      `);

      expect(after.rows[0].alerts).toBe(before.rows[0].alerts);
      expect(after.rows[0].journeys).toBe(before.rows[0].journeys);
      expect(after.rows[0].outbox).toBe(before.rows[0].outbox);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // AC-11: Performance — p95 of 200 sequential GETs ≤ 100ms (server-side)
  // -------------------------------------------------------------------------
  describe('AC-11: performance p95 ≤ 100ms under warm connection pool', () => {
    it('should complete 200 sequential GETs with p95 server-side latency ≤ 100ms', async () => {
      const monitoredId = await seedJourney(pool, {
        journeyId: INT_JOURNEY_PERF,
        userId: INT_USER_PERF,
        monitoringStatus: 'active',
        lastCheckedAt: new Date('2026-04-28T09:00:00Z'),
      });
      await seedAlert(pool, {
        monitoredJourneyId: monitoredId,
        delayMinutes: 18,
        isCancellation: false,
      });

      const TOTAL = 200;
      const durations: number[] = [];

      // Warm-up: 5 requests excluded from measurement
      for (let i = 0; i < 5; i++) {
        await request(app).get(`/delays/${INT_JOURNEY_PERF}?user_id=${INT_USER_PERF}`);
      }

      // Measured requests
      for (let i = 0; i < TOTAL; i++) {
        const start = Date.now();
        const res = await request(app).get(`/delays/${INT_JOURNEY_PERF}?user_id=${INT_USER_PERF}`);
        const elapsed = Date.now() - start;
        durations.push(elapsed);
        expect(res.status).toBe(200);
      }

      durations.sort((a, b) => a - b);
      const p95Index = Math.floor(TOTAL * 0.95);
      const p95 = durations[p95Index];

      // AC-11: p95 ≤ 100ms
      // Note: this includes the HTTP round-trip to supertest's local server + Testcontainers PG.
      // The AC specifies "server-side" exclusion of container startup — that is already
      // satisfied by warm-up + the beforeAll guarantee that the container is started before this runs.
      expect(p95).toBeLessThanOrEqual(100);
    }, 60_000);
  });
});
