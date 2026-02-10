# TD-DELAY-TRACKER-004: Phase TD-1 Test Specification

**Backlog Item**: BL-142
**Phase Owner**: Jessie (QA/TDD Enforcer)
**Date**: 2026-02-10
**Status**: COMPLETE - Tests Written (RED phase)

---

## Test File Created

**Location**: `tests/unit/TD-DELAY-TRACKER-004-darwin-client-getDelayInfo.test.ts`

This file contains **24 tests** (21 failing, 3 passing) that specify the required behavior for the `getDelayInfo()` fix.

---

## Test Coverage by Acceptance Criteria

### AC-1: Uses POST /api/v1/delays with { rids: [rid] }

**4 tests** verify the HTTP request structure:

1. `should use POST method (not GET)` - Captures request method, expects 'POST'
2. `should send Content-Type: application/json header` - Verifies JSON header
3. `should send { rids: [rid] } in request body` - Validates request body format
4. `should call /api/v1/delays endpoint (not /api/v1/delays/:rid)` - Confirms URL path has no RID

**Current failure**: All tests intercept `GET /api/v1/delays/:rid` (proves bug exists)

---

### AC-2: Response extracted from services[0], mapped to DarwinDelayInfo

**4 tests** verify response extraction:

1. `should return DarwinDelayInfo object from services[0]` - Maps delayed service
2. `should return correct structure for cancelled service` - Handles `is_cancelled: true`
3. `should preserve delay_reasons structure` - Preserves complex delay_reasons
4. `should handle null delay_reasons` - Handles `delay_reasons: null`

**Current failure**: Tests expect POST response format, code uses GET (non-existent endpoint)

---

### AC-3: Empty services array → zero-delay sentinel (NOT throw)

**3 tests** verify the critical zero-delay sentinel behavior:

1. `should return zero-delay sentinel when services array is empty (was: throwing 404)` - Returns `{ rid, delay_minutes: 0, is_cancelled: false, delay_reasons: null }`
2. `should NOT throw when services array is empty` - Verifies no exception thrown
3. `should return zero-delay sentinel for train on time (empty darwin response)` - Tests real-world scenario

**Why critical**: Current code throws 404, causing handler to publish `darwin_unavailable` even when train was on time. Sentinel allows `below_threshold` instead.

**Current failure**: Code throws, tests expect sentinel return value

---

### AC-4: delay_minutes >= 15 returns correct DarwinDelayInfo

**3 tests** verify threshold-relevant delay data:

1. `should return delay data when delay_minutes = 15 (threshold)` - Boundary case
2. `should return delay data when delay_minutes = 20 (above threshold)` - Above threshold
3. `should return delay data when delay_minutes = 34 (significant delay)` - Real E2E RID

**Current failure**: Tests expect POST response format

---

### AC-5: Network error/timeout throws error

**4 tests** verify error handling:

1. `should throw on network error` - MSW `HttpResponse.error()`
2. `should throw "timeout" error on AbortError` - 1ms timeout + 100ms delay
3. `should throw on 500 Internal Server Error` - HTTP 500 response
4. `should throw on 503 Service Unavailable` - HTTP 503 response

**Expected behavior**: Throw error (caught by handler as `darwin_unavailable`)

**Current failure**: Tests use server.use() overrides but code calls wrong endpoint

---

### AC-6: Existing getDelaysByRids() unaffected

**3 tests** verify no regression in batch method:

1. `should still return array of delay data from getDelaysByRids()` - Multi-RID query
2. `should return empty array for empty RIDs input (getDelaysByRids)` - Empty input
3. `should return empty array when no matching RIDs found (getDelaysByRids)` - Not found

**Current status**: ✅ **ALL 3 TESTS PASS** - Proves `getDelaysByRids()` uses correct POST endpoint

---

### Additional Edge Cases

**3 tests** for edge case handling:

1. `should handle response with multiple services (extract first)` - Array with 2+ elements
2. `should preserve RID in zero-delay sentinel` - Sentinel includes input RID
3. `should handle delay_minutes = 0 with is_cancelled = true (cancellation)` - Cancellation scenario

**Current failure**: Tests expect POST behavior

---

## Test Execution Results

### Current Implementation (RED Phase)

```
❯ npx vitest run tests/unit/TD-DELAY-TRACKER-004-darwin-client-getDelayInfo.test.ts

 ❯ 21 tests FAILED
   - MSW intercepted GET /api/v1/delays/:rid (proves bug: uses wrong method)
   - MSW "unhandled request" errors (endpoint doesn't exist)

 ✓ 3 tests PASSED (AC-6: getDelaysByRids() unaffected)

 Test Files  1 failed (1)
      Tests  21 failed | 3 passed (24)
```

**Evidence of bug**: MSW logs show `GET http://darwin-ingestor.test:3000/api/v1/delays/202602098022634?service_date=2026-02-09`

### Existing Handler Tests

```
❯ npx vitest run tests/unit/TD-DELAY-TRACKER-002-journey-confirmed-handler.test.ts

 ✓ tests/unit/TD-DELAY-TRACKER-002-journey-confirmed-handler.test.ts  (33 tests) 20ms

 Test Files  1 passed (1)
      Tests  33 passed (33)
```

**Status**: ✅ No regressions - handler tests still pass (they mock `getDelayInfo` at interface level)

---

## Test Fixtures Used

All fixtures use **real Darwin API response format** (verified 2026-02-10):

| Fixture | Source | RID | Description |
|---------|--------|-----|-------------|
| `delayedServiceResponse` | E2E test 2026-02-10 | 202602098022634 | PAD to CDF, 34 min delay |
| `emptyServicesResponse` | Darwin API contract | N/A | `{ services: [] }` |
| `cancelledServiceResponse` | Real patterns | 202601121600234 | Cancelled service |
| `thresholdExceededResponse` | Real patterns | 202601150800123 | 20 min delay |
| `belowThresholdResponse` | Real patterns | 202601150800456 | 10 min delay |

**Fixture metadata** documents real data sources (per ADR-017).

---

## MSW Test Pattern

Tests use **Mock Service Worker (MSW)** with:

- `setupServer()` for Node.js environment
- `http.post()` handlers for POST /api/v1/delays
- Dynamic routing based on RID in request body
- `server.use()` for test-specific overrides

**Pattern follows**: Existing `tests/unit/clients/darwin-ingestor.test.ts` (TD-DELAY-001)

---

## Test Lock Rule

**Blake MUST NOT modify these tests.**

If Blake believes a test is wrong:
1. Blake hands back to Jessie with explanation
2. Jessie reviews and updates test if needed
3. Jessie re-hands off the updated failing test

**Why**: The test is the specification - changing it changes the requirement.

---

## Expected Handback Cycles

**1-2 handbacks between Jessie and Blake are NORMAL** for this TD item. Reasons:

- AC-3 (zero-delay sentinel) is a subtle behavior change
- Error handling paths may need test refinement
- RID-in-sentinel preservation may need discussion

**3+ handbacks** would suggest test specification needs upfront review (not expected here).

---

## Handoff to Blake (TD-2)

Blake, implement the following in `src/clients/darwin-ingestor.ts`:

### Required Changes to `getDelayInfo()` (lines 67-101)

1. **Change HTTP method** from `GET` to `POST`
2. **Change URL** from `/api/v1/delays/${params.rid}?service_date=...` to `/api/v1/delays`
3. **Add header**: `'Content-Type': 'application/json'`
4. **Add body**: `JSON.stringify({ rids: [params.rid] })`
5. **Parse response** as `{ services: DarwinDelayInfo[] }`
6. **If `services.length === 0`**: Return zero-delay sentinel:
   ```typescript
   {
     rid: params.rid,
     delay_minutes: 0,
     is_cancelled: false,
     delay_reasons: null
   }
   ```
7. **If `services.length > 0`**: Return `services[0]`
8. **Remove** 404-specific error handling (lines 86-88) - POST returns 200 with empty array

### Reference Implementation

Use `getDelaysByRids()` (lines 27-61) as reference - it already uses POST correctly.

### Files NOT Changed

- ✅ `src/kafka/journey-confirmed-handler.ts` - handler logic already correct
- ✅ `src/types.ts` - types already match API contract
- ✅ `getDelaysByRids()` - must remain untouched (AC-6)

### Definition of Done (TD-2)

- [ ] All 21 failing tests now pass
- [ ] AC-6: 3 existing `getDelaysByRids()` tests still pass
- [ ] Existing handler tests still pass (33 tests)
- [ ] `npm run build` - Compiles cleanly
- [ ] `npm run lint` - No linting errors
- [ ] Ready for Jessie's QA sign-off (TD-3)

---

## Notes

- **No schema changes** - Implementation-only fix
- **No new dependencies** - Uses existing `fetch` API
- **service_date, origin_crs, destination_crs params** become unused by HTTP call but remain in method signature to avoid changing handler (acceptable technical debt)
- **Zero-delay sentinel** is the key behavior change that fixes the E2E pipeline

---

## References

- Quinn's TD-0 Specification: `docs/phases/TD-004-PHASE-TD0-SPECIFICATION.md`
- Darwin API Contract: POST /api/v1/delays with `{ rids: [...] }`
- E2E Evidence: RID 202602098022634 (PAD to CDF, 34 min delay)
- Test Lock Rule: CLAUDE.md Section 6
- ADR-014: TDD Requirements
- ADR-017: Test Fixture Ownership

---

**Jessie Sign-off**: Tests written, verified to FAIL for correct reasons. Ready for Blake's implementation (TD-2).
