/**
 * BL-315: journey.confirmed handler must persist toc_code through create() path
 *
 * Bug summary (T1 confirmed, Quinn reconciled):
 *   JourneyRepository.create() INSERT column list omits toc_code (lines 30-51 of
 *   journey-repository.ts). Even though the MonitoredJourney type and mapRow already
 *   carry the field, the INSERT never writes it — so every newly-created monitored
 *   journey row has toc_code = NULL regardless of what was passed to create().
 *
 *   Additionally, createDelayAlert() (journey-confirmed-handler.ts ~lines 353-365)
 *   does NOT forward payload.toc_code to journeyRepository.create(), so even once
 *   the INSERT column list is fixed, the value passed would still be undefined.
 *
 *   Downstream consequence:
 *     monitored_journeys.toc_code = NULL
 *     → GET /delays/:journeyId returns toc_code: null
 *     → EligibilityClient.evaluate() receives toc_code: null
 *     → evaluate() coerces null → 'UNKNOWN' (line 42 of eligibility-client.ts)
 *     → eligibility-engine POST /eligibility/evaluate returns 400 "Unknown TOC code: UNKNOWN"
 *     → timeout banner in PWA
 *
 * Phase    : T2-test (Jessie — Bug-reproducing tests, TDD per ADR-014)
 * Story    : BL-315
 * Date     : 2026-06-07
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * RED-first proof: AC-V1, AC-V2, AC-V5 MUST FAIL on current HEAD.
 *   AC-V1 fails: create() INSERT omits toc_code → DB column stays NULL → mapRow returns null
 *   AC-V2 fails: createDelayAlert() never passes payload.toc_code to create()
 *   AC-V5 fails: integration of V1+V2 — no toc_code ever reaches the stored row
 *   AC-V3 may already pass (handler returns whatever is in the row — contract shape is fine)
 *   AC-V6 must stay GREEN (regression guard — outbox payload already carries toc_code)
 *
 * AC coverage map:
 *   AC-V1: JourneyRepository.create() INSERT includes toc_code; mapRow round-trips it
 *   AC-V2: createDelayAlert() passes payload.toc_code to journeyRepository.create()
 *   AC-V3: GET /delays/:journeyId returns non-null toc_code for a row that has toc_code set
 *          (contract-lock; already passes for the handler shape — listed here for completeness)
 *   AC-V5: End-to-end: handle() with toc_code='GR' → journeyRepository.create called with toc_code:'GR'
 *   AC-V6: Outbox delay.detected event still carries payload.toc_code (regression guard)
 *
 * Note: AC-V4 is tested separately in evaluation-coordinator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import { JourneyConfirmedHandler } from '../../../src/kafka/journey-confirmed-handler.js';
import type { JourneyConfirmedPayload } from '../../../src/kafka/journey-confirmed-handler.js';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Helper: mock pool that captures query calls
// ---------------------------------------------------------------------------

function makeInsertCapturingPool(): {
  pool: Pool;
  getLastInsertSql: () => string;
  getLastInsertParams: () => unknown[];
} {
  let lastSql = '';
  let lastParams: unknown[] = [];

  const pool = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      // Capture every INSERT
      if (typeof sql === 'string' && sql.trim().toUpperCase().startsWith('INSERT')) {
        lastSql = sql;
        lastParams = params ?? [];
      }
      // Return a row that includes toc_code in the RETURNING * payload
      // (simulates Postgres returning the row with the inserted values)
      return Promise.resolve({
        rows: [
          {
            id: 'pk-bl315-insert-001',
            user_id: 'user-bl315',
            journey_id: 'journey-bl315',
            rid: '202606071000GR1',
            service_date: '2026-06-07',
            origin_crs: 'YRK',
            destination_crs: 'KGX',
            scheduled_departure: new Date('2026-06-07T10:00:00Z'),
            scheduled_arrival: new Date('2026-06-07T11:55:00Z'),
            monitoring_status: 'active',
            last_checked_at: null,
            next_check_at: new Date('2026-06-07T09:00:00Z'),
            created_at: new Date('2026-06-07T09:00:00Z'),
            updated_at: new Date('2026-06-07T09:00:00Z'),
            toc_code: 'GR',
          },
        ],
        rowCount: 1,
      });
    }),
    connect: vi.fn(),
  } as unknown as Pool;

  return {
    pool,
    getLastInsertSql: () => lastSql,
    getLastInsertParams: () => lastParams,
  };
}

// ---------------------------------------------------------------------------
// Standard journey.confirmed payload for York→KGX (LNER toc_code='GR')
// ---------------------------------------------------------------------------

function makeLnerPayload(overrides: Partial<JourneyConfirmedPayload> = {}): JourneyConfirmedPayload {
  return {
    journey_id: 'bl315-journey-001',
    user_id: 'bl315-user-001',
    origin_crs: 'YRK',
    destination_crs: 'KGX',
    departure_datetime: '2028-06-07T10:00:00Z', // future — takes the future/create path
    arrival_datetime: '2028-06-07T11:55:00Z',
    journey_type: 'single',
    toc_code: 'GR', // LNER code
    segments: [
      {
        segment_order: 1,
        origin_crs: 'YRK',
        destination_crs: 'KGX',
        scheduled_departure: '2028-06-07T10:00:00Z',
        scheduled_arrival: '2028-06-07T11:55:00Z',
        rid: '202806071000GR1',
        toc_code: 'GR',
      },
    ],
    correlation_id: 'bl315-corr-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-V1 (DISPOSITIVE): JourneyRepository.create() INSERT includes toc_code
// ---------------------------------------------------------------------------

describe('BL-315 AC-V1 (DISPOSITIVE): JourneyRepository.create() INSERT includes toc_code', () => {
  /**
   * AC-V1: The INSERT statement produced by create() MUST include toc_code
   * in the column list and pass the value as a parameter.
   *
   * FAILS TODAY (RED): journey-repository.ts lines 30-51 — the INSERT column list
   * is:  user_id, journey_id, rid, service_date, origin_crs, destination_crs,
   *      scheduled_departure, scheduled_arrival, monitoring_status,
   *      last_checked_at, next_check_at
   * toc_code is absent → DB column stays NULL.
   */

  it('AC-V1: create() with toc_code="GR" issues INSERT SQL containing toc_code', async () => {
    // AC-V1: Verify the SQL emitted by create() includes the toc_code column.
    // FAILS TODAY: toc_code is not in the INSERT column list (journey-repository.ts ~line 30-35).

    const { pool, getLastInsertSql, getLastInsertParams } = makeInsertCapturingPool();
    const repo = new JourneyRepository({ pool });

    await repo.create({
      user_id: 'user-bl315-v1',
      journey_id: 'journey-bl315-v1',
      rid: '202806071000GR1',
      service_date: '2026-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2028-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2028-06-07T11:55:00Z'),
      monitoring_status: 'active',
      next_check_at: new Date('2028-06-07T09:00:00Z'),
      toc_code: 'GR', // AC-V1: this value MUST appear in the INSERT
    });

    const sql = getLastInsertSql();
    const params = getLastInsertParams();

    // AC-V1 DISPOSITIVE: The INSERT SQL must name the toc_code column.
    // FAILS TODAY: column is absent from INSERT column list.
    expect(sql.toLowerCase()).toContain('toc_code');

    // The value 'GR' must be in the parameter array.
    // FAILS TODAY: parameter array has 11 elements (no slot for toc_code).
    expect(params).toContain('GR');
  });

  it('AC-V1: create() with toc_code=null includes toc_code column in INSERT (null variant)', async () => {
    // AC-V1 null variant: Even when toc_code is null the column must appear in INSERT
    // so that the DB records explicit NULL rather than relying on the column default.

    const { pool, getLastInsertSql, getLastInsertParams } = makeInsertCapturingPool();
    const repo = new JourneyRepository({ pool });

    await repo.create({
      user_id: 'user-bl315-v1-null',
      journey_id: 'journey-bl315-v1-null',
      rid: null,
      service_date: '2026-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2028-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2028-06-07T11:55:00Z'),
      monitoring_status: 'pending_rid',
      toc_code: null,
    });

    const sql = getLastInsertSql();

    // Column must be present even for null — schema is nullable, not absent.
    expect(sql.toLowerCase()).toContain('toc_code');
  });

  it('AC-V1: create() result (mapRow round-trip) carries toc_code from RETURNING row', async () => {
    // AC-V1 mapRow variant: The RETURNING * row from the INSERT is mapped by mapRow().
    // The returned MonitoredJourney object MUST carry the toc_code field.
    // The pool mock returns toc_code:'GR' in the row.
    // FAILS TODAY: mapRow already carries toc_code (BL-314 fixed that) — BUT the INSERT
    // never writes the value, so in practice the DB returns NULL. This test verifies
    // the create() → mapRow() path surfaces toc_code when the DB row has it.

    const { pool } = makeInsertCapturingPool();
    const repo = new JourneyRepository({ pool });

    const result = await repo.create({
      user_id: 'user-bl315-v1-rt',
      journey_id: 'journey-bl315-v1-rt',
      rid: '202806071000GR1',
      service_date: '2026-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2028-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2028-06-07T11:55:00Z'),
      monitoring_status: 'active',
      toc_code: 'GR',
    });

    // The returned object must carry toc_code from the RETURNING * row.
    expect((result as Record<string, unknown>).toc_code).toBe('GR');
  });
});

// ---------------------------------------------------------------------------
// AC-V2 (DISPOSITIVE): createDelayAlert() passes payload.toc_code to create()
// ---------------------------------------------------------------------------

describe('BL-315 AC-V2 (DISPOSITIVE): createDelayAlert() passes payload.toc_code to journeyRepository.create()', () => {
  /**
   * AC-V2: When JourneyConfirmedHandler.createDelayAlert() is called (historic path —
   * journey departure in the past, delay >= 15min), it calls journeyRepository.create().
   * That create() call MUST include toc_code from the event payload.
   *
   * FAILS TODAY (RED): journey-confirmed-handler.ts ~lines 353-365 builds the object
   * passed to create() without toc_code:
   *   { journey_id, user_id, rid, service_date, origin_crs, destination_crs,
   *     scheduled_departure, scheduled_arrival, monitoring_status, last_checked_at,
   *     next_check_at }
   * payload.toc_code is never forwarded even though it IS used at ~line 392 for the
   * outbox delay.detected event.
   */

  it('AC-V2: createDelayAlert() spy on journeyRepository.create receives toc_code="GR" from payload', async () => {
    // AC-V2: Spy on repository.create, confirm the argument contains toc_code:'GR'.
    // FAILS TODAY: create() is called but the argument object has no toc_code property.

    const mockCreate = vi.fn().mockResolvedValue({
      id: 'pk-bl315-v2-001',
      user_id: 'bl315-user-001',
      journey_id: 'bl315-journey-v2',
      rid: '202206071000GR1',
      service_date: '2022-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2022-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2022-06-07T11:55:00Z'),
      monitoring_status: 'completed' as const,
      last_checked_at: null,
      next_check_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      toc_code: 'GR',
    });

    const mockJourneyRepo = {
      create: mockCreate,
      findById: vi.fn().mockResolvedValue(null),
      findByJourneyId: vi.fn().mockResolvedValue(null), // idempotency check — no existing journey
      findByUserId: vi.fn().mockResolvedValue([]),
      findJourneysDueForCheck: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateLastChecked: vi.fn(),
      delete: vi.fn(),
    };

    const mockDelayAlertRepo = {
      create: vi.fn().mockResolvedValue({ id: 'alert-bl315-v2' }),
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      markClaimTriggered: vi.fn(),
      update: vi.fn(),
    };

    const mockOutboxRepo = {
      create: vi.fn().mockResolvedValue({ id: 'outbox-bl315-v2' }),
    };

    const mockDarwinClient = {
      // historic path: departure in the past, delay >= 15 min
      getDelayInfo: vi.fn().mockResolvedValue({
        delay_minutes: 45,
        is_cancelled: false,
        delay_reasons: null,
        status: 'delayed',
        stops: null,
        toc_code: 'GR',
      }),
      getServiceWithStops: vi.fn(),
      getDelaysByRids: vi.fn(),
    };

    const handler = new JourneyConfirmedHandler({
      journeyRepository: mockJourneyRepo as unknown as JourneyRepository,
      delayAlertRepository: mockDelayAlertRepo as unknown as import('../../../src/repositories/delay-alert-repository.js').DelayAlertRepository,
      outboxRepository: mockOutboxRepo as unknown as import('../../../src/repositories/outbox-repository.js').OutboxRepository,
      darwinClient: mockDarwinClient as unknown as import('../../../src/clients/darwin-ingestor.js').DarwinIngestorClient,
    });

    // Payload with departure in the past — takes the historic path → createDelayAlert()
    const payload: JourneyConfirmedPayload = makeLnerPayload({
      departure_datetime: '2022-06-07T10:00:00Z', // past
      arrival_datetime: '2022-06-07T11:55:00Z',
      segments: [
        {
          segment_order: 1,
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          scheduled_departure: '2022-06-07T10:00:00Z',
          scheduled_arrival: '2022-06-07T11:55:00Z',
          rid: '202206071000GR1',
          toc_code: 'GR',
        },
      ],
    });

    await handler.handle(payload);

    // journeyRepository.create MUST have been called (the FK parent row for delay_alerts)
    expect(mockCreate).toHaveBeenCalled();

    // AC-V2 DISPOSITIVE: The argument to create() MUST include toc_code: 'GR'.
    // FAILS TODAY: the object constructed at lines 353-365 has no toc_code key.
    const createCallArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createCallArg).toHaveProperty('toc_code', 'GR');
  });

  it('AC-V2: handleFutureJourney() also passes toc_code to journeyRepository.create()', async () => {
    // AC-V2 future-path variant: handleFutureJourney() (departure in the future) also
    // calls journeyRepository.create() and MUST pass toc_code from the payload.
    // FAILS TODAY: lines 307-318 of journey-confirmed-handler.ts build the create()
    // argument without toc_code.

    const mockCreate = vi.fn().mockResolvedValue({
      id: 'pk-bl315-v2-future',
      user_id: 'bl315-user-future',
      journey_id: 'bl315-journey-future',
      rid: '202806071000GR1',
      service_date: '2028-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2028-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2028-06-07T11:55:00Z'),
      monitoring_status: 'active' as const,
      last_checked_at: null,
      next_check_at: new Date('2028-06-07T09:00:00Z'),
      created_at: new Date(),
      updated_at: new Date(),
      toc_code: 'GR',
    });

    const mockJourneyRepo = {
      create: mockCreate,
      findById: vi.fn().mockResolvedValue(null),
      findByJourneyId: vi.fn().mockResolvedValue(null),
      findByUserId: vi.fn().mockResolvedValue([]),
      findJourneysDueForCheck: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateLastChecked: vi.fn(),
      delete: vi.fn(),
    };

    const mockOutboxRepo = {
      create: vi.fn().mockResolvedValue({ id: 'outbox-bl315-future' }),
    };

    const mockDarwinClient = {
      getDelayInfo: vi.fn(),
      getServiceWithStops: vi.fn(),
      getDelaysByRids: vi.fn(),
    };

    const mockDelayAlertRepo = {
      create: vi.fn().mockResolvedValue({ id: 'alert-bl315-future' }),
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      markClaimTriggered: vi.fn(),
      update: vi.fn(),
    };

    const handler = new JourneyConfirmedHandler({
      journeyRepository: mockJourneyRepo as unknown as JourneyRepository,
      delayAlertRepository: mockDelayAlertRepo as unknown as import('../../../src/repositories/delay-alert-repository.js').DelayAlertRepository,
      outboxRepository: mockOutboxRepo as unknown as import('../../../src/repositories/outbox-repository.js').OutboxRepository,
      darwinClient: mockDarwinClient as unknown as import('../../../src/clients/darwin-ingestor.js').DarwinIngestorClient,
    });

    // Future departure — takes handleFutureJourney() path
    const payload = makeLnerPayload();
    await handler.handle(payload);

    expect(mockCreate).toHaveBeenCalled();

    // AC-V2 future-path DISPOSITIVE
    const createCallArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createCallArg).toHaveProperty('toc_code', 'GR');
  });
});

// ---------------------------------------------------------------------------
// AC-V5 (DISPOSITIVE): End-to-end — toc_code='GR' from payload → create() receives it
// ---------------------------------------------------------------------------

describe('BL-315 AC-V5 (DISPOSITIVE): journey.confirmed with toc_code="GR" → create() receives toc_code="GR"', () => {
  /**
   * AC-V5: Integration of V1 + V2. This is the end-to-end intent test:
   * a journey.confirmed event with toc_code='GR' (LNER, York→KGX) MUST result in
   * journeyRepository.create() being called with toc_code:'GR' (NOT missing, NOT null).
   *
   * This test exercises the full handler.handle() → createDelayAlert() / handleFutureJourney()
   * → journeyRepository.create() chain with a realistic LNER payload.
   *
   * FAILS TODAY (RED): Both createDelayAlert() and handleFutureJourney() omit toc_code
   * from the create() argument. The spy will see create() called but without toc_code.
   */

  it('AC-V5: LNER journey.confirmed (historic, 45-min delay) → create() argument carries toc_code="GR"', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      id: 'pk-bl315-e2e-001',
      user_id: 'bl315-user-e2e',
      journey_id: 'bl315-journey-e2e',
      rid: '202206071000GR1',
      service_date: '2022-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2022-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2022-06-07T11:55:00Z'),
      monitoring_status: 'completed' as const,
      last_checked_at: null,
      next_check_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      toc_code: 'GR',
    });

    const handler = new JourneyConfirmedHandler({
      journeyRepository: {
        create: createSpy,
        findByJourneyId: vi.fn().mockResolvedValue(null),
        findById: vi.fn(),
        findByUserId: vi.fn(),
        findJourneysDueForCheck: vi.fn(),
        update: vi.fn(),
        updateStatus: vi.fn(),
        updateLastChecked: vi.fn(),
        delete: vi.fn(),
      } as unknown as JourneyRepository,
      delayAlertRepository: {
        create: vi.fn().mockResolvedValue({ id: 'alert-e2e' }),
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
        markClaimTriggered: vi.fn(),
        update: vi.fn(),
      } as unknown as import('../../../src/repositories/delay-alert-repository.js').DelayAlertRepository,
      outboxRepository: {
        create: vi.fn().mockResolvedValue({ id: 'outbox-e2e' }),
      } as unknown as import('../../../src/repositories/outbox-repository.js').OutboxRepository,
      darwinClient: {
        getDelayInfo: vi.fn().mockResolvedValue({
          delay_minutes: 45,
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: null,
          toc_code: 'GR',
        }),
        getServiceWithStops: vi.fn(),
        getDelaysByRids: vi.fn(),
      } as unknown as import('../../../src/clients/darwin-ingestor.js').DarwinIngestorClient,
    });

    // York → KGX LNER, departure in the past, 45-min delay → createDelayAlert() path
    const payload: JourneyConfirmedPayload = makeLnerPayload({
      journey_id: 'bl315-journey-e2e',
      user_id: 'bl315-user-e2e',
      departure_datetime: '2022-06-07T10:00:00Z',
      arrival_datetime: '2022-06-07T11:55:00Z',
      segments: [
        {
          segment_order: 1,
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          scheduled_departure: '2022-06-07T10:00:00Z',
          scheduled_arrival: '2022-06-07T11:55:00Z',
          rid: '202206071000GR1',
          toc_code: 'GR',
        },
      ],
    });

    await handler.handle(payload);

    // AC-V5 DISPOSITIVE: create() must have been called with toc_code: 'GR'
    expect(createSpy).toHaveBeenCalled();
    const arg = createSpy.mock.calls[0][0] as Record<string, unknown>;

    // This assertion is the precise cross-cutting proof of the bug being fixed:
    // toc_code from the journey.confirmed event payload reaches the monitored_journeys INSERT.
    // FAILS TODAY: arg.toc_code is undefined (not in the object at all).
    expect(arg.toc_code).toBe('GR');
    expect(arg.toc_code).not.toBeNull();
    expect(arg.toc_code).not.toBe('UNKNOWN');
  });

  it('AC-V5: Future LNER journey (not delayed) → handleFutureJourney() create() argument carries toc_code="GR"', async () => {
    // AC-V5 future-path: same intent, but via handleFutureJourney() instead of createDelayAlert()
    const createSpy = vi.fn().mockResolvedValue({
      id: 'pk-bl315-e2e-future',
      user_id: 'bl315-user-e2e-f',
      journey_id: 'bl315-journey-e2e-f',
      rid: '202806071000GR1',
      service_date: '2028-06-07',
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date('2028-06-07T10:00:00Z'),
      scheduled_arrival: new Date('2028-06-07T11:55:00Z'),
      monitoring_status: 'active' as const,
      last_checked_at: null,
      next_check_at: new Date('2028-06-07T09:00:00Z'),
      created_at: new Date(),
      updated_at: new Date(),
      toc_code: 'GR',
    });

    const handler = new JourneyConfirmedHandler({
      journeyRepository: {
        create: createSpy,
        findByJourneyId: vi.fn().mockResolvedValue(null),
        findById: vi.fn(),
        findByUserId: vi.fn(),
        findJourneysDueForCheck: vi.fn(),
        update: vi.fn(),
        updateStatus: vi.fn(),
        updateLastChecked: vi.fn(),
        delete: vi.fn(),
      } as unknown as JourneyRepository,
      delayAlertRepository: {
        create: vi.fn().mockResolvedValue({ id: 'alert-e2e-f' }),
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
        markClaimTriggered: vi.fn(),
        update: vi.fn(),
      } as unknown as import('../../../src/repositories/delay-alert-repository.js').DelayAlertRepository,
      outboxRepository: {
        create: vi.fn().mockResolvedValue({ id: 'outbox-e2e-f' }),
      } as unknown as import('../../../src/repositories/outbox-repository.js').OutboxRepository,
      darwinClient: {
        getDelayInfo: vi.fn(),
        getServiceWithStops: vi.fn(),
        getDelaysByRids: vi.fn(),
      } as unknown as import('../../../src/clients/darwin-ingestor.js').DarwinIngestorClient,
    });

    const payload = makeLnerPayload({
      journey_id: 'bl315-journey-e2e-f',
      user_id: 'bl315-user-e2e-f',
    });

    await handler.handle(payload);

    expect(createSpy).toHaveBeenCalled();
    const arg = createSpy.mock.calls[0][0] as Record<string, unknown>;

    // FAILS TODAY: handleFutureJourney() does not include toc_code in the create() call.
    expect(arg.toc_code).toBe('GR');
    expect(arg.toc_code).not.toBeNull();
    expect(arg.toc_code).not.toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// AC-V6 (REGRESSION GUARD): outbox delay.detected event still carries toc_code
// ---------------------------------------------------------------------------

describe('BL-315 AC-V6 (REGRESSION GUARD): outbox delay.detected event carries payload.toc_code', () => {
  /**
   * AC-V6: This path ALREADY WORKS. The delay.detected outbox event at
   * journey-confirmed-handler.ts ~line 392 already uses payload.toc_code.
   * This test must stay GREEN after Blake's fix — it guards against any accidental
   * regression to the outbox publish path while fixing the create() path.
   *
   * Expected result: GREEN on current HEAD and GREEN after fix.
   */

  it('AC-V6 (REGRESSION GUARD): delay.detected outbox event payload includes toc_code="GR"', async () => {
    const outboxCreate = vi.fn().mockResolvedValue({ id: 'outbox-v6' });

    const handler = new JourneyConfirmedHandler({
      journeyRepository: {
        create: vi.fn().mockResolvedValue({
          id: 'pk-v6',
          user_id: 'bl315-user-v6',
          journey_id: 'bl315-journey-v6',
          rid: '202206071000GR1',
          service_date: '2022-06-07',
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          scheduled_departure: new Date('2022-06-07T10:00:00Z'),
          scheduled_arrival: new Date('2022-06-07T11:55:00Z'),
          monitoring_status: 'completed' as const,
          last_checked_at: null,
          next_check_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          toc_code: 'GR',
        }),
        findByJourneyId: vi.fn().mockResolvedValue(null),
        findById: vi.fn(),
        findByUserId: vi.fn(),
        findJourneysDueForCheck: vi.fn(),
        update: vi.fn(),
        updateStatus: vi.fn(),
        updateLastChecked: vi.fn(),
        delete: vi.fn(),
      } as unknown as JourneyRepository,
      delayAlertRepository: {
        create: vi.fn().mockResolvedValue({ id: 'alert-v6' }),
        findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
        markClaimTriggered: vi.fn(),
        update: vi.fn(),
      } as unknown as import('../../../src/repositories/delay-alert-repository.js').DelayAlertRepository,
      outboxRepository: {
        create: outboxCreate,
      } as unknown as import('../../../src/repositories/outbox-repository.js').OutboxRepository,
      darwinClient: {
        getDelayInfo: vi.fn().mockResolvedValue({
          delay_minutes: 45,
          is_cancelled: false,
          delay_reasons: null,
          status: 'delayed',
          stops: null,
          toc_code: 'GR',
        }),
        getServiceWithStops: vi.fn(),
        getDelaysByRids: vi.fn(),
      } as unknown as import('../../../src/clients/darwin-ingestor.js').DarwinIngestorClient,
    });

    // Historic departure → createDelayAlert() → outbox delay.detected event
    const payload: JourneyConfirmedPayload = makeLnerPayload({
      journey_id: 'bl315-journey-v6',
      user_id: 'bl315-user-v6',
      departure_datetime: '2022-06-07T10:00:00Z',
      arrival_datetime: '2022-06-07T11:55:00Z',
      segments: [
        {
          segment_order: 1,
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          scheduled_departure: '2022-06-07T10:00:00Z',
          scheduled_arrival: '2022-06-07T11:55:00Z',
          rid: '202206071000GR1',
          toc_code: 'GR',
        },
      ],
    });

    await handler.handle(payload);

    // The outbox.create MUST have been called with a delay.detected event
    const delayDetectedCalls = outboxCreate.mock.calls.filter(
      ([arg]: [Record<string, unknown>]) =>
        typeof arg === 'object' && arg.event_type === 'delay.detected'
    );

    expect(delayDetectedCalls.length).toBeGreaterThanOrEqual(1);

    // AC-V6 REGRESSION GUARD: toc_code must be present in the outbox payload
    const outboxArg = delayDetectedCalls[0][0] as Record<string, unknown>;
    const outboxPayload = outboxArg.payload as Record<string, unknown>;

    expect(outboxPayload.toc_code).toBe('GR');
  });
});

// ---------------------------------------------------------------------------
// AC-V3 (CONTRACT LOCK): GET /delays/:journeyId surfaces non-null toc_code
// ---------------------------------------------------------------------------

describe('BL-315 AC-V3 (CONTRACT LOCK): delay-query handler returns non-null toc_code when row has toc_code set', () => {
  /**
   * AC-V3: This is a contract-lock test for DelayQueryHandler. When the
   * monitored_journeys row has toc_code set (e.g. after Blake's fix persists it),
   * GET /delays/:journeyId must return a non-null toc_code in the response body.
   *
   * NOTE: This test may already pass at the handler level (BL-313 fixed the handler
   * shape). The point of this test is to confirm the contract holds when real data
   * is present. It is NOT a RED test — it should be GREEN on current HEAD and stay
   * GREEN after Blake's fix.
   */

  it('AC-V3 (CONTRACT LOCK): GET /delays/:journeyId returns toc_code="GR" when row has toc_code="GR"', async () => {
    const express = await import('express');
    const { default: request } = await import('supertest');
    const { DelayQueryHandler } = await import('../../../src/api/delay-query.handler.js');

    // UUID v4 required by handler validation
    const JOURNEY_UUID = 'aaaa0315-0003-4003-8003-aaaaaaaaaaaa';
    const USER_UUID    = 'bbbb0315-0003-4003-8003-bbbbbbbbbbbb';
    const PK_UUID      = 'cccc0315-0003-4003-8003-cccccccccccc';

    const journeyRow = {
      id: PK_UUID,
      user_id: USER_UUID,
      journey_id: JOURNEY_UUID,
      monitoring_status: 'delayed',
      toc_code: 'GR', // Set — represents the post-fix state
      last_checked_at: new Date('2026-06-07T10:05:00Z'),
      scheduled_arrival: new Date('2026-06-07T11:55:00Z'),
    };

    const alertRow = {
      monitored_journey_id: PK_UUID,
      delay_minutes: 45,
      is_cancellation: false,
      delay_detected_at: new Date('2026-06-07T10:05:00Z'),
    };

    const mockJourneyRepo = {
      findByJourneyId: vi.fn().mockResolvedValue(journeyRow),
    };
    const mockAlertRepo = {
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(alertRow),
    };

    const handler = new DelayQueryHandler({
      journeyRepository: mockJourneyRepo,
      delayAlertRepository: mockAlertRepo,
    });

    const app = express.default();
    app.use(express.default.json());
    handler.register(app);

    const res = await request(app)
      .get(`/delays/${JOURNEY_UUID}`)
      .query({ user_id: USER_UUID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('delayed');

    // AC-V3 CONTRACT LOCK: toc_code must not be null when the row has 'GR'
    expect(res.body.toc_code).not.toBeNull();
    expect(res.body.toc_code).toBe('GR');
  });
});
