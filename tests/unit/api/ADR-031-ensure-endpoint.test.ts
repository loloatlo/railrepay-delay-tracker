/**
 * Unit Tests: POST /delays/ensure — ADR-031 synchronous ensure endpoint
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-315
 * ADR     : ADR-031 — Option (f) synchronous ensure-on-404
 * Date    : 2026-06-11
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * AC coverage map (delay-tracker service — ADR-031 Part 1):
 *   AC-1 : POST /delays/ensure endpoint exists and accepts body with journey_id + context
 *   AC-2 : Idempotent — 2nd call with same journey_id does not duplicate or error
 *   AC-3 : Shared evaluation logic (DelayEvaluationService) runs the same steps as
 *           handleHistoricJourney: Darwin availability check → SLW/legacy eval →
 *           persist delay_alerts or record not-detected
 *   AC-4 : Returns a TERMINAL response: delayed | on_time | no_data (NEVER pending)
 *   AC-5 : Existing GET /delays/:journeyId contract is UNCHANGED (regression guard)
 *          Async Kafka path (not-detected creates monitored_journey row with
 *          monitoring_status='completed') is UNCHANGED (BL-315 0eb1f68 guard)
 *   AC-10: Consumer config has sessionTimeout / heartbeatInterval tuned to push
 *          long Darwin/SLW work off the poll loop (tested separately in consumer-config tests)
 *
 * Mocking strategy:
 *   - DarwinIngestorClient  — mocked (interface boundary)
 *   - JourneyRepository     — mocked (interface boundary)
 *   - DelayAlertRepository  — mocked (interface boundary)
 *   - OutboxRepository      — mocked (interface boundary)
 *   - DelayEvaluationService — asserted it is called by the endpoint (AC-3)
 *   - Express app wired with real DelayEnsureHandler registered on the route
 *
 * RED failure modes expected:
 *   - POST /delays/ensure → 404 (route does not exist yet)
 *   - DelayEvaluationService does not exist yet (import error)
 *   - DelayEnsureHandler does not exist yet (import error)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-031 — Synchronous ensure-on-404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── UUID constants (valid UUID v4 format required by GET handler uuidValidate) ──

const JOURNEY_A = 'a0310000-0001-4000-8000-000000000001';
const USER_A    = 'a0310000-0001-4000-8001-000000000001';
const MON_ID_A  = 'a0310000-0001-4000-8002-000000000001';

// Journey B — for second-call idempotency test (AC-2)
const JOURNEY_B = 'a0310000-0002-4000-8000-000000000002';
const USER_B    = 'a0310000-0002-4000-8001-000000000002';
const MON_ID_B  = 'a0310000-0002-4000-8002-000000000002';

// Journey C — for no_data / Darwin unavailable (AC-4)
const JOURNEY_C = 'a0310000-0003-4000-8000-000000000003';
const USER_C    = 'a0310000-0003-4000-8001-000000000003';

// Journey D — for on_time terminal response (AC-4)
const JOURNEY_D = 'a0310000-0004-4000-8000-000000000004';
const USER_D    = 'a0310000-0004-4000-8001-000000000004';
const MON_ID_D  = 'a0310000-0004-4000-8002-000000000004';

// ─── Realistic payload shape for POST /delays/ensure ─────────────────────────

function makeEnsureBody(journeyId: string, userId: string, extra?: Record<string, unknown>) {
  return {
    journey_id: journeyId,
    user_id: userId,
    origin_crs: 'YRK',
    destination_crs: 'KGX',
    departure_datetime: '2026-06-03T08:30:00.000Z',
    arrival_datetime: '2026-06-03T10:30:00.000Z',
    toc_code: 'GR',
    segments: [
      {
        segment_order: 0,
        origin_crs: 'YRK',
        destination_crs: 'KGX',
        scheduled_departure: '2026-06-03T08:30:00.000Z',
        scheduled_arrival: '2026-06-03T10:30:00.000Z',
        rid: '202606037108175',
        toc_code: 'GR',
      },
    ],
    correlation_id: 'test-corr-adr031-0001',
    ...extra,
  };
}

// ─── Module-level mocks ───────────────────────────────────────────────────────

// These modules may not exist yet — import errors are expected RED failures.
// We mock them at module level so that supertest can still run the route scaffold.

vi.mock('../../../src/services/delay-evaluation.service.js', () => ({
  DelayEvaluationService: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn(),
  })),
}));

vi.mock('../../../src/api/delay-ensure.handler.js', async () => {
  const actual = await vi.importActual('../../../src/api/delay-ensure.handler.js');
  return actual;
});

vi.mock('../../../src/repositories/journey-repository.js', () => ({
  JourneyRepository: vi.fn().mockImplementation(() => ({
    findByJourneyId: vi.fn(),
    create: vi.fn(),
  })),
}));

vi.mock('../../../src/repositories/delay-alert-repository.js', () => ({
  DelayAlertRepository: vi.fn().mockImplementation(() => ({
    findLatestByMonitoredJourneyId: vi.fn(),
    create: vi.fn(),
  })),
}));

vi.mock('../../../src/repositories/outbox-repository.js', () => ({
  OutboxRepository: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
  })),
}));

vi.mock('../../../src/clients/darwin-ingestor.js', () => ({
  DarwinIngestorClient: vi.fn().mockImplementation(() => ({
    getDelayInfo: vi.fn(),
    getServiceWithStops: vi.fn(),
  })),
}));

// ─── Import mocked modules ────────────────────────────────────────────────────

const { DelayEvaluationService } = await import('../../../src/services/delay-evaluation.service.js');
const { DelayEnsureHandler } = await import('../../../src/api/delay-ensure.handler.js');
// @ts-expect-error — module does not exist yet (TDD RED phase)
const { JourneyRepository } = await import('../../../src/repositories/journey-repository.js');
// @ts-expect-error — module does not exist yet (TDD RED phase)
const { DelayAlertRepository } = await import('../../../src/repositories/delay-alert-repository.js');
// @ts-expect-error — module does not exist yet (TDD RED phase)
const { OutboxRepository } = await import('../../../src/repositories/outbox-repository.js');
// @ts-expect-error — module does not exist yet (TDD RED phase)
const { DarwinIngestorClient } = await import('../../../src/clients/darwin-ingestor.js');

// ─── Helper: build a real Express app with DelayEnsureHandler registered ──────

function buildApp() {
  const app = express();
  app.use(express.json());

  const journeyRepo = new JourneyRepository({ pool: {} as any });
  const alertRepo = new DelayAlertRepository({ pool: {} as any });
  const outboxRepo = new OutboxRepository({ pool: {} as any });
  const darwinClient = new DarwinIngestorClient({ baseUrl: 'http://darwin-test.internal' });
  const evalService = new DelayEvaluationService({
    journeyRepository: journeyRepo,
    delayAlertRepository: alertRepo,
    outboxRepository: outboxRepo,
    darwinClient,
  });

  const handler = new DelayEnsureHandler({
    journeyRepository: journeyRepo,
    delayEvaluationService: evalService,
  });
  handler.register(app);

  return { app, journeyRepo, alertRepo, outboxRepo, darwinClient, evalService, handler };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-031 Part 1: POST /delays/ensure — synchronous ensure endpoint', () => {

  // ── AC-1: Endpoint exists and accepts body ──────────────────────────────────

  describe('AC-1: POST /delays/ensure endpoint exists', () => {
    it('should respond to POST /delays/ensure (not 404 from missing route)', async () => {
      // AC-1: The endpoint MUST exist. Currently returns 404 because route is absent.
      // Blake registers the route in DelayEnsureHandler.register(app).
      // After implementation this test passes when status != 404.
      const { app, evalService } = buildApp();

      // Wire evaluate to return a delayed terminal result
      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'delayed',
        delay_minutes: 17,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:47:00.000Z',
      });

      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_A, USER_A))
        .expect('Content-Type', /json/);

      // RED state: 404 because route is not registered.
      // GREEN state after Blake: any non-404 status (200 or 202).
      expect(res.status).not.toBe(404);
    });

    it('should require journey_id in body — return 400 when absent', async () => {
      // AC-1: journey_id is required; missing body field → 400 bad_request
      const { app } = buildApp();

      const res = await request(app)
        .post('/delays/ensure')
        .send({ user_id: USER_A }) // no journey_id
        .expect('Content-Type', /json/);

      expect(res.status).toBe(400);
    });

    it('should require user_id in body — return 400 when absent', async () => {
      // AC-1: user_id is required; missing body field → 400 bad_request
      const { app } = buildApp();

      const res = await request(app)
        .post('/delays/ensure')
        .send({ journey_id: JOURNEY_A }) // no user_id
        .expect('Content-Type', /json/);

      expect(res.status).toBe(400);
    });
  });

  // ── AC-2: Idempotency ──────────────────────────────────────────────────────

  describe('AC-2: Idempotent — second call with same journey_id does not duplicate or error', () => {
    it('should return a terminal response on second call without error', async () => {
      // AC-2: Idempotent create using ON CONFLICT (journey_id) DO NOTHING or
      // findByJourneyId guard. Second call must NOT throw and must return terminal result.
      const { app, journeyRepo, evalService } = buildApp();

      // Simulate row already exists on second call
      (journeyRepo.findByJourneyId as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: MON_ID_B,
        journey_id: JOURNEY_B,
        user_id: USER_B,
        monitoring_status: 'completed',
        toc_code: 'GR',
        last_checked_at: new Date('2026-06-03T10:47:00.000Z'),
        scheduled_arrival: new Date('2026-06-03T10:30:00.000Z'),
      });

      // When row already exists the service should still return a terminal answer
      // (either from the existing row or by re-running evaluation idempotently).
      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'on_time',
        delay_minutes: 0,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:47:00.000Z',
      });

      // First call
      await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_B, USER_B));

      // Second call — must not error
      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_B, USER_B))
        .expect('Content-Type', /json/);

      // Must be a terminal status (not 5xx)
      expect(res.status).toBeLessThan(500);
      // Must not include 'pending' in status — terminal only (AC-4)
      if (res.body.status) {
        expect(res.body.status).not.toBe('pending');
      }
    });

    it('should NOT call journeyRepository.create twice for the same journey_id', async () => {
      // AC-2: On second call the endpoint must detect the existing row and skip create
      // (ON CONFLICT DO NOTHING or findByJourneyId guard).
      const { app, journeyRepo, evalService } = buildApp();

      let callCount = 0;
      (journeyRepo.findByJourneyId as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        // First call: not found. Second call: found (row was created on first call).
        return callCount === 1 ? null : {
          id: MON_ID_B,
          journey_id: JOURNEY_B,
          user_id: USER_B,
          monitoring_status: 'completed',
          toc_code: 'GR',
        };
      });

      (journeyRepo.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: MON_ID_B,
        journey_id: JOURNEY_B,
        user_id: USER_B,
        monitoring_status: 'completed',
        toc_code: 'GR',
      });

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'on_time',
        delay_minutes: 0,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:47:00.000Z',
      });

      // Make two calls
      await request(app).post('/delays/ensure').send(makeEnsureBody(JOURNEY_B, USER_B));
      await request(app).post('/delays/ensure').send(makeEnsureBody(JOURNEY_B, USER_B));

      // create must have been called at most once (idempotency guard)
      const createCalls = (journeyRepo.create as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(createCalls).toBeLessThanOrEqual(1);
    });
  });

  // ── AC-3: Shared DelayEvaluationService runs the same steps ────────────────

  describe('AC-3: DelayEvaluationService runs the same evaluation steps as handleHistoricJourney', () => {
    it('should call DelayEvaluationService.evaluate() with journey context', async () => {
      // AC-3: The endpoint must delegate to the shared DelayEvaluationService.evaluate()
      // which encapsulates: Darwin availability check → SLW/legacy eval →
      // persist delay_alerts or record not-detected.
      // This asserts the SAME code path is invoked for both Kafka and HTTP paths.
      const { app, evalService } = buildApp();

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'delayed',
        delay_minutes: 17,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:47:00.000Z',
      });

      const body = makeEnsureBody(JOURNEY_A, USER_A);
      await request(app)
        .post('/delays/ensure')
        .send(body);

      // The shared service MUST have been called
      expect(evalService.evaluate).toHaveBeenCalledTimes(1);

      // Called with journey context including journey_id and segments
      const callArgs = (evalService.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs).toMatchObject({
        journey_id: JOURNEY_A,
        user_id: USER_A,
      });
      // Must receive segments for SLW path
      expect(Array.isArray(callArgs.segments)).toBe(true);
      expect(callArgs.segments.length).toBeGreaterThan(0);
    });

    it('should call DelayEvaluationService.evaluate() with first segment RID for Darwin lookup', async () => {
      // AC-3: Darwin availability check uses firstSegment.rid — verify it is passed through
      const { app, evalService } = buildApp();

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'on_time',
        delay_minutes: 0,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:30:00.000Z',
      });

      const body = makeEnsureBody(JOURNEY_D, USER_D);
      await request(app)
        .post('/delays/ensure')
        .send(body);

      const callArgs = (evalService.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // The service receives segment data so it can perform the Darwin lookup
      expect(callArgs.segments[0].rid).toBe('202606037108175');
    });
  });

  // ── AC-4: Returns TERMINAL response — never 'pending' ──────────────────────

  describe('AC-4: Returns TERMINAL response (delayed | on_time | no_data) — NEVER pending', () => {
    it('should return status:delayed with delay fields when delay is detected', async () => {
      // AC-4: delayed terminal response must include delay_minutes, cancelled, toc_code,
      // last_observed_at. No 'pending' field.
      const { app, evalService } = buildApp();

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'delayed',
        delay_minutes: 17,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:47:00.000Z',
      });

      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_A, USER_A))
        .expect(200);

      expect(res.body.status).toBe('delayed');
      expect(typeof res.body.delay_minutes).toBe('number');
      expect(res.body.delay_minutes).toBeGreaterThanOrEqual(15);
      expect(typeof res.body.cancelled).toBe('boolean');
      expect(res.body.toc_code).toBeDefined();
      expect(res.body.last_observed_at).toBeDefined();
      // Must NOT be pending
      expect(res.body.status).not.toBe('pending');
    });

    it('should return status:on_time when Darwin reports no qualifying delay', async () => {
      // AC-4: on_time terminal response — delay_minutes < 15 or no alert
      const { app, evalService } = buildApp();

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'on_time',
        delay_minutes: 0,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:30:00.000Z',
      });

      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_D, USER_D))
        .expect(200);

      expect(res.body.status).toBe('on_time');
      expect(res.body.status).not.toBe('pending');
    });

    it('should return status:no_data when Darwin has no record for this service', async () => {
      // AC-4: no_data — Darwin returned darwin_unavailable or no RID match
      // This is the terminal "we cannot determine delay" response (not pending)
      const { app, evalService } = buildApp();

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'no_data',
      });

      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_C, USER_C))
        .expect(200);

      expect(res.body.status).toBe('no_data');
      // Must NOT be pending
      expect(res.body.status).not.toBe('pending');
    });

    it('should return status:cancelled when evaluation detects a cancellation', async () => {
      // AC-4: cancelled is also a terminal response (subtype of delayed)
      const { app, evalService } = buildApp();

      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'delayed',
        delay_minutes: 0,
        cancelled: true,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T09:00:00.000Z',
      });

      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_A, USER_A))
        .expect(200);

      // cancelled:true — status may be 'cancelled' or 'delayed' with cancelled:true
      // Either form is acceptable as long as cancelled:true is present and not pending
      expect(res.body.cancelled).toBe(true);
      expect(res.body.status).not.toBe('pending');
    });

    it('should NEVER return status:pending regardless of evaluation state', async () => {
      // AC-4: The whole point of ADR-031 — the ensure endpoint is synchronous and ALWAYS
      // returns a terminal result. The BFF must never see 'pending' from this endpoint.
      const { app, evalService } = buildApp();

      // Simulate evaluation resolves (whatever the outcome)
      (evalService.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue({
        outcome: 'on_time',
        delay_minutes: 0,
        cancelled: false,
        toc_code: 'GR',
        last_observed_at: '2026-06-03T10:30:00.000Z',
      });

      const res = await request(app)
        .post('/delays/ensure')
        .send(makeEnsureBody(JOURNEY_A, USER_A))
        .expect(200);

      expect(res.body.status).not.toBe('pending');
    });
  });

  // ── AC-5: GET /delays/:journeyId contract UNCHANGED (regression) ────────────

  describe('AC-5: GET /delays/:journeyId contract UNCHANGED after ADR-031 (regression guard)', () => {
    it('should still return 404 { error: "unknown_journey" } when journey not found via GET', async () => {
      // AC-5 regression guard: ensure the ensure endpoint does NOT affect existing GET handler
      // Import the existing GET handler
      const { DelayQueryHandler } = await import('../../../src/api/delay-query.handler.js');

      const app = express();
      app.use(express.json());

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(null),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      };

      const getHandler = new DelayQueryHandler({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockAlertRepo,
      });
      getHandler.register(app);

      const res = await request(app)
        .get(`/delays/${JOURNEY_A}?user_id=${USER_A}`)
        .expect(404);

      expect(res.body).toMatchObject({ error: 'unknown_journey' });
    });

    it('should still return 200 with status:delayed on GET when delay_alert row exists (AC-5 regression)', async () => {
      // AC-5 regression: GET path returns delayed when alert row found
      const { DelayQueryHandler } = await import('../../../src/api/delay-query.handler.js');

      const app = express();
      app.use(express.json());

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue({
          id: MON_ID_A,
          journey_id: JOURNEY_A,
          user_id: USER_A,
          monitoring_status: 'completed',
          toc_code: 'GR',
        }),
      };
      const mockAlertRepo = {
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue({
          monitored_journey_id: MON_ID_A,
          delay_minutes: 17,
          is_cancellation: false,
          delay_detected_at: new Date('2026-06-03T10:47:00.000Z'),
        }),
      };

      const getHandler = new DelayQueryHandler({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockAlertRepo,
      });
      getHandler.register(app);

      const res = await request(app)
        .get(`/delays/${JOURNEY_A}?user_id=${USER_A}`)
        .expect(200);

      expect(res.body.status).toBe('delayed');
      expect(res.body.delay_minutes).toBe(17);
    });

    it('should still create monitored_journey row with monitoring_status=completed on not-detected path (BL-315 0eb1f68 guard)', async () => {
      // AC-5 regression: async Kafka path — publishDelayNotDetected MUST create a
      // monitored_journeys row so GET returns on_time instead of 404.
      // This was the fix in commit 0eb1f68. Verify it is not reverted by ADR-031 work.
      const { JourneyConfirmedHandler } = await import('../../../src/kafka/journey-confirmed-handler.js');

      const mockJourneyRepo = {
        findByJourneyId: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: MON_ID_A,
          journey_id: JOURNEY_A,
          user_id: USER_A,
          monitoring_status: 'completed',
        }),
      };
      const mockAlertRepo = { create: vi.fn() };
      const mockOutboxRepo = { create: vi.fn() };
      const mockDarwinClient = {
        getDelayInfo: vi.fn().mockResolvedValue({
          delay_minutes: 5, // below threshold → not detected
          is_cancelled: false,
          delay_reasons: null,
        }),
        getServiceWithStops: vi.fn().mockResolvedValue({}),
      };

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mockJourneyRepo as any,
        delayAlertRepository: mockAlertRepo as any,
        outboxRepository: mockOutboxRepo as any,
        darwinClient: mockDarwinClient as any,
      });

      await handler.handle({
        journey_id: JOURNEY_A,
        user_id: USER_A,
        origin_crs: 'YRK',
        destination_crs: 'KGX',
        departure_datetime: '2026-01-01T08:30:00.000Z', // in the past → historic path
        arrival_datetime: '2026-01-01T10:30:00.000Z',
        journey_type: 'single',
        toc_code: 'GR',
        segments: [{
          segment_order: 0,
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          scheduled_departure: '2026-01-01T08:30:00.000Z',
          scheduled_arrival: '2026-01-01T10:30:00.000Z',
          rid: '202601017108175',
          toc_code: 'GR',
        }],
        correlation_id: 'test-corr-regression-0001',
      });

      // journeyRepository.create MUST have been called (to persist the completed row)
      expect(mockJourneyRepo.create).toHaveBeenCalled();
      const createCall = (mockJourneyRepo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.monitoring_status).toBe('completed');
      expect(createCall.journey_id).toBe(JOURNEY_A);
    });
  });
});
