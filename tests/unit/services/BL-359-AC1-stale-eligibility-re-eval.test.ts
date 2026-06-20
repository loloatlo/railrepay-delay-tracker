/**
 * BL-359 AC-1: delay-tracker — stale delay_alert must be UPDATED (not duplicated) on re-evaluation
 *
 * Story   : BL-359 — stale-display bugs (27-vs-0 contradictory result)
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-06-20
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * ─── THE BUG ──────────────────────────────────────────────────────────────────
 * DelayEvaluationService.evaluate() always calls delayAlertRepository.create()
 * when the SLW finds a delay. It never checks whether a delay_alert row ALREADY
 * EXISTS for the monitored_journey.
 *
 * Production scenario that causes the "27-vs-0" display bug:
 *   1. FIRST partial evaluate (leg-1 only path, BL-356 era): creates a
 *      monitored_journeys row (monitoring_status=completed) AND a delay_alert
 *      row with delay_minutes=0 (because the leg-1 SLW returned on_time /
 *      below-threshold 0-min delay for a partial evaluation).
 *
 *   2. BL-357 fix is NOT triggered because a delay_alert row DOES exist (the
 *      GET handler 404s only on completed+NO-ALERT). So the GET returns
 *      delay_minutes=0 from the stale 0-min alert.
 *
 *   3. BFF calls eligibility-engine with delay_minutes=0 trigger → EE creates
 *      eligibility row with reasons=[0 minutes does not qualify].
 *
 *   4. User re-runs the journey → ensure fires → SLW now finds 27 min (leg-3
 *      Darwin data now available). evaluate() CREATES A SECOND alert row with
 *      delay_minutes=27. BUT the old row with delay_minutes=0 also persists.
 *
 *   5. findLatestByMonitoredJourneyId uses ORDER BY delay_detected_at DESC.
 *      In production, both rows have delay_detected_at=NOW() from the same
 *      approximate time or the NEWER row is newer. So the GET returns 27 min.
 *
 *   6. BFF calls EE GET → EE serves the CACHED row from step 3 (delay_minutes=0
 *      reasons). BFF staples ensure's 27-min with EE's 0-min reasons.
 *      → contradictory payload: delay_minutes=27, reasons=[0 minutes].
 *
 * The delay_tracker's responsibility in fixing this:
 *   - evaluate() must check if a delay_alert ALREADY EXISTS for the
 *     monitored_journey (via findLatestByMonitoredJourneyId).
 *   - If YES: UPDATE the existing row's delay_minutes (not create a duplicate).
 *   - This ensures only ONE canonical alert per monitored_journey, which
 *     eliminates the nondeterministic ORDER BY DESC race condition.
 *   - When the alert is updated, the eligibility-engine will see the UPDATED
 *     delay_minutes on its next GET and re-evaluate with the correct value.
 *
 * NOTE on the original description: "persistCompletedRow idempotency guard
 * short-circuits before creating the alert" was a mis-characterisation.
 * persistCompletedRow RETURNS the existing row (with its id), and
 * terminalFromSlwResult then calls delayAlertRepository.create using that id.
 * The real problem is that create() duplicates the row rather than updating it.
 *
 * ─── WHAT BLAKE MUST DO ───────────────────────────────────────────────────────
 * In terminalFromSlwResult (the delayed branch, line ~276-289):
 *   1. After persistCompletedRow(), call delayAlertRepository.findLatestByMonitoredJourneyId(monitoredJourney.id)
 *   2. If an existing alert is found: call delayAlertRepository.update(existingAlert.id, { delay_minutes, threshold_exceeded: true, ... })
 *   3. If NO existing alert: call delayAlertRepository.create({ ... }) as before
 *
 * This upsert pattern eliminates duplicate alert rows and ensures the canonical
 * delay_minutes value is always the latest SLW result.
 *
 * ─── AC COVERAGE MAP ──────────────────────────────────────────────────────────
 * AC-1 (primary): when a delay_alert already EXISTS for the monitored_journey
 *   AND SLW now finds delay_minutes=27 → evaluate() UPDATES the existing alert
 *   (not creates a duplicate). update() called; create() NOT called.
 *
 * AC-4 (consistency): the UPDATED delay_alert has delay_minutes=27 (not stale 0).
 *
 * AC-5 no-regression a: when NO existing alert + SLW delayed → create() still
 *   called (normal first-run path unchanged).
 * AC-5 no-regression b: on_time path (delay_minutes < 15) → no alert created
 *   or updated (on_time does not touch delay_alerts).
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-021 — Fundamental Delay Equation (final-destination via SLW)
 *   ADR-031 — Synchronous ensure-on-404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelayEvaluationService } from '../../../src/services/delay-evaluation.service.js';
import type { EvaluationInput } from '../../../src/services/delay-evaluation.service.js';

// ─── UUID constants — unique per scenario (Guideline #6) ─────────────────────

// AC-1: journey that already has BOTH monitored_journeys row AND delay_alert (stale 0-min)
const BL359_JOURNEY_ID_STALE_ALERT    = 'bl359aa-0001-4000-8000-000000000001';
const BL359_MONITORED_ID_STALE        = 'bl359cc-0001-4000-8000-000000000001';
const BL359_STALE_ALERT_ID            = 'bl359dd-0001-4000-8000-000000000001';
const BL359_USER_ID                   = 'bl359uu-0001-4000-8000-000000000011';

// AC-4: consistency check (separate journey + alert)
const BL359_JOURNEY_ID_CONSISTENT     = 'bl359aa-0002-4000-8000-000000000002';
const BL359_MONITORED_ID_CONSISTENT   = 'bl359cc-0002-4000-8000-000000000002';
const BL359_CONSISTENT_ALERT_ID       = 'bl359dd-0002-4000-8000-000000000002';

// AC-5a: first-run (no pre-existing row, no pre-existing alert) — normal create path
const BL359_JOURNEY_ID_FIRSTRUN       = 'bl359aa-0004-4000-8000-000000000004';

// AC-5b: on-time (pre-existing row + new SLW = on_time) — no alert touched
const BL359_JOURNEY_ID_ONTIME         = 'bl359aa-0003-4000-8000-000000000003';
const BL359_MONITORED_ID_ONTIME       = 'bl359cc-0003-4000-8000-000000000003';

// ─── Shared evaluation input fixture (3-leg LDS→NQY journey) ─────────────────

function buildEvaluationInput(journeyId: string): EvaluationInput {
  return {
    journey_id: journeyId,
    user_id: BL359_USER_ID,
    origin_crs: 'LDS',
    destination_crs: 'NQY',
    departure_datetime: '2026-06-20T07:30:00.000Z',
    arrival_datetime: '2026-06-20T14:30:00.000Z',
    toc_code: 'GW',
    segments: [
      {
        segment_order: 1,
        origin_crs: 'LDS',
        destination_crs: 'EXD',
        scheduled_departure: '2026-06-20T07:30:00.000Z',
        scheduled_arrival: '2026-06-20T10:45:00.000Z',
        rid: '202606200730001',
        toc_code: 'GW',
      },
      {
        segment_order: 2,
        origin_crs: 'EXD',
        destination_crs: 'PLY',
        scheduled_departure: '2026-06-20T10:55:00.000Z',
        scheduled_arrival: '2026-06-20T11:55:00.000Z',
        rid: '202606201055002',
        toc_code: 'GW',
      },
      {
        segment_order: 3,
        origin_crs: 'PLY',
        destination_crs: 'NQY',
        scheduled_departure: '2026-06-20T12:05:00.000Z',
        scheduled_arrival: '2026-06-20T14:30:00.000Z',
        rid: '202606201205003',
        toc_code: 'GW',
      },
    ],
    correlation_id: 'bl359-ac1-correlation-id-0001',
  };
}

// ─── SLW result stubs ─────────────────────────────────────────────────────────

const SLW_RESULT_27_MIN_DELAYED = {
  status: 'completed' as const,
  delay_minutes: 27,
  actual_final_arrival: '2026-06-20T14:57:00.000Z',
  scheduled_final_arrival: '2026-06-20T14:30:00.000Z',
};

const SLW_RESULT_ON_TIME = {
  status: 'completed' as const,
  delay_minutes: 0,
  actual_final_arrival: '2026-06-20T14:28:00.000Z',
  scheduled_final_arrival: '2026-06-20T14:30:00.000Z',
};

// Stale 0-min delay alert row (this is what already exists in the DB)
function buildStaleAlert(monitoredId: string, alertId: string) {
  return {
    id: alertId,
    monitored_journey_id: monitoredId,
    delay_minutes: 0,         // stale: evaluated before Darwin alert arrived
    delay_detected_at: new Date('2026-06-20T09:00:00.000Z'),
    is_cancellation: false,
    threshold_exceeded: false,
  };
}

// ─── Mock dep builders ────────────────────────────────────────────────────────

interface BuildMockDepsOpts {
  journeyId: string;
  monitoredId: string;
  existingRow: boolean;         // true = monitored_journeys row pre-exists
  existingAlert?: {             // undefined = no alert; object = stale alert row
    id: string;
    monitored_journey_id: string;
    delay_minutes: number;
    delay_detected_at: Date;
    is_cancellation: boolean;
    threshold_exceeded: boolean;
  } | null;
  slwResult: typeof SLW_RESULT_27_MIN_DELAYED | typeof SLW_RESULT_ON_TIME;
}

function buildMockDeps(opts: BuildMockDepsOpts) {
  const mockJourneyRepo = {
    findByJourneyId: vi.fn().mockResolvedValue(
      opts.existingRow
        ? {
            id: opts.monitoredId,
            journey_id: opts.journeyId,
            user_id: BL359_USER_ID,
            monitoring_status: 'completed',
            toc_code: 'GW',
          }
        : null
    ),
    create: vi.fn().mockResolvedValue({
      id: opts.monitoredId,
      journey_id: opts.journeyId,
      user_id: BL359_USER_ID,
    }),
  };

  // Existing alert (stale) — returned by findLatestByMonitoredJourneyId
  const mockDelayAlertRepo = {
    findLatestByMonitoredJourneyId: vi.fn().mockResolvedValue(
      opts.existingAlert !== undefined ? opts.existingAlert : null
    ),
    create: vi.fn().mockResolvedValue({
      id: 'new-alert-001',
      monitored_journey_id: opts.monitoredId,
      delay_minutes: opts.slwResult.delay_minutes,
    }),
    update: vi.fn().mockResolvedValue({
      id: opts.existingAlert?.id ?? 'updated-alert-001',
      monitored_journey_id: opts.monitoredId,
      delay_minutes: opts.slwResult.delay_minutes,
    }),
  };

  const mockOutboxRepo = {
    create: vi.fn().mockResolvedValue({ id: 'outbox-001' }),
  };

  const mockDarwinClient = {
    getDelayInfo: vi.fn().mockResolvedValue({ delay_minutes: 0, is_cancelled: false }),
    getServiceWithStops: vi.fn().mockResolvedValue({}),
  };

  const mockSlw = {
    calculate: vi.fn().mockResolvedValue(opts.slwResult),
  };

  return { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-359 AC-1: DelayEvaluationService — delay_alert upsert on re-evaluation (not duplicate create)', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-1 (primary): stale 0-min alert EXISTS + SLW finds 27-min → UPDATE not CREATE ──

  describe('AC-1: when delay_alert row already exists (stale 0-min) + SLW finds 27-min → UPDATE existing alert', () => {

    it('should call delayAlertRepository.update() (not create) when stale alert row already exists', async () => {
      // THE BUG: evaluate() always calls delayAlertRepository.create() when the delayed
      // branch fires. It never checks findLatestByMonitoredJourneyId first.
      //
      // In production this creates a second row. Whether GET returns the stale or new
      // one depends on nondeterministic delay_detected_at ordering.
      //
      // WHAT BLAKE MUST DO: check findLatestByMonitoredJourneyId → if found, update().
      //
      // RED REASON: the current code never calls update(). It always calls create().

      const staleAlert = buildStaleAlert(BL359_MONITORED_ID_STALE, BL359_STALE_ALERT_ID);
      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_STALE_ALERT,
          monitoredId: BL359_MONITORED_ID_STALE,
          existingRow: true,
          existingAlert: staleAlert,   // stale 0-min alert already in DB
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      const result = await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_STALE_ALERT));

      // The outcome must be delayed
      expect(result.outcome).toBe('delayed');

      // UPSERT INVARIANT: when stale alert exists, update() must be called — NOT create()
      // RED: currently the code always calls create() and never calls update()
      expect(mockDelayAlertRepo.update).toHaveBeenCalledTimes(1);
      expect(mockDelayAlertRepo.create).not.toHaveBeenCalled();
    });

    it('should update the stale alert with delay_minutes=27 (not leave the stale 0-min row)', async () => {
      // AC-1 secondary assertion: the update() call must pass delay_minutes=27.
      // The stale row had delay_minutes=0 — that must be overwritten.

      const staleAlert = buildStaleAlert(BL359_MONITORED_ID_STALE, BL359_STALE_ALERT_ID);
      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_STALE_ALERT,
          monitoredId: BL359_MONITORED_ID_STALE,
          existingRow: true,
          existingAlert: staleAlert,
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_STALE_ALERT));

      // update() must receive the stale alert's id and delay_minutes=27
      // RED: currently update() is never called
      expect(mockDelayAlertRepo.update).toHaveBeenCalledTimes(1);
      const [updatedId, updatedFields] = mockDelayAlertRepo.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(updatedId).toBe(BL359_STALE_ALERT_ID);
      expect(updatedFields['delay_minutes']).toBe(27);
    });

    it('should call findLatestByMonitoredJourneyId before deciding to create or update', async () => {
      // The upsert check requires a findLatestByMonitoredJourneyId call.
      // Currently evaluate() never calls findLatestByMonitoredJourneyId.
      //
      // RED REASON: the current SLW path never calls findLatestByMonitoredJourneyId.

      const staleAlert = buildStaleAlert(BL359_MONITORED_ID_STALE, BL359_STALE_ALERT_ID);
      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_STALE_ALERT,
          monitoredId: BL359_MONITORED_ID_STALE,
          existingRow: true,
          existingAlert: staleAlert,
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_STALE_ALERT));

      // Must have checked for an existing alert before deciding create vs update
      // RED: currently not called in the SLW delayed branch
      expect(mockDelayAlertRepo.findLatestByMonitoredJourneyId).toHaveBeenCalledTimes(1);
      expect(mockDelayAlertRepo.findLatestByMonitoredJourneyId).toHaveBeenCalledWith(BL359_MONITORED_ID_STALE);
    });
  });

  // ── AC-4 consistency: updated alert has delay_minutes=27 (no stale row left) ──

  describe('AC-4: after update(), the canonical delay_alert has delay_minutes=27 (no stale 0-min)', () => {

    it('should pass threshold_exceeded=true on the update call when delay_minutes=27', async () => {
      // threshold_exceeded must be updated alongside delay_minutes so the EE gets
      // the correct threshold flag when it re-evaluates.

      const staleAlert = buildStaleAlert(BL359_MONITORED_ID_CONSISTENT, BL359_CONSISTENT_ALERT_ID);
      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_CONSISTENT,
          monitoredId: BL359_MONITORED_ID_CONSISTENT,
          existingRow: true,
          existingAlert: staleAlert,
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_CONSISTENT));

      expect(mockDelayAlertRepo.update).toHaveBeenCalledTimes(1);
      const [, updatedFields] = mockDelayAlertRepo.update.mock.calls[0] as [string, Record<string, unknown>];
      // AC-4 invariant: both fields updated correctly
      expect(updatedFields['delay_minutes']).toBe(27);
      expect(updatedFields['threshold_exceeded']).toBe(true);
    });

    it('should return outcome=delayed with delay_minutes=27 after updating stale alert', async () => {
      // The returned EvaluationOutcome must reflect the SLW result (27 min, delayed).

      const staleAlert = buildStaleAlert(BL359_MONITORED_ID_CONSISTENT, BL359_CONSISTENT_ALERT_ID);
      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_CONSISTENT,
          monitoredId: BL359_MONITORED_ID_CONSISTENT,
          existingRow: true,
          existingAlert: staleAlert,
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      const result = await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_CONSISTENT));

      expect(result.outcome).toBe('delayed');
      if (result.outcome === 'delayed') {
        expect(result.delay_minutes).toBe(27);
      }
    });
  });

  // ── AC-5a no-regression: NO existing alert → create() still fires (first-run path) ──

  describe('AC-5a no-regression: when NO existing delay_alert → create() still fires (first-run path unchanged)', () => {

    it('should call create() (not update) when findLatestByMonitoredJourneyId returns null', async () => {
      // When there is no stale alert (first-run path), the upsert must create, not update.
      // This ensures the AC-1 fix does not break the normal first-run path.

      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_FIRSTRUN,
          monitoredId: 'new-monitored-id-001',
          existingRow: false,      // no pre-existing monitored_journeys row
          existingAlert: null,     // no pre-existing alert
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      const result = await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_FIRSTRUN));

      expect(result.outcome).toBe('delayed');
      // First-run path: no existing alert → create() called, not update()
      expect(mockDelayAlertRepo.create).toHaveBeenCalledTimes(1);
      expect(mockDelayAlertRepo.update).not.toHaveBeenCalled();

      const alertArg = mockDelayAlertRepo.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(alertArg['delay_minutes']).toBe(27);
    });

    it('should also create when pre-existing monitored_journeys row exists but NO alert', async () => {
      // Edge case: monitored_journeys row exists (from a prior no-data / on_time evaluation)
      // but there's no delay_alert row. Must create (not update).

      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_FIRSTRUN,
          monitoredId: BL359_MONITORED_ID_STALE,
          existingRow: true,     // monitored_journeys row exists
          existingAlert: null,   // but no alert row
          slwResult: SLW_RESULT_27_MIN_DELAYED,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      const result = await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_FIRSTRUN));

      expect(result.outcome).toBe('delayed');
      // No existing alert → create (not update)
      expect(mockDelayAlertRepo.create).toHaveBeenCalledTimes(1);
      expect(mockDelayAlertRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── AC-5b no-regression: on_time path does NOT touch delay_alerts ────────────

  describe('AC-5b no-regression: on_time path (delay_minutes < 15) does NOT create or update alert', () => {

    it('should return on_time and NOT call create or update when SLW finds 0-min delay', async () => {
      // On-time journeys never touch delay_alerts. The upsert fix must not
      // accidentally call findLatestByMonitoredJourneyId on the on_time branch.

      const { mockJourneyRepo, mockDelayAlertRepo, mockOutboxRepo, mockDarwinClient, mockSlw } =
        buildMockDeps({
          journeyId: BL359_JOURNEY_ID_ONTIME,
          monitoredId: BL359_MONITORED_ID_ONTIME,
          existingRow: true,
          existingAlert: null,   // no alert — on_time journey
          slwResult: SLW_RESULT_ON_TIME,
        });

      const service = new DelayEvaluationService({
        journeyRepository: mockJourneyRepo,
        delayAlertRepository: mockDelayAlertRepo,
        outboxRepository: mockOutboxRepo,
        darwinClient: mockDarwinClient,
        sequentialLegWalk: mockSlw,
      });

      const result = await service.evaluate(buildEvaluationInput(BL359_JOURNEY_ID_ONTIME));

      expect(result.outcome).toBe('on_time');
      // On-time must not touch delay_alerts at all
      expect(mockDelayAlertRepo.create).not.toHaveBeenCalled();
      expect(mockDelayAlertRepo.update).not.toHaveBeenCalled();
    });
  });
});
