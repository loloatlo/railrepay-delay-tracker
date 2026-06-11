/**
 * BL-315 T2: publishDelayNotDetected must create a monitored_journeys row
 *
 * Bug (Blake T1 root cause, authoritative):
 *   On the historic path, when Darwin returns empty / below-threshold delay,
 *   publishDelayNotDetected() writes ONLY to delay_tracker.outbox (a delay.not-detected
 *   event) and NEVER creates a monitored_journeys row.
 *   Consequence: GET /delays/:journeyId calls findByJourneyId → returns null → 404 on
 *   every poll → BFF reports `pending` forever → PWA timeout banner.
 *
 * Fix 1 (what Blake must implement):
 *   publishDelayNotDetected() must ALSO call journeyRepository.create() with
 *   monitoring_status: 'completed' and the first-segment rid BEFORE (or during) writing
 *   the outbox event — mirroring the createDelayAlert() path (handler.ts ~lines 354-367).
 *   Once the row exists, GET /delays/:journeyId returns monitoring_status='completed'
 *   with no delay alert → status 'on_time' (not 404 → timeout).
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong Blake returns it to Jessie with explanation.
 *
 * Phase    : T2-test (Jessie — BL-315 re-reopen, timeout fix)
 * Story    : BL-315
 * Date     : 2026-06-11
 *
 * Framework: Vitest (ADR-004) — NEVER Jest.
 *
 * RED-first proof:
 *   FAILS TODAY: publishDelayNotDetected() never calls journeyRepository.create().
 *   Assertion 1 (dispositive) — journeyRepository.create was called with
 *     monitoring_status: 'completed' and the correct rid — FAILS (create not called at all).
 *   Assertion 2 (regression guard) — delay.not-detected outbox event still written — PASSES.
 *   Assertion 3 (terminal-response guard) — the create() arg carries enough for
 *     on_time response (monitoring_status 'completed', matching journey_id) — FAILS
 *     (same root: create never called).
 *
 * AC coverage map:
 *   Fix1-AC-1: publishDelayNotDetected() calls journeyRepository.create() with
 *              monitoring_status='completed' and the first-segment rid
 *              (not-detected / below_threshold path).
 *   Fix1-AC-2: delay.not-detected outbox event is still written (regression guard).
 *   Fix1-AC-3: The created row carries journey_id + monitoring_status:'completed',
 *              providing a terminal signal for GET /delays/:journeyId → on_time.
 *   Fix1-AC-4: darwin_unavailable path also creates a monitored_journeys row
 *              (same omission, same fix required).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JourneyConfirmedHandler } from '../../../src/kafka/journey-confirmed-handler.js';
import type { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import type { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';
import type { OutboxRepository } from '../../../src/repositories/outbox-repository.js';
import type { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';

// ---------------------------------------------------------------------------
// Replay-realistic data — York → KGX, 2026-06-03, anytime ticket, RID from
// confirmed T1 investigation. Departure is in the past so the historic path
// runs and getDelayInfo is called.
// ---------------------------------------------------------------------------

const JOURNEY_ID  = '84f8a97d-a396-47fc-a8f0-cadb19bb74e6';
const USER_ID     = 'b5c2d8e1-3f4a-47b6-9c0d-1e2f3a4b5c6d';
const CORR_ID     = 'c7d8e9f0-1a2b-3c4d-5e6f-7a8b9c0d1e2f';
const FIRST_RID   = '202606036701968'; // attested RID from T1 investigation
const SERVICE_DATE = '2026-06-03';

const PAST_DEPARTURE = '2026-06-03T08:30:00.000Z'; // in the past — triggers historic path
const PAST_ARRIVAL   = '2026-06-03T10:26:00.000Z';

/**
 * Builds a realistic York→KGX journey.confirmed payload.
 * departure_datetime is in the past so handleHistoricJourney() runs.
 */
function makeYrkKgxPayload(): import('../../../src/kafka/journey-confirmed-handler.js').JourneyConfirmedPayload {
  return {
    journey_id:          JOURNEY_ID,
    user_id:             USER_ID,
    origin_crs:          'YRK',
    destination_crs:     'KGX',
    departure_datetime:  PAST_DEPARTURE,
    arrival_datetime:    PAST_ARRIVAL,
    journey_type:        'single',
    toc_code:            'GR', // LNER
    segments: [
      {
        segment_order:       1,
        origin_crs:          'YRK',
        destination_crs:     'KGX',
        scheduled_departure: PAST_DEPARTURE,
        scheduled_arrival:   PAST_ARRIVAL,
        rid:                 FIRST_RID,
        toc_code:            'GR',
      },
    ],
    correlation_id:      CORR_ID,
    ticket_type:         'anytime',
    ticket_class:        'standard',
    ticket_fare_pence:   null,
  };
}

/**
 * Darwin response for no-delay / below-threshold scenario:
 * 0 minutes of delay — does NOT exceed the 15-minute threshold.
 */
const DARWIN_NO_DELAY = {
  delay_minutes: 0,
  is_cancelled:  false,
  delay_reasons: null,
};

/**
 * Darwin response for below-threshold scenario (5 minutes, within threshold):
 * Uses a different journey_id / RID so each test has uniquely differentiating data.
 */
const DARWIN_BELOW_THRESHOLD = {
  delay_minutes: 5,
  is_cancelled:  false,
  delay_reasons: null,
};

// ---------------------------------------------------------------------------
// Standard mock factory — matches the pattern from TD-TICKET-FARE-001 and
// BL-315 toc-code tests so Blake sees a consistent harness.
// ---------------------------------------------------------------------------

function makeHandlerDeps(darwinResponse: typeof DARWIN_NO_DELAY | typeof DARWIN_BELOW_THRESHOLD) {
  const mockJourneyRepo: Partial<JourneyRepository> & { create: ReturnType<typeof vi.fn>; findByJourneyId: ReturnType<typeof vi.fn> } = {
    create:          vi.fn().mockResolvedValue({
      id:                  'pk-bl315-t2-not-detected-001',
      user_id:             USER_ID,
      journey_id:          JOURNEY_ID,
      rid:                 FIRST_RID,
      service_date:        SERVICE_DATE,
      origin_crs:          'YRK',
      destination_crs:     'KGX',
      scheduled_departure: new Date(PAST_DEPARTURE),
      scheduled_arrival:   new Date(PAST_ARRIVAL),
      monitoring_status:   'completed',
      last_checked_at:     null,
      next_check_at:       null,
      created_at:          new Date('2026-06-03T10:30:00Z'),
      updated_at:          new Date('2026-06-03T10:30:00Z'),
      toc_code:            'GR',
    }),
    findByJourneyId: vi.fn().mockResolvedValue(null), // idempotency — no existing row
    findById:               vi.fn(),
    findByUserId:           vi.fn(),
    findJourneysDueForCheck: vi.fn(),
    update:                 vi.fn(),
    updateStatus:           vi.fn(),
    updateLastChecked:      vi.fn(),
    delete:                 vi.fn(),
  };

  const mockDelayAlertRepo: Partial<DelayAlertRepository> & { create: ReturnType<typeof vi.fn> } = {
    create:                          vi.fn().mockResolvedValue({ id: 'alert-bl315-t2' }),
    findLatestByMonitoredJourneyId:  vi.fn().mockResolvedValue(null),
    markClaimTriggered:              vi.fn(),
    update:                          vi.fn(),
  };

  const mockOutboxRepo: Partial<OutboxRepository> & { create: ReturnType<typeof vi.fn> } = {
    create: vi.fn().mockResolvedValue({ id: 'outbox-bl315-t2' }),
  };

  const mockDarwinClient: Partial<DarwinIngestorClient> & { getDelayInfo: ReturnType<typeof vi.fn>; getServiceWithStops: ReturnType<typeof vi.fn> } = {
    getDelayInfo:        vi.fn().mockResolvedValue(darwinResponse),
    getServiceWithStops: vi.fn(),
    getDelaysByRids:     vi.fn(),
  };

  const handler = new JourneyConfirmedHandler({
    journeyRepository:    mockJourneyRepo as unknown as JourneyRepository,
    delayAlertRepository: mockDelayAlertRepo as unknown as DelayAlertRepository,
    outboxRepository:     mockOutboxRepo as unknown as OutboxRepository,
    darwinClient:         mockDarwinClient as unknown as DarwinIngestorClient,
  });

  return { handler, mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient };
}

// ===========================================================================
// Fix1-AC-1 (DISPOSITIVE): publishDelayNotDetected creates monitored_journeys row
// ===========================================================================

describe('BL-315-T2 Fix1-AC-1 (DISPOSITIVE): publishDelayNotDetected must create monitored_journeys row', () => {
  /**
   * Fix 1 AC-1: When the historic path concludes that no qualifying delay was found
   * (delay_minutes=0 / below_threshold), publishDelayNotDetected() MUST call
   * journeyRepository.create() with monitoring_status: 'completed' and the first-segment rid
   * so that GET /delays/:journeyId returns a terminal on_time response instead of 404.
   *
   * FAILS TODAY (RED): publishDelayNotDetected() (handler.ts lines 408-423) writes ONLY to
   * the outbox. journeyRepository.create() is never called on this path.
   */

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Fix1-AC-1: delay_minutes=0 (no delay) → journeyRepository.create called with monitoring_status=completed', async () => {
    // Arrange: YRK→KGX historic journey, Darwin returns 0-minute delay (not-detected path)
    // Differentiating data: JOURNEY_ID='84f8a97d...', RID='202606036701968', delay_minutes=0
    const { handler, mockJourneyRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    // Act
    await handler.handle(payload);

    // Fix 1: journeyRepository.create MUST have been called
    // FAILS TODAY: create() is never called on the not-detected path
    expect(mockJourneyRepo.create).toHaveBeenCalled();

    // Fix1-AC-1 DISPOSITIVE: the argument to create() must include monitoring_status='completed'
    // FAILS TODAY: create() not called at all, so there is no argument to inspect
    const createArg = mockJourneyRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(createArg).toHaveProperty('monitoring_status', 'completed');
  });

  it('Fix1-AC-1: create() argument must carry the first-segment rid', async () => {
    // Differentiating data: same RID as T1 replay ('202606036701968'), delay_minutes=0
    const { handler, mockJourneyRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    await handler.handle(payload);

    // Fix1-AC-1: rid must be the first segment's rid, not 'UNKNOWN'
    // FAILS TODAY: create() not called at all
    expect(mockJourneyRepo.create).toHaveBeenCalled();
    const createArg = mockJourneyRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(createArg).toHaveProperty('rid', FIRST_RID);
  });

  it('Fix1-AC-1: create() argument must carry the correct journey_id', async () => {
    // Differentiating data: journey_id='84f8a97d...', delay_minutes=0
    const { handler, mockJourneyRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    await handler.handle(payload);

    // FAILS TODAY: create() not called at all
    expect(mockJourneyRepo.create).toHaveBeenCalled();
    const createArg = mockJourneyRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(createArg).toHaveProperty('journey_id', JOURNEY_ID);
  });

  it('Fix1-AC-1: below-threshold (5 min) → journeyRepository.create called with monitoring_status=completed', async () => {
    // Differentiating data: below-threshold variant (5-min delay, different from 0-min above)
    // Uses a distinct payload with a different journey_id to ensure test isolation.
    const { handler, mockJourneyRepo, mockOutboxRepo } = makeHandlerDeps(DARWIN_BELOW_THRESHOLD);
    const payload: import('../../../src/kafka/journey-confirmed-handler.js').JourneyConfirmedPayload = {
      ...makeYrkKgxPayload(),
      journey_id: 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7', // distinct journey_id
      segments: [
        {
          segment_order:       1,
          origin_crs:          'YRK',
          destination_crs:     'KGX',
          scheduled_departure: PAST_DEPARTURE,
          scheduled_arrival:   PAST_ARRIVAL,
          rid:                 '202606036701969', // distinct RID for this variant
          toc_code:            'GR',
        },
      ],
    };

    await handler.handle(payload);

    // Fix1-AC-1: FAILS TODAY — create() never called on below_threshold path
    expect(mockJourneyRepo.create).toHaveBeenCalled();
    const createArg = mockJourneyRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(createArg).toHaveProperty('monitoring_status', 'completed');

    // Also confirm delay.not-detected event was published (not delay.detected)
    const notDetectedCalls = (mockOutboxRepo.create.mock.calls as Array<[Record<string, unknown>]>)
      .filter(([arg]) => (arg as Record<string, unknown>).event_type === 'delay.not-detected');
    expect(notDetectedCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Fix1-AC-2 (REGRESSION GUARD): delay.not-detected outbox event still written
// ===========================================================================

describe('BL-315-T2 Fix1-AC-2 (REGRESSION GUARD): delay.not-detected outbox event still written after fix', () => {
  /**
   * Fix 1 AC-2: The existing behaviour — publishing delay.not-detected to the outbox —
   * MUST be preserved after Blake's fix. This test is expected to be GREEN on
   * current HEAD and must stay GREEN after the fix.
   *
   * The add-monitored-row change is ADDITIVE: publishDelayNotDetected() continues to
   * write to the outbox; it ALSO creates a monitored_journeys row.
   */

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Fix1-AC-2: delay.not-detected outbox event published (reason: below_threshold) when delay_minutes=0', async () => {
    // This test should be GREEN today (outbox write is not broken).
    // It must stay GREEN after Blake's fix — regression guard.
    const { handler, mockOutboxRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    await handler.handle(payload);

    const notDetectedCalls = (mockOutboxRepo.create.mock.calls as Array<[Record<string, unknown>]>)
      .filter(([arg]) => (arg as Record<string, unknown>).event_type === 'delay.not-detected');

    // delay.not-detected MUST have been published
    expect(notDetectedCalls.length).toBeGreaterThanOrEqual(1);

    // The payload must carry journey_id and reason
    const outboxPayload = notDetectedCalls[0][0].payload as Record<string, unknown>;
    expect(outboxPayload.journey_id).toBe(JOURNEY_ID);
    expect(['below_threshold', 'darwin_unavailable']).toContain(outboxPayload.reason);
  });

  it('Fix1-AC-2: delay.detected NOT published on not-detected path (no spurious alert)', async () => {
    // Confirm the fix does NOT accidentally publish delay.detected.
    // If delay.detected were published on the not-detected path it would trigger
    // a false compensation claim.
    const { handler, mockOutboxRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    await handler.handle(payload);

    const detectedCalls = (mockOutboxRepo.create.mock.calls as Array<[Record<string, unknown>]>)
      .filter(([arg]) => (arg as Record<string, unknown>).event_type === 'delay.detected');
    expect(detectedCalls.length).toBe(0);
  });
});

// ===========================================================================
// Fix1-AC-3: created row provides terminal signal for GET /delays/:journeyId
// ===========================================================================

describe('BL-315-T2 Fix1-AC-3: created row has monitoring_status=completed — query returns on_time not 404', () => {
  /**
   * Fix 1 AC-3: The monitored_journeys row created by publishDelayNotDetected()
   * MUST have monitoring_status='completed' so that GET /delays/:journeyId
   * maps it to status:'on_time' rather than 'pending'.
   *
   * Context: delay-query.handler.ts (lines 250-287) maps:
   *   monitoring_status='completed' + no delay_alert → status:'on_time'   ✓ terminal
   *   monitoring_status='active'    + no delay_alert → status:'pending'   ✗ loops
   *
   * This test operates at the handler unit level; the end-to-end "query returns
   * on_time not 404" path is covered by the real-browser replay gate (Moykle T3).
   *
   * FAILS TODAY (RED): create() is never called, so there is no monitoring_status to inspect.
   */

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Fix1-AC-3: journeyRepository.create arg has monitoring_status=completed (not active or pending)', async () => {
    // Differentiating data: journey_id = JOURNEY_ID, RID = FIRST_RID, delay_minutes = 0
    const { handler, mockJourneyRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    await handler.handle(payload);

    // FAILS TODAY: create() not called on not-detected path
    expect(mockJourneyRepo.create).toHaveBeenCalled();
    const createArg = mockJourneyRepo.create.mock.calls[0][0] as Record<string, unknown>;

    // 'completed' causes the query handler to return on_time (AC-3 in delay-query tests).
    // If 'active' were used the query would return 'pending' and the PWA would still time out.
    expect(createArg.monitoring_status).toBe('completed');
    expect(createArg.monitoring_status).not.toBe('active');
    expect(createArg.monitoring_status).not.toBe('pending_rid');
    expect(createArg.monitoring_status).not.toBe('darwin_unavailable');
  });

  it('Fix1-AC-3: no delay_alert created on not-detected path (so query returns on_time not delayed)', async () => {
    // Confirm delayAlertRepository.create is NOT called on the not-detected path.
    // If a delay_alert were inadvertently created it would cause the query to return
    // status:'delayed' instead of 'on_time', triggering a false compensation.
    const { handler, mockDelayAlertRepo } = makeHandlerDeps(DARWIN_NO_DELAY);
    const payload = makeYrkKgxPayload();

    await handler.handle(payload);

    expect(mockDelayAlertRepo.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Fix1-AC-4: darwin_unavailable path ALSO requires a monitored_journeys row
// ===========================================================================

describe('BL-315-T2 Fix1-AC-4: darwin_unavailable path also creates monitored_journeys row', () => {
  /**
   * Fix 1 AC-4: When Darwin is unreachable (getDelayInfo throws), the handler calls
   * publishDelayNotDetected(payload, 'darwin_unavailable'). This path has the same
   * omission: no monitored_journeys row is created, so the query endpoint 404s.
   *
   * The fix to publishDelayNotDetected() covers BOTH 'below_threshold' and
   * 'darwin_unavailable' since they share the same code path.
   *
   * FAILS TODAY (RED): publishDelayNotDetected() never calls journeyRepository.create(),
   * regardless of the reason parameter.
   */

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Fix1-AC-4: Darwin error (getDelayInfo throws) → journeyRepository.create called with monitoring_status=completed', async () => {
    // Differentiating data: Darwin throws → darwin_unavailable reason, distinct journey_id
    const mockJourneyRepo: Partial<JourneyRepository> & { create: ReturnType<typeof vi.fn>; findByJourneyId: ReturnType<typeof vi.fn> } = {
      create:          vi.fn().mockResolvedValue({
        id: 'pk-darwin-unavail-001',
        journey_id: 'f0e1d2c3-b4a5-4967-8901-2b3c4d5e6f70',
        monitoring_status: 'completed',
        toc_code: 'GR',
      }),
      findByJourneyId: vi.fn().mockResolvedValue(null),
      findById:               vi.fn(),
      findByUserId:           vi.fn(),
      findJourneysDueForCheck: vi.fn(),
      update:                 vi.fn(),
      updateStatus:           vi.fn(),
      updateLastChecked:      vi.fn(),
      delete:                 vi.fn(),
    };

    const mockOutboxRepo: Partial<OutboxRepository> & { create: ReturnType<typeof vi.fn> } = {
      create: vi.fn().mockResolvedValue({ id: 'outbox-darwin-unavail' }),
    };

    // Darwin throws → darwin_unavailable path
    const mockDarwinClient: Partial<DarwinIngestorClient> & { getDelayInfo: ReturnType<typeof vi.fn>; getServiceWithStops: ReturnType<typeof vi.fn> } = {
      getDelayInfo:        vi.fn().mockRejectedValue(new Error('Darwin API unavailable')),
      getServiceWithStops: vi.fn(),
      getDelaysByRids:     vi.fn(),
    };

    const mockDelayAlertRepo: Partial<DelayAlertRepository> & { create: ReturnType<typeof vi.fn> } = {
      create:                         vi.fn().mockResolvedValue({ id: 'alert-darwin-unavail' }),
      findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(null),
      markClaimTriggered:             vi.fn(),
      update:                         vi.fn(),
    };

    const handler = new JourneyConfirmedHandler({
      journeyRepository:    mockJourneyRepo as unknown as JourneyRepository,
      delayAlertRepository: mockDelayAlertRepo as unknown as DelayAlertRepository,
      outboxRepository:     mockOutboxRepo as unknown as OutboxRepository,
      darwinClient:         mockDarwinClient as unknown as DarwinIngestorClient,
    });

    // Distinct journey_id and RID to differentiate from the other tests
    const payload: import('../../../src/kafka/journey-confirmed-handler.js').JourneyConfirmedPayload = {
      journey_id:          'f0e1d2c3-b4a5-4967-8901-2b3c4d5e6f70',
      user_id:             'e9d8c7b6-a5f4-4321-b0c1-d2e3f4a5b6c7',
      origin_crs:          'YRK',
      destination_crs:     'KGX',
      departure_datetime:  PAST_DEPARTURE,
      arrival_datetime:    PAST_ARRIVAL,
      journey_type:        'single',
      toc_code:            'GR',
      segments: [
        {
          segment_order:       1,
          origin_crs:          'YRK',
          destination_crs:     'KGX',
          scheduled_departure: PAST_DEPARTURE,
          scheduled_arrival:   PAST_ARRIVAL,
          rid:                 '202606036701970', // distinct from FIRST_RID
          toc_code:            'GR',
        },
      ],
      correlation_id: 'd1c2b3a4-e5f6-7890-a1b2-c3d4e5f6a7b8',
      ticket_type:    'anytime',
    };

    await handler.handle(payload);

    // Fix1-AC-4 DISPOSITIVE: FAILS TODAY — create() not called on darwin_unavailable path
    expect(mockJourneyRepo.create).toHaveBeenCalled();
    const createArg = mockJourneyRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(createArg).toHaveProperty('monitoring_status', 'completed');

    // delay.not-detected with reason='darwin_unavailable' must still be published
    const notDetectedCalls = (mockOutboxRepo.create.mock.calls as Array<[Record<string, unknown>]>)
      .filter(([arg]) => (arg as Record<string, unknown>).event_type === 'delay.not-detected');
    expect(notDetectedCalls.length).toBeGreaterThanOrEqual(1);
    const outboxPayload = notDetectedCalls[0][0].payload as Record<string, unknown>;
    expect(outboxPayload.reason).toBe('darwin_unavailable');
  });
});
