/**
 * Unit Tests: GET /delays/:journeyId handler
 *
 * Phase: US-2 (Test Specification — Jessie)
 * Story: RAILREPAY-DT-001 — delay-tracker: synchronous delay-query endpoint
 * BL: BL-199 (parent epic)
 *
 * ACs covered: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-12, AC-13
 *
 * Mocking strategy:
 *   - JourneyRepository.findByJourneyId  — mocked
 *   - DelayAlertRepository.findLatestByMonitoredJourneyId — mocked (new method Blake adds)
 *   - console.log spied (AC-13; existing delay-tracker logging pattern per OQ-C handoff notes)
 *   - NOT mocking @railrepay/winston-logger — out of scope (TD-DELAY-TRACKER-006/007/008)
 *
 * IMPORTANT (Test Lock Rule): Blake MUST NOT modify these tests.
 * If a test appears wrong Blake returns it to Jessie with reasoning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// These imports will fail / resolve to undefined until Blake creates them (RED phase).
// That is the expected state at commit time.
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { DelayQueryHandler } from '../../../src/api/delay-query.handler.js';
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { JourneyRepository } from '../../../src/repositories/journey-repository.js';
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';

// ---------------------------------------------------------------------------
// Test UUID constants (non-placeholder per ADR-017 / Guideline #6)
// ---------------------------------------------------------------------------

// User A owns journey J1 (happy-path user)
const USER_A = 'aa000001-0000-4000-8000-000000000001';
const JOURNEY_J1 = 'bb000001-0000-4000-8000-000000000001';
const MONITORED_J1_ID = 'cc000001-0000-4000-8000-000000000001';

// User B does NOT own J1 (forbidden scenario)
const USER_B = 'aa000002-0000-4000-8000-000000000002';

// Journey J2 has NO delay_alerts but monitoring_status='completed' → 404 (BL-357: stale row forces ensure re-eval)
const JOURNEY_J2 = 'bb000002-0000-4000-8000-000000000002';
const MONITORED_J2_ID = 'cc000002-0000-4000-8000-000000000002';
const USER_J2 = 'aa000003-0000-4000-8000-000000000003';

// Journey J3 has NO delay_alerts and monitoring_status='active' → pending
const JOURNEY_J3 = 'bb000003-0000-4000-8000-000000000003';
const MONITORED_J3_ID = 'cc000003-0000-4000-8000-000000000003';
const USER_J3 = 'aa000004-0000-4000-8000-000000000004';

// Journey J4 has NO delay_alerts and monitoring_status='pending_rid' → pending
const JOURNEY_J4 = 'bb000004-0000-4000-8000-000000000004';
const MONITORED_J4_ID = 'cc000004-0000-4000-8000-000000000004';
const USER_J4 = 'aa000005-0000-4000-8000-000000000005';

// Journey J5 has NO delay_alerts and monitoring_status='darwin_unavailable' → pending
const JOURNEY_J5 = 'bb000005-0000-4000-8000-000000000005';
const MONITORED_J5_ID = 'cc000005-0000-4000-8000-000000000005';
const USER_J5 = 'aa000006-0000-4000-8000-000000000006';

// Journey J6 → cancelled (is_cancellation=true)
const JOURNEY_J6 = 'bb000006-0000-4000-8000-000000000006';
const MONITORED_J6_ID = 'cc000006-0000-4000-8000-000000000006';
const USER_J6 = 'aa000007-0000-4000-8000-000000000007';

// Idempotency test journey (AC-12)
const JOURNEY_J7 = 'bb000007-0000-4000-8000-000000000007';
const MONITORED_J7_ID = 'cc000007-0000-4000-8000-000000000007';
const USER_J7 = 'aa000008-0000-4000-8000-000000000008';

// Realistic timestamps
const ALERT_DETECTED_AT = new Date('2026-04-28T10:30:00.000Z');
const LAST_CHECKED_AT = new Date('2026-04-28T09:00:00.000Z');
const SCHEDULED_ARRIVAL = new Date('2026-04-28T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMonitoredJourney(
  journeyId: string,
  userId: string,
  monitoredId: string,
  status: string,
  lastCheckedAt: Date | null = LAST_CHECKED_AT,
) {
  return {
    id: monitoredId,
    user_id: userId,
    journey_id: journeyId,
    monitoring_status: status,
    last_checked_at: lastCheckedAt,
    scheduled_arrival: SCHEDULED_ARRIVAL,
  };
}

function buildDelayAlert(
  monitoredJourneyId: string,
  delayMinutes: number,
  isCancellation = false,
  detectedAt: Date = ALERT_DETECTED_AT,
) {
  return {
    id: 'dd000001-0000-4000-8000-000000000001',
    monitored_journey_id: monitoredJourneyId,
    delay_minutes: delayMinutes,
    is_cancellation: isCancellation,
    delay_detected_at: detectedAt,
  };
}

// ---------------------------------------------------------------------------
// App factory — Blake wires this in the handler; tests call it directly
// ---------------------------------------------------------------------------

function buildApp(
  journeyRepo: Partial<InstanceType<typeof JourneyRepository>>,
  alertRepo: Partial<InstanceType<typeof DelayAlertRepository>>,
): Express {
  const app = express();
  app.use(express.json());

  // Blake must register GET /delays/:journeyId using DelayQueryHandler
  const handler = new DelayQueryHandler({ journeyRepository: journeyRepo, delayAlertRepository: alertRepo });
  handler.register(app);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delay-query.handler (unit)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC-1: Happy path — delayed
  // -------------------------------------------------------------------------
  describe('AC-1: delayed journey returns 200 with delay data', () => {
    it('should return 200 with status delayed when delay_alerts row exists with is_cancellation=false', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          buildDelayAlert(MONITORED_J1_ID, 23, false),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${JOURNEY_J1}?user_id=${USER_A}`);

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBe(JOURNEY_J1);
      expect(res.body.delay_minutes).toBe(23);
      expect(res.body.cancelled).toBe(false);
      expect(res.body.status).toBe('delayed');
      // last_observed_at must be ISO 8601
      expect(new Date(res.body.last_observed_at).toISOString()).toBe(ALERT_DETECTED_AT.toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // AC-2: Happy path — cancelled
  // -------------------------------------------------------------------------
  describe('AC-2: cancelled journey returns status=cancelled regardless of delay_minutes', () => {
    it('should return status=cancelled and cancelled=true when is_cancellation=true', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J6, USER_J6, MONITORED_J6_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          // is_cancellation=true even with delay_minutes=5 → status must be 'cancelled'
          buildDelayAlert(MONITORED_J6_ID, 5, true),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${JOURNEY_J6}?user_id=${USER_J6}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.cancelled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC-3: completed + no alert → 404 (BL-357)
  // -------------------------------------------------------------------------
  // BL-357: A completed+no-alert row represents a stale single-leg evaluation.
  // Returning 200 on_time here caused the BFF to skip ensureDelay(), so multi-leg
  // journeys received a stale verdict. The handler must now 404 so the BFF's
  // dtResult.statusCode===404 branch fires and calls ensureDelay() for re-eval.
  describe('AC-3: completed+no-alert row returns 404 (BL-357 — stale row forces ensure re-eval)', () => {
    it('should return 404 (not 200 on_time) when monitoring_status=completed and no delay alert exists', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J2, USER_J2, MONITORED_J2_ID, 'completed', LAST_CHECKED_AT),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${JOURNEY_J2}?user_id=${USER_J2}`);

      // BL-357: must be 404 so BFF calls ensureDelay() for re-evaluation
      expect(res.status).toBe(404);
      // Must not serve stale on_time verdict
      expect(res.body.status).not.toBe('on_time');
    });

    it('should return 404 when monitoring_status=completed, no alert, and last_checked_at is null', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J2, USER_J2, MONITORED_J2_ID, 'completed', null /* last_checked_at = null */),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${JOURNEY_J2}?user_id=${USER_J2}`);

      // BL-357: null last_checked_at edge-case — still 404, not 200 on_time
      expect(res.status).toBe(404);
      expect(res.body.status).not.toBe('on_time');
    });
  });

  // -------------------------------------------------------------------------
  // AC-4: Pending — multiple monitoring_status values
  // -------------------------------------------------------------------------
  describe('AC-4: pending when monitoring_status in (pending_rid, active, darwin_unavailable) and no alerts', () => {
    const pendingStatuses = [
      { status: 'pending_rid', journeyId: JOURNEY_J4, userId: USER_J4, monitoredId: MONITORED_J4_ID },
      { status: 'active', journeyId: JOURNEY_J3, userId: USER_J3, monitoredId: MONITORED_J3_ID },
      { status: 'darwin_unavailable', journeyId: JOURNEY_J5, userId: USER_J5, monitoredId: MONITORED_J5_ID },
    ];

    for (const { status, journeyId, userId, monitoredId } of pendingStatuses) {
      it(`should return status=pending for monitoring_status=${status}`, async () => {
        const mockJourneyRepo = {
          findByJourneyId: vi.fn().mockResolvedValue(
            buildMonitoredJourney(journeyId, userId, monitoredId, status),
          ),
        };
        const mockAlertRepo = {
          findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
        };

        const app = buildApp(mockJourneyRepo, mockAlertRepo);
        const res = await request(app).get(`/delays/${journeyId}?user_id=${userId}`);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(res.body.message).toBe('no delay data yet');
      });
    }
  });

  // -------------------------------------------------------------------------
  // AC-5: Latest-row selection
  // This is a unit test — we verify the handler calls findLatestByMonitoredJourneyId
  // (not findByJourneyId on alerts) which Blake must implement with
  // ORDER BY delay_detected_at DESC LIMIT 1.
  // -------------------------------------------------------------------------
  describe('AC-5: handler delegates latest-row selection to repository', () => {
    it('should call findLatestByMonitoredJourneyId (not a sort/filter in the handler)', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const latestAlert = buildDelayAlert(MONITORED_J1_ID, 45, false, new Date('2026-04-28T14:00:00Z'));
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(latestAlert),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${JOURNEY_J1}?user_id=${USER_A}`);

      // Verify the repository method was called with the monitored_journey PK, not journey_id
      expect(mockAlertRepo.findLatestByMonitoredJourneyId).toHaveBeenCalledWith(MONITORED_J1_ID);
      expect(mockAlertRepo.findLatestByMonitoredJourneyId).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // AC-6: Unknown journey → 404
  // -------------------------------------------------------------------------
  describe('AC-6: unknown journey returns 404', () => {
    it('should return 404 with error=unknown_journey when no monitored_journeys row exists', async () => {
      const unknownJourneyId = 'ee000001-0000-4000-8000-000000000001';
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(null),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn(),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${unknownJourneyId}?user_id=${USER_A}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('unknown_journey');
      // DB alert method must NOT be called (journey not found)
      expect(mockAlertRepo.findLatestByMonitoredJourneyId).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // AC-7: Forbidden — journey exists but user_id does not match
  // -------------------------------------------------------------------------
  describe('AC-7: forbidden when user_id does not match the journeys owner', () => {
    it('should return 403 with ONLY error key when user_id does not match', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn(),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      // USER_B requests JOURNEY_J1 which belongs to USER_A
      const res = await request(app).get(`/delays/${JOURNEY_J1}?user_id=${USER_B}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');

      // AC-7 CRITICAL: response body MUST NOT leak journey existence
      // Only the 'error' key must be present
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body.journey_id).toBeUndefined();
      expect(res.body.user_id).toBeUndefined();
      expect(res.body.status).toBeUndefined();
    });

    it('should NOT call findLatestByMonitoredJourneyId when forbidden (avoids unnecessary DB read)', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn(),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${JOURNEY_J1}?user_id=${USER_B}`);

      expect(mockAlertRepo.findLatestByMonitoredJourneyId).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // AC-8: Bad request — malformed journeyId (not a valid UUID)
  // -------------------------------------------------------------------------
  describe('AC-8: bad_request when journeyId is not a valid UUID', () => {
    const malformedJourneyIds = [
      'not-a-uuid',
      '12345',
      'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      '',
    ];

    for (const badId of malformedJourneyIds.filter(id => id !== '')) {
      it(`should return 400 for journeyId="${badId}" without hitting DB`, async () => {
        const mockJourneyRepo = {
          findByJourneyId: vi.fn(),
        };
        const mockAlertRepo = {
          findLatestByMonitoredJourneyId: vi.fn(),
        };

        const app = buildApp(mockJourneyRepo, mockAlertRepo);
        const res = await request(app).get(`/delays/${badId}?user_id=${USER_A}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('bad_request');
        // Validation BEFORE DB call (AC-8 requirement)
        expect(mockJourneyRepo.findByJourneyId).not.toHaveBeenCalled();
      });
    }
  });

  // -------------------------------------------------------------------------
  // AC-9: Bad request — missing or malformed user_id query param
  // -------------------------------------------------------------------------
  describe('AC-9: bad_request when user_id is absent or not a valid UUID', () => {
    it('should return 400 when user_id query param is absent', async () => {
      const mockJourneyRepo = { findByJourneyId: vi.fn() };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn() };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${JOURNEY_J1}`); // no ?user_id

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
      // Validation BEFORE DB call (AC-9 requirement)
      expect(mockJourneyRepo.findByJourneyId).not.toHaveBeenCalled();
    });

    it('should return 400 when user_id is not a valid UUID', async () => {
      const mockJourneyRepo = { findByJourneyId: vi.fn() };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn() };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res = await request(app).get(`/delays/${JOURNEY_J1}?user_id=not-a-uuid`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
      expect(mockJourneyRepo.findByJourneyId).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // AC-12: Idempotency — two consecutive identical GETs return identical responses
  // -------------------------------------------------------------------------
  describe('AC-12: idempotency — two identical GETs return identical response bodies and status', () => {
    it('should return identical status and body for two consecutive identical GETs', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J7, USER_J7, MONITORED_J7_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          buildDelayAlert(MONITORED_J7_ID, 18, false),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      const res1 = await request(app).get(`/delays/${JOURNEY_J7}?user_id=${USER_J7}`);
      const res2 = await request(app).get(`/delays/${JOURNEY_J7}?user_id=${USER_J7}`);

      expect(res1.status).toBe(res2.status);
      // Bodies must be deeply equal (no timestamps that change per-call)
      expect(res1.body).toEqual(res2.body);
    });
  });

  // -------------------------------------------------------------------------
  // AC-13: Logging — structured log per request via console.log
  // -------------------------------------------------------------------------
  describe('AC-13: structured logging via console.log with required fields', () => {
    it('should emit one console.log per request with correlation_id, journey_id, user_id, outcome, duration_ms, component, route', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          buildDelayAlert(MONITORED_J1_ID, 23, false),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app)
        .get(`/delays/${JOURNEY_J1}?user_id=${USER_A}`)
        .set('X-Correlation-ID', 'test-correlation-001');

      // Find the structured-log call (second arg is the JSON-serializable object)
      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      expect(structuredCalls.length).toBeGreaterThanOrEqual(1);

      const logMeta = structuredCalls[0][1] as Record<string, unknown>;
      expect(logMeta.correlation_id).toBe('test-correlation-001');
      expect(logMeta.journey_id).toBe(JOURNEY_J1);
      expect(logMeta.user_id).toBe(USER_A);
      expect(logMeta.outcome).toBe('hit');
      expect(typeof logMeta.duration_ms).toBe('number');
      expect(logMeta.component).toBe('delay-tracker');
      expect(logMeta.route).toBe('/delays/:journeyId');
    });

    it('should log outcome=unknown when journey is not found (AC-6 path)', async () => {
      const unknownId = 'ee000002-0000-4000-8000-000000000002';
      const mockJourneyRepo = { findByJourneyId: vi.fn().mockResolvedValue(null) };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn() };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${unknownId}?user_id=${USER_A}`);

      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      const logMeta = structuredCalls[0]?.[1] as Record<string, unknown>;
      expect(logMeta?.outcome).toBe('unknown');
    });

    it('should log outcome=forbidden when user_id does not match', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn() };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${JOURNEY_J1}?user_id=${USER_B}`);

      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      const logMeta = structuredCalls[0]?.[1] as Record<string, unknown>;
      expect(logMeta?.outcome).toBe('forbidden');
    });

    it('should log outcome=bad_request when validation fails', async () => {
      const mockJourneyRepo = { findByJourneyId: vi.fn() };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn() };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get('/delays/not-a-uuid?user_id=' + USER_A);

      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      const logMeta = structuredCalls[0]?.[1] as Record<string, unknown>;
      expect(logMeta?.outcome).toBe('bad_request');
    });

    it('should log outcome=pending for a pending journey', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J3, USER_J3, MONITORED_J3_ID, 'active'),
        ),
      };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null) };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${JOURNEY_J3}?user_id=${USER_J3}`);

      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      const logMeta = structuredCalls[0]?.[1] as Record<string, unknown>;
      expect(logMeta?.outcome).toBe('pending');
    });

    it('should log outcome=unknown for a completed journey with no alerts (BL-357: 404 branch)', async () => {
      // BL-357: completed+no-alert now returns 404 (same branch as not-found).
      // The log outcome for the 404 path is 'unknown', matching AC-6 (journey not found).
      // The old assertion (outcome='on_time') is stale — the on_time branch no longer fires
      // for completed+no-alert rows; they fall through to the 404 not-found branch.
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J2, USER_J2, MONITORED_J2_ID, 'completed'),
        ),
      };
      const mockAlertRepo = { findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null) };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${JOURNEY_J2}?user_id=${USER_J2}`);

      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      const logMeta = structuredCalls[0]?.[1] as Record<string, unknown>;
      expect(logMeta?.outcome).toBe('unknown');
    });

    it('should use a generated correlation_id when X-Correlation-ID header is absent', async () => {
      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(
          buildMonitoredJourney(JOURNEY_J1, USER_A, MONITORED_J1_ID, 'active'),
        ),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
          buildDelayAlert(MONITORED_J1_ID, 23, false),
        ),
      };

      const app = buildApp(mockJourneyRepo, mockAlertRepo);
      await request(app).get(`/delays/${JOURNEY_J1}?user_id=${USER_A}`); // no X-Correlation-ID

      const structuredCalls = consoleLogSpy.mock.calls.filter(
        (args) => args.length >= 2 && typeof args[1] === 'object' && args[1] !== null,
      );
      const logMeta = structuredCalls[0]?.[1] as Record<string, unknown>;
      expect(typeof logMeta?.correlation_id).toBe('string');
      expect((logMeta?.correlation_id as string).length).toBeGreaterThan(0);
    });
  });
});
