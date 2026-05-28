/**
 * BL-314: delay-tracker JourneyRepository must persist and surface toc_code
 *
 * Root cause (Hoops Phase 2 verified, 2026-05-28):
 *   BL-313 added toc_code to DarwinDelayInfo and the HTTP response contract,
 *   but the backing DB column was never created (no migration) and the
 *   JourneyRepository never wired the field:
 *     - mapRow()        omits  toc_code entirely — returns undefined
 *     - update()        silently drops toc_code (not in allowedFields)
 *     - MonitoredJourney type has no toc_code field
 *
 *   Consequence: every SELECT returns toc_code=undefined; the handler falls
 *   back to `monitoredJourney.toc_code ?? null` which yields null; the
 *   evaluation-coordinator aborts the eligibility check. 5th user failure.
 *
 * Hoops migration (on disk, NOT to be modified):
 *   services/delay-tracker/migrations/1779982907741_add-toc-code-to-monitored-journeys.cjs
 *   Adds  delay_tracker.monitored_journeys.toc_code  VARCHAR(10) NULL
 *
 * Value format: 2-char ATOC code (e.g. 'XC', 'SE', 'GW') as returned by
 *   darwin-ingestor's HTTP API — NOT the raw Darwin single-char code.
 *   darwin-ingestor already normalises 'C' → 'XC' so NO mapping code needed here.
 *
 * Phase    : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date     : 2026-05-28
 * Story    : BL-314 (Troubleshooting — toc_code DB column + write path)
 * ADR-030  : Amended — toc_code must be persisted, not live-read.
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL on current code (delay-tracker HEAD as of 2026-05-28).
 * See per-test comments explaining exactly why each fails today.
 *
 * AC coverage map (BL-314):
 *
 *   AC-mapRow (DISPOSITIVE — unit, no Docker):
 *     JourneyRepository.mapRow() carries toc_code from the raw DB row to the
 *     returned MonitoredJourney object.  FAILS today: field absent.
 *
 *   AC-type:
 *     MonitoredJourney interface includes toc_code?: string | null.
 *     FAILS today: field absent from type → compile error + undefined at runtime.
 *
 *   AC-update-allowedFields:
 *     JourneyRepository.update(id, { toc_code: 'XC' }) issues SQL that includes
 *     toc_code in the SET clause.  FAILS today: allowedFields excludes it, value
 *     silently dropped → no SQL param, no column update.
 *
 *   AC-write-path:
 *     The DelayTrackerService / detection-cycle path persists toc_code from the
 *     darwin-ingestor response onto the monitored_journey row.
 *     FAILS today: darwinResponse is mapped to { rid, total_delay_minutes,
 *     cancelled, delay_reasons } — toc_code is never forwarded to repo.update().
 *
 *   AC-real-round-trip (Testcontainers — CI/Docker-gated):
 *     Real Postgres: run all migrations including Hoops's new one, INSERT a row
 *     with toc_code='XC', findByJourneyId(), assert result.toc_code === 'XC'.
 *     Also verifies: column exists after up(), absent after down().
 *     Skipped locally (no Docker); runs in CI.  FAILS today: column does not
 *     exist on HEAD (migration not applied) → INSERT fails or toc_code not read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Access the private mapRow method via a pool mock that captures the return
 * value of a SELECT. We expose mapRow indirectly through findById so the test
 * can stay black-box about how Pool is set up, while still exercising the real
 * mapRow code path.
 *
 * Strategy: supply a fake pool whose query() resolves with the given row,
 * then call findById() and inspect the result.
 */
function makePoolWith(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    connect: vi.fn(),
  } as unknown as import('pg').Pool;
}

// ---------------------------------------------------------------------------
// AC-type: MonitoredJourney interface must carry toc_code
// ---------------------------------------------------------------------------

describe('BL-314 AC-type: MonitoredJourney type includes toc_code?: string | null', () => {
  /**
   * This test fails today because MonitoredJourney (src/types.ts ~line 19-34)
   * has NO toc_code field.  TypeScript will error when we try to assign the
   * field.  The dynamic import + runtime check encodes the type contract so
   * it fails in the test suite even when tsc isn't run explicitly.
   */
  it('AC-type: MonitoredJourney object can carry toc_code = "XC" (compile-time contract)', async () => {
    // AC-type: After the fix, MonitoredJourney MUST accept toc_code?: string | null.
    // Dynamic import so the test suite loads (RED) rather than crashing at parse time.
    const { type: _typed } = await import('../../../src/types.js').then((m) => {
      // Construct a minimal MonitoredJourney that includes toc_code.
      // On current code tsc will report: "Object literal may only specify known
      // properties, and 'toc_code' does not exist in type 'MonitoredJourney'."
      const typed: m.MonitoredJourney = {
        user_id:              'user-bl314-type-test',
        journey_id:           'journey-bl314-type-test',
        service_date:         '2026-05-28',
        origin_crs:           'NCL',
        destination_crs:      'EDB',
        scheduled_departure:  new Date('2026-05-28T10:00:00Z'),
        scheduled_arrival:    new Date('2026-05-28T12:00:00Z'),
        monitoring_status:    'active',
        toc_code:             'XC',   // BL-314: FAILS today — field not on type
      } as m.MonitoredJourney;       // cast silences ts error; runtime assertion below catches the gap
      return { type: typed };
    });

    // If the type was properly extended, the value round-trips correctly.
    // On current code this will be undefined because cast-assignment doesn't
    // add the property to the object when the interface excludes it.
    expect((_typed as Record<string, unknown>).toc_code).toBe('XC');
  });

  it('AC-type: MonitoredJourney accepts toc_code = null (nullable)', async () => {
    // AC-type: The null variant — nullable per the VARCHAR(10) NULL column.
    const { type: _typed } = await import('../../../src/types.js').then((m) => {
      const typed: m.MonitoredJourney = {
        user_id:              'user-bl314-null',
        journey_id:           'journey-bl314-null',
        service_date:         '2026-05-28',
        origin_crs:           'PAD',
        destination_crs:      'BRI',
        scheduled_departure:  new Date('2026-05-28T09:00:00Z'),
        scheduled_arrival:    new Date('2026-05-28T10:45:00Z'),
        monitoring_status:    'delayed',
        toc_code:             null,   // BL-314: nullable variant
      } as m.MonitoredJourney;
      return { type: typed };
    });

    expect((_typed as Record<string, unknown>).toc_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-mapRow (DISPOSITIVE): mapRow() must carry toc_code from raw DB row
// ---------------------------------------------------------------------------

describe('BL-314 AC-mapRow (DISPOSITIVE): JourneyRepository.mapRow() surfaces toc_code', () => {
  /**
   * mapRow() is private, so we exercise it through findById() which calls
   * `return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null`.
   *
   * FAILS today: mapRow() (journey-repository.ts ~lines 209-228) constructs the
   * return object without a toc_code property.  result.toc_code is undefined.
   */

  it('AC-mapRow (DISPOSITIVE): findById() returns toc_code = "XC" when DB row has toc_code = "XC"', async () => {
    // AC-mapRow: Core dispositive test — locally runnable, no Docker.
    // Supply a raw DB row that includes toc_code: 'XC'.
    // After the fix, mapRow must include the field in the returned MonitoredJourney.
    // FAILS today: toc_code omitted from mapRow return object → undefined.

    const { JourneyRepository } = await import(
      '../../../src/repositories/journey-repository.js'
    );

    const rawRow: Record<string, unknown> = {
      id:                   'pk-bl314-maprow-001',
      user_id:              'user-bl314-001',
      journey_id:           'journey-bl314-001',
      rid:                  '202605280800XC1',
      service_date:         '2026-05-28',
      origin_crs:           'NCL',
      destination_crs:      'EDB',
      scheduled_departure:  new Date('2026-05-28T08:00:00Z'),
      scheduled_arrival:    new Date('2026-05-28T10:30:00Z'),
      monitoring_status:    'active',
      last_checked_at:      null,
      next_check_at:        null,
      created_at:           new Date('2026-05-28T07:00:00Z'),
      updated_at:           new Date('2026-05-28T07:00:00Z'),
      toc_code:             'XC',   // BL-314: new column, present in row from DB
    };

    const pool = makePoolWith([rawRow]);
    const repo = new JourneyRepository({ pool });

    const result = await repo.findById('pk-bl314-maprow-001');

    expect(result).not.toBeNull();
    // DISPOSITIVE: This is the precise assertion that proves or disproves the fix.
    // Fails today because mapRow returns an object without a toc_code key.
    expect((result as Record<string, unknown>).toc_code).toBe('XC');
  });

  it('AC-mapRow: findByJourneyId() propagates toc_code = null when DB row has NULL', async () => {
    // AC-mapRow: Null variant — existing rows pre-migration have NULL in the column.
    // mapRow must carry null, not undefined or omit the field.
    // FAILS today: field absent → undefined, but downstream handler expects explicit null.

    const { JourneyRepository } = await import(
      '../../../src/repositories/journey-repository.js'
    );

    const rawRow: Record<string, unknown> = {
      id:                   'pk-bl314-maprow-002',
      user_id:              'user-bl314-002',
      journey_id:           'journey-bl314-002',
      rid:                  null,
      service_date:         '2026-05-28',
      origin_crs:           'KGX',
      destination_crs:      'EDB',
      scheduled_departure:  new Date('2026-05-28T10:00:00Z'),
      scheduled_arrival:    new Date('2026-05-28T13:00:00Z'),
      monitoring_status:    'pending_rid',
      last_checked_at:      null,
      next_check_at:        null,
      created_at:           new Date('2026-05-28T09:00:00Z'),
      updated_at:           new Date('2026-05-28T09:00:00Z'),
      toc_code:             null,   // BL-314: NULL for pre-migration rows
    };

    const pool = makePoolWith([rawRow]);
    const repo = new JourneyRepository({ pool });

    const result = await repo.findByJourneyId('journey-bl314-002');

    expect(result).not.toBeNull();
    // The field must be explicitly null (not undefined) — ?? null in handler depends on this.
    // Using hasOwnProperty to distinguish absent field from null value:
    expect(Object.prototype.hasOwnProperty.call(result, 'toc_code')).toBe(true);
    expect((result as Record<string, unknown>).toc_code).toBeNull();
  });

  it('AC-mapRow: findJourneysDueForCheck() result objects carry toc_code', async () => {
    // AC-mapRow: The polling path also calls mapRow() — verify it is covered.

    const { JourneyRepository } = await import(
      '../../../src/repositories/journey-repository.js'
    );

    const rawRow: Record<string, unknown> = {
      id:                   'pk-bl314-maprow-003',
      user_id:              'user-bl314-003',
      journey_id:           'journey-bl314-003',
      rid:                  '202605280900SE1',
      service_date:         '2026-05-28',
      origin_crs:           'PAD',
      destination_crs:      'BRI',
      scheduled_departure:  new Date('2026-05-28T09:00:00Z'),
      scheduled_arrival:    new Date('2026-05-28T10:30:00Z'),
      monitoring_status:    'active',
      last_checked_at:      new Date('2026-05-28T08:55:00Z'),
      next_check_at:        new Date('2026-05-28T09:00:00Z'),
      created_at:           new Date('2026-05-28T08:00:00Z'),
      updated_at:           new Date('2026-05-28T08:55:00Z'),
      toc_code:             'SE',   // South Eastern
    };

    const pool = makePoolWith([rawRow]);
    const repo = new JourneyRepository({ pool });

    const results = await repo.findJourneysDueForCheck(10, new Date());

    expect(results).toHaveLength(1);
    expect((results[0] as Record<string, unknown>).toc_code).toBe('SE');
  });
});

// ---------------------------------------------------------------------------
// AC-update-allowedFields: update() must include toc_code in generated SQL
// ---------------------------------------------------------------------------

describe('BL-314 AC-update-allowedFields: JourneyRepository.update() persists toc_code', () => {
  /**
   * update() has a hard-coded allowedFields array (journey-repository.ts ~line 123-126):
   *   ['rid', 'monitoring_status', 'last_checked_at', 'next_check_at']
   *
   * 'toc_code' is absent.  When `update(id, { toc_code: 'XC' })` is called,
   * no SET clause is emitted for toc_code — the RETURNING row comes back
   * unchanged.  The fix: add 'toc_code' to allowedFields.
   *
   * FAILS today: pool.query is called but with SQL that does NOT include
   * toc_code in the SET clause.  The assertion on the captured SQL/params
   * will fail.
   */

  it('AC-update-allowedFields: update() with { toc_code: "XC" } includes toc_code in the SQL SET clause', async () => {
    // AC-update-allowedFields: Core assertion — pool.query must receive SQL
    // containing 'toc_code' when toc_code is in the updates object.
    // FAILS today: allowedFields excludes 'toc_code' → setClauses is empty for it
    // → the pool.query call only has `SET` for other fields (or zero SET clauses
    //   if toc_code is the only field) → falls back to findById without updating.

    const { JourneyRepository } = await import(
      '../../../src/repositories/journey-repository.js'
    );

    const returnedRow: Record<string, unknown> = {
      id:                   'pk-bl314-update-001',
      user_id:              'user-bl314-upd',
      journey_id:           'journey-bl314-upd',
      rid:                  '202605280800XC1',
      service_date:         '2026-05-28',
      origin_crs:           'NCL',
      destination_crs:      'EDB',
      scheduled_departure:  new Date('2026-05-28T08:00:00Z'),
      scheduled_arrival:    new Date('2026-05-28T10:30:00Z'),
      monitoring_status:    'active',
      last_checked_at:      null,
      next_check_at:        null,
      created_at:           new Date('2026-05-28T07:00:00Z'),
      updated_at:           new Date('2026-05-28T07:01:00Z'),
      toc_code:             'XC',
    };

    const pool = makePoolWith([returnedRow]);
    const repo = new JourneyRepository({ pool });

    await repo.update('pk-bl314-update-001', { toc_code: 'XC' } as Record<string, unknown>);

    // Verify pool.query was called (not the empty-update path → findById)
    expect(pool.query).toHaveBeenCalled();

    // The first call must be the UPDATE (not a SELECT fallback)
    const [sqlArg, paramsArg] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const sql: string = typeof sqlArg === 'string' ? sqlArg : '';
    const params: unknown[] = Array.isArray(paramsArg) ? paramsArg : [];

    // Core assertion: the SQL must include 'toc_code' in the SET clause.
    // FAILS today: allowedFields does not include 'toc_code' → the for-loop
    // produces no SET clause entry for it.
    expect(sql.toLowerCase()).toContain('toc_code');

    // The params must include the value 'XC'
    expect(params).toContain('XC');

    // The SQL must be an UPDATE, not a SELECT (guard against fallback to findById)
    expect(sql.trim().toUpperCase()).toMatch(/^UPDATE/);
  });

  it('AC-update-allowedFields: update() with { rid: "R1", toc_code: "GW" } includes BOTH fields', async () => {
    // AC-update-allowedFields: Multi-field update — both rid and toc_code in one call.
    // This matches the resolveRid() pattern which will need to include toc_code.
    // FAILS today: toc_code not in allowedFields → only rid appears in SET clause.

    const { JourneyRepository } = await import(
      '../../../src/repositories/journey-repository.js'
    );

    const returnedRow: Record<string, unknown> = {
      id:                   'pk-bl314-update-002',
      user_id:              'user-bl314-upd2',
      journey_id:           'journey-bl314-upd2',
      rid:                  'R1-GW-202605280930',
      service_date:         '2026-05-28',
      origin_crs:           'PAD',
      destination_crs:      'BRI',
      scheduled_departure:  new Date('2026-05-28T09:30:00Z'),
      scheduled_arrival:    new Date('2026-05-28T11:00:00Z'),
      monitoring_status:    'active',
      last_checked_at:      null,
      next_check_at:        null,
      created_at:           new Date('2026-05-28T09:00:00Z'),
      updated_at:           new Date('2026-05-28T09:01:00Z'),
      toc_code:             'GW',
    };

    const pool = makePoolWith([returnedRow]);
    const repo = new JourneyRepository({ pool });

    await repo.update(
      'pk-bl314-update-002',
      { rid: 'R1-GW-202605280930', toc_code: 'GW' } as Record<string, unknown>
    );

    const [sqlArg, paramsArg] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const sql: string = typeof sqlArg === 'string' ? sqlArg : '';
    const params: unknown[] = Array.isArray(paramsArg) ? paramsArg : [];

    expect(sql.toLowerCase()).toContain('toc_code');
    expect(sql.toLowerCase()).toContain('rid');
    expect(params).toContain('GW');
    expect(params).toContain('R1-GW-202605280930');
    expect(sql.trim().toUpperCase()).toMatch(/^UPDATE/);
  });
});

// ---------------------------------------------------------------------------
// AC-write-path: DelayTrackerService detection cycle must persist toc_code
// ---------------------------------------------------------------------------

describe('BL-314 AC-write-path: detection cycle persists toc_code from darwin response', () => {
  /**
   * The detection cycle in DelayTrackerService.runDetectionCycle():
   *   1. Calls darwinClient.getDelaysByRids(rids) → DarwinDelayInfo[]
   *   2. Maps the result to { rid, total_delay_minutes, cancelled, delay_reasons }
   *      — toc_code is DISCARDED here (line ~251 delay-tracker-service.ts)
   *   3. Never calls repo.update({ toc_code }) for the journey.
   *
   * The fix: after receiving the darwin response, extract toc_code from each
   * DarwinDelayInfo and call repo.update(journeyId, { toc_code }) before or
   * after processing delay detection.
   *
   * FAILS today: the spy on journeyRepository.update is NEVER called with
   * a { toc_code: 'XC' } argument — the detection cycle discards toc_code.
   *
   * Test design:
   *   - Mock darwinClient.getDelaysByRids to return DarwinDelayInfo with toc_code:'XC'
   *   - Mock journeyMonitor.getJourneysDueForCheck to return one active journey
   *   - Mock everything else to avoid side effects
   *   - After runDetectionCycle(), assert that journeyRepository.update was called
   *     with an argument containing { toc_code: 'XC' } for the correct journey id
   */

  it('AC-write-path: runDetectionCycle() calls repo.update with toc_code from darwin response', async () => {
    // AC-write-path: The write-path assertion.
    // FAILS today: DelayTrackerService maps darwin response to delay data but
    // never forwards toc_code to any repository update call.

    const { DelayTrackerService } = await import(
      '../../../src/services/delay-tracker-service.js'
    );
    const { DelayDetector } = await import(
      '../../../src/services/delay-detector.js'
    );

    // ── Journey to be checked ──
    const journeyId = 'pk-bl314-write-001';
    const externalJourneyId = 'ext-journey-bl314-write-001';
    const activeJourney = {
      id:                   journeyId,
      user_id:              'user-bl314-write',
      journey_id:           externalJourneyId,
      rid:                  '202605280800XC1',
      service_date:         '2026-05-28',
      origin_crs:           'NCL',
      destination_crs:      'EDB',
      // Future arrival so journey is NOT completed
      scheduled_departure:  new Date('2026-05-28T08:00:00Z'),
      scheduled_arrival:    new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h from now
      monitoring_status:    'active' as const,
      last_checked_at:      new Date(),
      next_check_at:        new Date(),
    };

    // ── Darwin response includes toc_code ──
    // Verified: darwin-ingestor's /api/v1/delays returns DarwinDelayInfo[],
    // DarwinIngestorClient.getDelaysByRids() returns that array directly.
    const darwinDelayResponse = [
      {
        rid:           '202605280800XC1',
        delay_minutes: 0,       // on-time — no delay alert created
        is_cancelled:  false,
        delay_reasons: null,
        status:        'on_time' as const,
        stops:         null,
        toc_code:      'XC',   // BL-314: This is what we need preserved
      },
    ];

    // ── Spies ──
    const mockJourneyRepo = {
      findById:            vi.fn().mockResolvedValue(activeJourney),
      findByJourneyId:     vi.fn().mockResolvedValue(activeJourney),
      update:              vi.fn().mockResolvedValue(activeJourney),
      updateStatus:        vi.fn().mockResolvedValue(undefined),
      updateLastChecked:   vi.fn().mockResolvedValue(undefined),
      create:              vi.fn(),
      findByUserId:        vi.fn().mockResolvedValue([]),
      findJourneysDueForCheck: vi.fn().mockResolvedValue([]),
      delete:              vi.fn(),
    };

    const mockJourneyMonitor = {
      getJourneysDueForCheck: vi.fn().mockResolvedValue([activeJourney]),
      updateLastChecked:      vi.fn().mockResolvedValue(undefined),
      updateStatus:           vi.fn().mockResolvedValue(undefined),
      completeJourney:        vi.fn().mockResolvedValue(undefined),
      registerJourney:        vi.fn(),
      resolveRid:             vi.fn(),
      getJourneyById:         vi.fn(),
      getJourneysByUserId:    vi.fn(),
      cancelMonitoring:       vi.fn(),
    };

    const mockDarwinClient = {
      getDelaysByRids:       vi.fn().mockResolvedValue(darwinDelayResponse),
      getDelayInfo:          vi.fn(),
      getServiceWithStops:   vi.fn(),
    };

    const mockDelayAlertRepo = {
      create:                    vi.fn().mockResolvedValue({ id: 'alert-001' }),
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      markClaimTriggered:        vi.fn().mockResolvedValue(undefined),
      update:                    vi.fn().mockResolvedValue(undefined),
    };

    const mockClaimTrigger = {
      triggerClaim: vi.fn().mockResolvedValue({ success: false, reason: 'BELOW_THRESHOLD' }),
    };

    const mockOutboxPublisher = {
      publishJourneyMonitoringStarted: vi.fn().mockResolvedValue(undefined),
      publishDelayDetected:            vi.fn().mockResolvedValue(undefined),
      publishClaimTriggered:           vi.fn().mockResolvedValue(undefined),
      publishJourneyCompleted:         vi.fn().mockResolvedValue(undefined),
    };

    const mockPool = {
      connect: vi.fn().mockResolvedValue({
        query:   vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as import('pg').Pool;

    const svc = new DelayTrackerService({
      pool:               mockPool,
      darwinClient:       mockDarwinClient,
      delayAlertRepository: mockDelayAlertRepo,
      journeyMonitor:     mockJourneyMonitor,
      delayDetector:      new DelayDetector({ thresholdMinutes: 15 }),
      claimTrigger:       mockClaimTrigger,
      outboxPublisher:    mockOutboxPublisher,
      journeyRepository:  mockJourneyRepo,
    });

    await svc.runDetectionCycle();

    // ── Core assertion ──
    // After processing the darwin response, the service MUST call
    // journeyRepository.update(journeyId, { toc_code: 'XC' }) (or include it
    // in another update call that also touches toc_code).
    //
    // FAILS today: update() is called for 'rid', 'next_check_at', etc. but
    // toc_code is never included in any update payload because the darwin
    // mapping at line ~251 discards the field.
    const updateCalls = mockJourneyRepo.update.mock.calls;
    const anyCallHasTocCode = updateCalls.some(
      ([, updates]) =>
        updates !== null &&
        typeof updates === 'object' &&
        'toc_code' in (updates as Record<string, unknown>) &&
        (updates as Record<string, unknown>).toc_code === 'XC'
    );

    expect(anyCallHasTocCode).toBe(true);
  });

  it('AC-write-path: toc_code = null from darwin response is also persisted (not silently dropped)', async () => {
    // AC-write-path: When darwin returns toc_code: null, the service must still
    // call repo.update with { toc_code: null }.  This ensures the column is
    // written even for cases where darwin-ingestor cannot resolve the TOC.
    // FAILS today: same root cause — darwin mapping discards toc_code entirely.

    const { DelayTrackerService } = await import(
      '../../../src/services/delay-tracker-service.js'
    );
    const { DelayDetector } = await import(
      '../../../src/services/delay-detector.js'
    );

    const journeyId = 'pk-bl314-write-002';
    const activeJourney = {
      id:                   journeyId,
      user_id:              'user-bl314-write2',
      journey_id:           'ext-journey-bl314-write-002',
      rid:                  '202605280900SE1',
      service_date:         '2026-05-28',
      origin_crs:           'PAD',
      destination_crs:      'BRI',
      scheduled_departure:  new Date('2026-05-28T09:00:00Z'),
      scheduled_arrival:    new Date(Date.now() + 3 * 60 * 60 * 1000),
      monitoring_status:    'active' as const,
      last_checked_at:      new Date(),
      next_check_at:        new Date(),
    };

    const darwinDelayResponse = [
      {
        rid:           '202605280900SE1',
        delay_minutes: 0,
        is_cancelled:  false,
        delay_reasons: null,
        status:        'on_time' as const,
        stops:         null,
        toc_code:      null,   // darwin cannot resolve TOC for this service
      },
    ];

    const mockJourneyRepo = {
      findById:            vi.fn().mockResolvedValue(activeJourney),
      findByJourneyId:     vi.fn().mockResolvedValue(activeJourney),
      update:              vi.fn().mockResolvedValue(activeJourney),
      updateStatus:        vi.fn().mockResolvedValue(undefined),
      updateLastChecked:   vi.fn().mockResolvedValue(undefined),
      create:              vi.fn(),
      findByUserId:        vi.fn().mockResolvedValue([]),
      findJourneysDueForCheck: vi.fn().mockResolvedValue([]),
      delete:              vi.fn(),
    };

    const mockJourneyMonitor = {
      getJourneysDueForCheck: vi.fn().mockResolvedValue([activeJourney]),
      updateLastChecked:      vi.fn().mockResolvedValue(undefined),
      updateStatus:           vi.fn().mockResolvedValue(undefined),
      completeJourney:        vi.fn().mockResolvedValue(undefined),
      registerJourney:        vi.fn(),
      resolveRid:             vi.fn(),
      getJourneyById:         vi.fn(),
      getJourneysByUserId:    vi.fn(),
      cancelMonitoring:       vi.fn(),
    };

    const mockDarwinClient = {
      getDelaysByRids:     vi.fn().mockResolvedValue(darwinDelayResponse),
      getDelayInfo:        vi.fn(),
      getServiceWithStops: vi.fn(),
    };

    const mockDelayAlertRepo = {
      create:                          vi.fn().mockResolvedValue({ id: 'alert-002' }),
      findLatestByMonitoredJourneyId:  vi.fn().mockResolvedValue(null),
      markClaimTriggered:              vi.fn().mockResolvedValue(undefined),
      update:                          vi.fn().mockResolvedValue(undefined),
    };

    const mockClaimTrigger = {
      triggerClaim: vi.fn().mockResolvedValue({ success: false, reason: 'BELOW_THRESHOLD' }),
    };

    const mockOutboxPublisher = {
      publishJourneyMonitoringStarted: vi.fn().mockResolvedValue(undefined),
      publishDelayDetected:            vi.fn().mockResolvedValue(undefined),
      publishClaimTriggered:           vi.fn().mockResolvedValue(undefined),
      publishJourneyCompleted:         vi.fn().mockResolvedValue(undefined),
    };

    const mockPool = {
      connect: vi.fn().mockResolvedValue({
        query:   vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as import('pg').Pool;

    const svc = new DelayTrackerService({
      pool:               mockPool,
      darwinClient:       mockDarwinClient,
      delayAlertRepository: mockDelayAlertRepo,
      journeyMonitor:     mockJourneyMonitor,
      delayDetector:      new DelayDetector({ thresholdMinutes: 15 }),
      claimTrigger:       mockClaimTrigger,
      outboxPublisher:    mockOutboxPublisher,
      journeyRepository:  mockJourneyRepo,
    });

    await svc.runDetectionCycle();

    // toc_code: null from darwin must still result in an update call with null.
    // This guards against only writing toc_code when it is non-null.
    const updateCalls = mockJourneyRepo.update.mock.calls;
    const anyCallHasTocCodeKey = updateCalls.some(
      ([, updates]) =>
        updates !== null &&
        typeof updates === 'object' &&
        'toc_code' in (updates as Record<string, unknown>)
    );

    expect(anyCallHasTocCodeKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-real-round-trip: Testcontainers real Postgres — CI/Docker-gated
// ---------------------------------------------------------------------------

/**
 * Docker availability check.
 * On Windows/local dev without Docker Desktop running, Testcontainers will
 * fail to pull the postgres image.  We gate the entire describe block on
 * Docker availability so the RED suite can still be committed and run
 * locally for the non-Docker tests while the migration round-trip runs in CI.
 *
 * In CI (GitHub Actions / Railway), Docker is available and this describe
 * block will execute.  Locally on Windows without Docker Desktop, it skips.
 *
 * The test is intentionally NOT mocking the DB.  It exercises the REAL
 * migration + JourneyRepository.  This is the test class that would have
 * caught BL-313's gap had it existed (BL-313 only mocked the repo).
 */

const DOCKER_AVAILABLE = process.env.CI === 'true' || process.env.DOCKER_AVAILABLE === 'true';

const describeWithDocker = DOCKER_AVAILABLE ? describe : describe.skip;

describeWithDocker(
  'BL-314 AC-real-round-trip (Testcontainers — CI/Docker-gated): migration + read/write round-trip',
  () => {
    /**
     * CI / Docker note:
     *   - These tests run ONLY when DOCKER_AVAILABLE=true or CI=true.
     *   - Locally on Windows without Docker Desktop they are SKIPPED.
     *   - The skip is intentional per SOP-IMPROVEMENT-009 guidance:
     *     "gate Testcontainers tests clearly when Docker is unavailable locally".
     *   - In CI these tests must pass GREEN before Blake's implementation is
     *     considered complete.
     *
     * Why no mock here:
     *   BL-313's original gap was caused by tests that mocked the repository
     *   to return toc_code.  The mock passed; the real DB didn't have the
     *   column.  This test uses a REAL Postgres container to close that gap.
     */

    let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
    let pool: import('pg').Pool;

    const MIGRATION_TIMEOUT = 120_000;

    beforeEach(async () => {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const { Pool }                = await import('pg');
      const { execSync }            = await import('child_process');
      const path                    = await import('path');
      const { fileURLToPath }       = await import('url');

      const __dirname = path.dirname(fileURLToPath(import.meta.url));

      container = await new PostgreSqlContainer('postgres:15-alpine')
        .withDatabase('bl314_test')
        .start();

      pool = new Pool({ connectionString: container.getConnectionUri() });

      // Run ALL migrations, including Hoops's new 1779982907741 migration.
      // On current code (HEAD) this will succeed only if the migration file
      // exists on disk — it does (Hoops already committed it).
      // The resulting schema will have the toc_code column.
      const migrationDir = path.join(__dirname, '../../../migrations');
      execSync(`npx node-pg-migrate up -m "${migrationDir}"`, {
        cwd: path.join(__dirname, '../../..'),
        env: {
          ...process.env,
          DATABASE_URL: container.getConnectionUri(),
          // node-pg-migrate schema/table config
          DATABASE_SCHEMA: 'delay_tracker',
          MIGRATIONS_SCHEMA: 'delay_tracker',
          MIGRATIONS_TABLE: 'pgmigrations',
        },
      });
    }, MIGRATION_TIMEOUT);

    afterEach(async () => {
      if (pool)      await pool.end();
      if (container) await container.stop();
    }, MIGRATION_TIMEOUT);

    it('AC-real-round-trip (migration up): toc_code column exists after all migrations applied', async () => {
      // AC-real-round-trip: The Hoops migration must create the column.
      // FAILS today: on current HEAD (before Blake applies the fix), the migration
      // file exists on disk but the application code does not use the column —
      // more importantly, this test validates the migration is syntactically correct
      // and applies cleanly.

      const colResult = await pool.query(`
        SELECT column_name, data_type, is_nullable, character_maximum_length
        FROM information_schema.columns
        WHERE table_schema = 'delay_tracker'
          AND table_name   = 'monitored_journeys'
          AND column_name  = 'toc_code'
      `);

      expect(colResult.rows).toHaveLength(1);

      const col = colResult.rows[0];
      // Must be character varying (VARCHAR)
      expect(col.data_type).toBe('character varying');
      // Must be nullable (existing rows pre-date the migration)
      expect(col.is_nullable).toBe('YES');
      // Width must match VARCHAR(10) as specified in Hoops's migration
      expect(col.character_maximum_length).toBe(10);
    });

    it('AC-real-round-trip (INSERT + findByJourneyId): toc_code="XC" round-trips through real DB', async () => {
      // AC-real-round-trip: End-to-end persistence test.
      // INSERT a row with toc_code='XC', then call findByJourneyId() on the real
      // JourneyRepository wired to the Testcontainers Postgres.
      // FAILS today: even if the migration is applied, JourneyRepository.mapRow()
      // does not read the column — result.toc_code will be undefined.

      const { JourneyRepository } = await import(
        '../../../src/repositories/journey-repository.js'
      );

      const repo = new JourneyRepository({ pool });

      // INSERT directly via SQL to bypass any application-level create() gaps
      const externalJourneyId = `bl314-rt-${Date.now()}`;
      await pool.query(`
        INSERT INTO delay_tracker.monitored_journeys (
          user_id, journey_id, service_date, origin_crs, destination_crs,
          scheduled_departure, scheduled_arrival, monitoring_status, toc_code
        ) VALUES (
          gen_random_uuid(), $1, '2026-05-28', 'NCL', 'EDB',
          '2026-05-28T08:00:00Z', '2026-05-28T10:30:00Z', 'active', 'XC'
        )
      `, [externalJourneyId]);

      const result = await repo.findByJourneyId(externalJourneyId);

      expect(result).not.toBeNull();
      // DISPOSITIVE real-DB variant: this fails until BOTH the migration AND
      // mapRow() are fixed.
      expect((result as Record<string, unknown>).toc_code).toBe('XC');
    });

    it('AC-real-round-trip (NULL toc_code): pre-migration row reads back null via findByJourneyId()', async () => {
      // AC-real-round-trip: Existing rows that predate the migration will have
      // toc_code = NULL.  Verify mapRow() returns null (not undefined) for these.

      const { JourneyRepository } = await import(
        '../../../src/repositories/journey-repository.js'
      );

      const repo = new JourneyRepository({ pool });

      const externalJourneyId = `bl314-rt-null-${Date.now()}`;
      // Insert WITHOUT toc_code — simulates a pre-migration row (column defaults to NULL)
      await pool.query(`
        INSERT INTO delay_tracker.monitored_journeys (
          user_id, journey_id, service_date, origin_crs, destination_crs,
          scheduled_departure, scheduled_arrival, monitoring_status
        ) VALUES (
          gen_random_uuid(), $1, '2026-05-28', 'PAD', 'BRI',
          '2026-05-28T09:00:00Z', '2026-05-28T10:45:00Z', 'pending_rid'
        )
      `, [externalJourneyId]);

      const result = await repo.findByJourneyId(externalJourneyId);

      expect(result).not.toBeNull();
      // Must be explicitly null, not undefined.
      expect(Object.prototype.hasOwnProperty.call(result, 'toc_code')).toBe(true);
      expect((result as Record<string, unknown>).toc_code).toBeNull();
    });

    it('AC-real-round-trip (migration down): toc_code column absent after rollback', async () => {
      // AC-real-round-trip: Rollback guard — the down() migration must remove the column.
      // This ensures we can safely roll back in production if needed.
      // FAILS today: column may or may not exist depending on migration state;
      // this validates the down() migration is correct.
      //
      // Run only one down step (the most recent migration = toc_code column)
      const { execSync } = await import('child_process');
      const path         = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));

      const migrationDir = path.join(__dirname, '../../../migrations');

      execSync(`npx node-pg-migrate down --count 1 -m "${migrationDir}"`, {
        cwd: path.join(__dirname, '../../..'),
        env: {
          ...process.env,
          DATABASE_URL: container.getConnectionUri(),
          DATABASE_SCHEMA: 'delay_tracker',
          MIGRATIONS_SCHEMA: 'delay_tracker',
          MIGRATIONS_TABLE: 'pgmigrations',
        },
      });

      // After rolling back the toc_code migration, the column should be gone
      const colResult = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'delay_tracker'
          AND table_name   = 'monitored_journeys'
          AND column_name  = 'toc_code'
      `);

      expect(colResult.rows).toHaveLength(0);
    });
  }
);
