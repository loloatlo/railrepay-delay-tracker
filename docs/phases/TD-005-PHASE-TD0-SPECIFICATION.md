# TD-DELAY-TRACKER-005: Phase TD-0 Specification

**Backlog Item**: BL (Notion page `303815ba-72ee-81ec-8fc3-fe5f4fe27684`)
**Severity**: BLOCKING
**Service**: delay-tracker
**Domain**: Delay Detection & Monitoring
**Date**: 2026-02-10
**Author**: Quinn (Orchestrator)

---

## Business Context

The delay-tracker service processes `journey.confirmed` events from journey-matcher. For historic journeys (departure in the past), it performs an immediate Darwin delay lookup via `DarwinIngestorClient.getDelayInfo()`. When delay >= 15 minutes or the service was cancelled, it calls `createDelayAlert()` to persist a `delay_alerts` row and publish a `delay.detected` outbox event.

**The bug**: `createDelayAlert()` generates a random UUID via `uuidv4()` for `monitored_journey_id` (line 238 of `journey-confirmed-handler.ts`). The `delay_alerts` table has a foreign key constraint `delay_alerts_monitored_journey_id_fkey` that requires `monitored_journey_id` to reference a valid row in `delay_tracker.monitored_journeys`. Since no `monitored_journeys` row is created for historic journeys on the delay path, the INSERT always fails with:

```
insert or update on table "delay_alerts" violates foreign key constraint "delay_alerts_monitored_journey_id_fkey"
```

**Secondary bug**: The error is caught by the overly broad catch block in `handleHistoricJourney()` (lines 171-181) and mislabeled as `darwin_unavailable`. This masks database errors as Darwin API failures, making diagnosis difficult.

**Impact**: Every historic journey with a qualifying delay (>= 15 min or cancelled) fails to persist as an alert and fails to publish `delay.detected`. The downstream eligibility and compensation flow is completely broken for historic delays.

## Production Evidence

E2E diagnostic 2026-02-10:
- RID `202602098022634` (PAD to CDF 15:48 GWR, 2026-02-09)
- Darwin API call SUCCEEDS: returns `{ delay_minutes: 34, is_cancelled: false }`
- Delay exceeds 15-minute threshold, `createDelayAlert()` is called
- `createDelayAlert()` generates UUID `tempJourneyId` via `uuidv4()`
- INSERT into `delay_tracker.delay_alerts` FAILS: FK constraint violation
- Error caught by broad catch block -> publishes `delay.not-detected` with reason `darwin_unavailable` (MISLEADING)
- Real error: database constraint, NOT Darwin unavailability

## Acceptance Criteria

- **AC-1**: Historic journeys with delay >= 15 min create a `monitored_journeys` row with `monitoring_status: 'completed'` BEFORE creating the delay alert
- **AC-2**: The `delay_alerts` row references the real `monitored_journeys.id` (not a random UUID)
- **AC-3**: `delay.detected` outbox event is published with correct `delay_minutes` and journey data
- **AC-4**: Error handling distinguishes Darwin API errors from database/other errors (don't label FK violations as `darwin_unavailable`)
- **AC-5**: Historic journeys with delay < 15 min still publish `delay.not-detected` with reason `below_threshold` (no regression)
- **AC-6**: Darwin API failure still publishes `delay.not-detected` with reason `darwin_unavailable` (no regression)
- **AC-7**: Idempotency preserved -- duplicate `journey.confirmed` events don't create duplicate rows

## Source Code Analysis

### File 1: `src/kafka/journey-confirmed-handler.ts`

**Current `handleHistoricJourney()` (lines 146-181)**:
- Calls `this.darwinClient.getDelayInfo(...)` (line 152)
- If `delayMinutes >= 15 || isCancelled` -> calls `createDelayAlert()` (line 166)
- If `delayMinutes < 15` -> calls `publishDelayNotDetected(payload, 'below_threshold')` (line 169)
- **Catch block (lines 171-181)**: Catches ALL errors and publishes `delay.not-detected` with reason `darwin_unavailable`. This is the secondary bug -- database errors are mislabeled.

**Current `createDelayAlert()` (lines 232-264)**:
- Line 238: `const tempJourneyId = uuidv4();` -- THIS IS THE PRIMARY BUG
- Line 241-249: `delayAlertRepository.create()` with `monitored_journey_id: tempJourneyId`
- Line 252-263: `outboxRepository.create()` with `delay.detected` event
- The outbox event creation never executes because the alert INSERT fails first

**Required changes to `handleHistoricJourney()`**:
1. Restructure catch block to distinguish Darwin API errors from database errors
2. Only label errors as `darwin_unavailable` when they originate from the Darwin client call
3. Re-throw or handle database errors differently (log as error, do not mask as Darwin)

**Required changes to `createDelayAlert()`**:
1. Accept the full `payload` data needed to create a `monitored_journeys` row
2. Call `journeyRepository.create()` with `monitoring_status: 'completed'` BEFORE `delayAlertRepository.create()`
3. Use the returned `monitored_journeys.id` as the `monitored_journey_id` for the delay alert
4. Remove the `uuidv4()` call for `tempJourneyId`

### File 2: `src/repositories/journey-repository.ts`

**`create()` method (lines 27-55)**:
- Already accepts all required fields including `monitoring_status`
- Returns the created row with `id` populated
- No changes needed to this repository

### File 3: `src/repositories/delay-alert-repository.ts`

**`create()` method (lines 27-62)**:
- Accepts `monitored_journey_id` as part of the alert object
- No changes needed to this repository -- just needs a valid FK reference

### File 4: `src/types.ts`

**`MonitoringStatus` type (line 10)**:
- Already includes `'completed'` as a valid status
- No type changes needed

## Data Layer Impact

**No schema changes needed.** The `monitored_journeys` and `delay_alerts` tables already have the correct structure. The fix is purely in the handler logic: create a `monitored_journeys` row before creating a `delay_alerts` row.

**Hoops (TD-0.5) is NOT needed.** No migration work required.

## Existing Test Context

The existing test file `tests/unit/TD-DELAY-TRACKER-002-journey-confirmed-handler.test.ts` covers the journey-confirmed-handler. Notably:

- **AC-3 test (line 256)**: `expect(mockJourneyRepository.create).not.toHaveBeenCalled()` -- This test asserts that historic journeys do NOT create a `monitored_journeys` row. This was correct behavior BEFORE this fix. **This test must be updated by Jessie** because the fix specifically requires creating a `monitored_journeys` row for historic delayed journeys.
- **AC-5 test (lines 329-347)**: Tests `delay_alerts` creation with `monitored_journey_id: expect.any(String)` -- This test passes with the random UUID in mock mode but fails in production with real FK constraints. Jessie needs to add an assertion that the `monitored_journey_id` is the ID returned from `journeyRepository.create()`.

### Test Lock Rule Consideration

The existing TD-002 test file was written by Jessie. Since this TD-005 fix changes the expected behavior (historic delayed journeys now DO create `monitored_journeys` rows), Jessie will need to write new tests in a new test file AND potentially update the existing TD-002 tests for the changed assertion on line 256. Since Jessie owns both the original tests and the new tests, this does not violate the Test Lock Rule.

## Implementation Guidance for Blake (TD-2)

### Change 1: `createDelayAlert()` -- Create monitored_journeys row first

Replace the `uuidv4()` approach with:
1. Call `this.journeyRepository.create()` with journey data and `monitoring_status: 'completed'`
2. Use the returned row's `id` as `monitored_journey_id` for the delay alert

The `createDelayAlert()` method signature will need the full payload to extract journey data for the `monitored_journeys` row.

### Change 2: `handleHistoricJourney()` -- Narrow the catch block

The current catch block catches everything and labels it `darwin_unavailable`. Restructure to:
1. Wrap only the Darwin API call in try/catch for Darwin-specific errors
2. Handle database errors separately (let them propagate or log at error level with accurate reason)
3. The `darwin_unavailable` reason should only be used when the Darwin API call itself fails

### Change 3: Idempotency

The existing idempotency check (`findByJourneyId` at line 73) runs before routing, so it will catch duplicate `journey.confirmed` events for historic journeys that already have a `monitored_journeys` row. This should work correctly with the fix. Blake should verify.

## Definition of Done

### TDD
- [ ] Jessie writes failing tests (TD-1) covering all 7 ACs
- [ ] Blake implements fix (TD-2) making all tests GREEN
- [ ] All existing tests continue to pass (no regressions)

### Code Quality
- [ ] No `any` types introduced
- [ ] No `uuidv4()` for FK references
- [ ] Error handling is specific (not overly broad)

### Observability
- [ ] Database errors logged at appropriate severity (not masked as Darwin errors)
- [ ] Correlation IDs propagated in all outbox events

### Test Coverage
- [ ] >= 80% lines/functions/statements, >= 75% branches on affected files

## Workflow Sequence

```
Quinn (TD-0: This specification)           -- COMPLETE
  |
  v
Jessie (TD-1: Write failing tests)        -- NEXT
  |
  v
Blake (TD-2: Implement fix)
  |
  v
Jessie (TD-3: QA sign-off)
  |
  v
Moykle (TD-4: Deploy)
  |
  v
Quinn (TD-5: Verify and close)
```
