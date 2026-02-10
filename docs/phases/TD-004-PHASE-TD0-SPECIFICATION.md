# TD-DELAY-TRACKER-004: Phase TD-0 Specification

**Backlog Item**: BL-142
**Severity**: BLOCKING
**Service**: delay-tracker
**Domain**: Delay Detection & Monitoring
**Date**: 2026-02-10
**Author**: Quinn (Orchestrator)

---

## Business Context

The delay-tracker service processes `journey.confirmed` events from journey-matcher. For historic journeys (departure in the past), it performs an immediate Darwin delay lookup via `DarwinIngestorClient.getDelayInfo()` to determine if a train was delayed. If delay >= 15 minutes or the service was cancelled, it publishes a `delay.detected` event; otherwise `delay.not-detected` with reason `below_threshold`.

**The bug**: `getDelayInfo()` calls `GET /api/v1/delays/:rid` which does NOT exist in darwin-ingestor. The darwin-ingestor only exposes `POST /api/v1/delays` (batch endpoint). Every historic journey delay lookup returns a 404, which the handler catches and publishes as `delay.not-detected` reason `darwin_unavailable` -- even when the train WAS delayed.

**Impact**: The entire historic delay detection pipeline is broken. No historic journey will ever produce a `delay.detected` event, regardless of actual delay. This blocks the downstream eligibility and compensation flow.

## Evidence

E2E test 2026-02-10:
- RID `202602098022634` (PAD to CDF 15:48 GWR, 2026-02-09)
- `POST /api/v1/delays` with `{ rids: ["202602098022634"] }` returns: `{ services: [{ rid: "202602098022634", delay_minutes: 34, is_cancelled: false, delay_reasons: [{ code: "576" }] }] }`
- `GET /api/v1/delays/202602098022634` returns: `Cannot GET /api/v1/delays/202602098022634` (Express 404)
- delay-tracker publishes `delay.not-detected` reason `darwin_unavailable` instead of `delay.detected` with 34 minutes

## Acceptance Criteria

- **AC-1**: `DarwinIngestorClient.getDelayInfo()` uses `POST /api/v1/delays` with `{ rids: [rid] }` instead of `GET /api/v1/delays/:rid`
- **AC-2**: Response is extracted from the `services` array (first element) and mapped to `DarwinDelayInfo`
- **AC-3**: When darwin-ingestor returns an empty `services` array (RID not found / train on time), `getDelayInfo()` returns a zero-delay sentinel (`{ rid, delay_minutes: 0, is_cancelled: false, delay_reasons: null }`) so the handler publishes `delay.not-detected` with reason `below_threshold` (NOT `darwin_unavailable`)
- **AC-4**: When darwin-ingestor returns `delay_minutes >= 15`, the handler publishes `delay.detected` with correct delay data
- **AC-5**: When darwin-ingestor is unreachable (network error, timeout), `getDelayInfo()` throws and the handler publishes `delay.not-detected` with reason `darwin_unavailable`
- **AC-6**: Existing `getDelaysByRids()` batch method (used by cron path) is unaffected

## Source Code Analysis

### File 1: `src/clients/darwin-ingestor.ts`

**Current `getDelayInfo()` (lines 67-101)**:
- Calls `GET /api/v1/delays/${params.rid}?service_date=${params.service_date}` (line 73)
- Accepts `{ rid, service_date, origin_crs, destination_crs }` params
- Expects response to be a single `DarwinDelayInfo` object
- On 404: throws `"Darwin service not found: 404"`
- On timeout: throws `"Request timeout"`

**Required change**: Switch to `POST /api/v1/delays` with `{ rids: [rid] }`, extract first element from `services` array, return zero-delay sentinel for empty array.

**Existing `getDelaysByRids()` (lines 27-61)**:
- Already correctly calls `POST /api/v1/delays` with `{ rids }` body
- Returns `data.services || []`
- This method is the reference implementation for the correct API call pattern
- AC-6 requires this method remain untouched

### File 2: `src/kafka/journey-confirmed-handler.ts`

**Current `handleHistoricJourney()` (lines 146-176)**:
- Calls `this.darwinClient.getDelayInfo(...)` (line 152)
- If `delayMinutes >= 15 || isCancelled` -> `createDelayAlert()` -> publishes `delay.detected`
- Else -> `publishDelayNotDetected(payload, 'below_threshold')`
- Catch block (lines 171-175): catches ALL errors -> `publishDelayNotDetected(payload, 'darwin_unavailable')`

**Analysis**: The handler logic is already correct IF `getDelayInfo()` returns proper data. When `getDelayInfo()` returns the zero-delay sentinel for empty `services` array:
- `delay_minutes = 0`, `is_cancelled = false`
- `exceedsThreshold = false`
- Falls to else branch -> publishes `delay.not-detected` reason `below_threshold` (AC-3 satisfied)

When network errors occur, `getDelayInfo()` still throws -> catch block -> `darwin_unavailable` (AC-5 satisfied)

**Conclusion**: The handler MAY NOT need changes. The fix is isolated to `getDelayInfo()` in `darwin-ingestor.ts`.

### File 3: `src/types.ts`

**`DarwinDelayInfo` interface (lines 159-164)**:
```typescript
interface DarwinDelayInfo {
  rid: string;
  delay_minutes: number;
  is_cancelled: boolean;
  delay_reasons?: Record<string, unknown> | null;
}
```

**`DarwinDelaysApiResponse` interface (lines 166-168)**:
```typescript
interface DarwinDelaysApiResponse {
  services: DarwinDelayInfo[];
}
```

Both types already match the actual darwin-ingestor API response format. No changes needed.

## Existing Test Coverage

### `tests/unit/clients/darwin-ingestor.test.ts`
- Tests `getDelaysByRids()` extensively (AC-1.1 through AC-1.4)
- Does NOT test `getDelayInfo()` at all (this is the gap)
- Uses MSW (Mock Service Worker) for HTTP mocking
- Test base URL: `http://darwin-ingestor.test:3000`

### `tests/unit/TD-DELAY-TRACKER-002-journey-confirmed-handler.test.ts`
- Tests the full handler flow including historic/future routing
- Mocks `darwinClient.getDelayInfo` at the interface level
- Existing tests for `darwin_unavailable` (AC-7) assume `getDelayInfo()` throws on 404
- After the fix, 404 from darwin-ingestor will no longer occur (we use POST now), but network errors still throw

### `tests/fixtures/api/darwin-ingestor-responses.fixtures.ts`
- Uses outdated interface (`delays` array with `total_delay_minutes`, `cancelled` fields)
- Does NOT match current `DarwinDelayInfo` type (`delay_minutes`, `is_cancelled`)
- Jessie should update or create new fixtures for this TD item

## Implementation Plan

### Changes Required

**Primary file: `src/clients/darwin-ingestor.ts` -- `getDelayInfo()` method**

1. Change HTTP method from `GET` to `POST`
2. Change URL from `/api/v1/delays/${params.rid}?service_date=...` to `/api/v1/delays`
3. Add `Content-Type: application/json` header
4. Add body: `JSON.stringify({ rids: [params.rid] })`
5. Parse response as `{ services: DarwinDelayInfo[] }`
6. If `services` array is empty: return `{ rid: params.rid, delay_minutes: 0, is_cancelled: false, delay_reasons: null }`
7. If `services` array has elements: return `services[0]`
8. Remove the 404-specific error handling (line 86-88) since POST endpoint returns 200 with empty array for unknown RIDs

**The `service_date`, `origin_crs`, `destination_crs` params** are no longer needed by the darwin-ingestor POST endpoint (it takes only `rids`). However, keeping them in the method signature is harmless and avoids changing the caller. Blake should keep the signature stable.

### Files NOT Changed
- `src/kafka/journey-confirmed-handler.ts` -- handler logic already correct
- `src/types.ts` -- types already match the API contract
- `getDelaysByRids()` -- must remain untouched (AC-6)

## ADR Applicability

| ADR | Applies | Notes |
|-----|---------|-------|
| ADR-001 Schema-per-service | No | No schema changes |
| ADR-002 Winston Logger | Yes | Existing logging should be preserved |
| ADR-004 Vitest | Yes | All tests use Vitest |
| ADR-007 Transactional Outbox | Yes | Outbox events already in place |
| ADR-014 TDD | Yes | Jessie writes tests first |
| ADR-018 Migration Isolation | No | No migrations |

## Test Strategy

### Jessie (TD-1): New Tests Required

**1. Unit tests for `getDelayInfo()` (new test file or extend existing)**

Tests must use MSW to mock `POST /api/v1/delays`:

| Test | Mock Response | Expected Result |
|------|---------------|-----------------|
| AC-1: Uses POST endpoint | MSW handler for POST /api/v1/delays | Request is POST with `{ rids: [rid] }` body |
| AC-2: Maps response correctly | `{ services: [{ rid, delay_minutes: 34, is_cancelled: false, delay_reasons: [{code:"576"}] }] }` | Returns the DarwinDelayInfo object |
| AC-3: Empty services = zero delay | `{ services: [] }` | Returns `{ rid, delay_minutes: 0, is_cancelled: false, delay_reasons: null }` |
| AC-4: Threshold detection | `{ services: [{ rid, delay_minutes: 20, is_cancelled: false }] }` | Returns delay info (handler tests verify threshold) |
| AC-5: Network error throws | MSW `HttpResponse.error()` | Throws error |
| AC-5: Timeout throws | MSW delayed response + short timeout | Throws timeout error |
| AC-6: getDelaysByRids unaffected | Existing tests still pass | No regressions |

**2. Update existing handler tests (if needed)**

The existing `TD-DELAY-TRACKER-002-journey-confirmed-handler.test.ts` mocks `getDelayInfo` at the interface level. Those mocks already return `DarwinDelayInfo` objects, so they should continue to work. Jessie should verify this and add any AC-3-specific handler-level tests if the existing `below_threshold` tests don't cover the "empty darwin response" scenario adequately.

### Verification Method

- Unit tests: MSW mock of POST /api/v1/delays endpoint
- Handler tests: Existing mock-based tests verify event publishing
- E2E: Re-run `/e2e-whatsapp verify pipeline` after deployment to confirm real Darwin delay data flows through

## Definition of Done

- [ ] AC-1: `getDelayInfo()` uses POST /api/v1/delays with { rids: [rid] }
- [ ] AC-2: Response extracted from services array, mapped to DarwinDelayInfo
- [ ] AC-3: Empty services array returns zero-delay sentinel, handler publishes below_threshold
- [ ] AC-4: delay_minutes >= 15 correctly produces delay.detected event
- [ ] AC-5: Network/timeout errors produce darwin_unavailable
- [ ] AC-6: getDelaysByRids() batch method unchanged, existing tests pass
- [ ] All new tests passing (Vitest)
- [ ] Coverage >= 80% lines/functions/statements, >= 75% branches for changed files
- [ ] No regressions in existing test suite
- [ ] Deployed to Railway, health check passing
- [ ] E2E pipeline verification confirms delay.detected for known delayed train

## Workflow

```
Quinn (TD-0): This specification  [COMPLETE]
    |
Jessie (TD-1): Write failing tests for getDelayInfo() fix
    |
Blake (TD-2): Fix getDelayInfo() to use POST /api/v1/delays
    |
Jessie (TD-3): QA sign-off (coverage, no regressions)
    |
Moykle (TD-4): Deploy delay-tracker to Railway
    |
Quinn (TD-5): Close-out, update BL-142 to Done, create Changelog entry
```

No Hoops needed (no schema changes). Single-service fix.

## Risks

1. **Low risk**: The `service_date`, `origin_crs`, `destination_crs` params become unused by the HTTP call but remain in the method signature. This is acceptable to avoid changing the caller and is a trivial cleanup if desired later.
2. **Low risk**: The old test fixtures (`darwin-ingestor-responses.fixtures.ts`) use a different response format. Jessie should use the correct `DarwinDelayInfo` type for new fixtures, not the old format.
