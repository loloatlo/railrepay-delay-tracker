# RFC-001: Add 'darwin_unavailable' Status to monitored_journeys

**Status**: Proposed
**Created**: 2026-02-10
**Author**: Hoops (Data Architect)
**Related**: TD-DELAY-TRACKER-002 (Kafka Consumer Implementation)
**Domain**: Delay Detection & Monitoring
**Service**: delay-tracker

---

## Rationale

As part of TD-DELAY-TRACKER-002, the delay-tracker service is adding a Kafka consumer to receive `journey.confirmed` events from journey-matcher. This enables real-time delay monitoring registration immediately when users confirm their journeys, replacing the current manual "register journey" flow.

**Current monitoring_status values**:
- `pending_rid`: Journey registered but RID not yet resolved
- `active`: Journey actively monitored for delays
- `delayed`: Delay detected (≥15 minutes or cancellation)
- `completed`: Journey completed, monitoring ended
- `cancelled`: Journey cancelled

**Gap**: When darwin-ingestor does not have data for a specific journey (e.g., service not found in Darwin feed, RID resolution failed, or Darwin data gaps), there is no status to represent this terminal state. Currently, the service would remain stuck in `pending_rid` or fail silently.

**Solution**: Add `darwin_unavailable` status to represent journeys where delay monitoring cannot be performed due to missing Darwin data. This allows:
1. Clear user communication ("We cannot track delays for this journey")
2. Metrics on Darwin data coverage
3. Proper cleanup in data retention policies

**Impact on microservice boundaries**: This is a schema-local change within the `delay_tracker` schema. No cross-service impacts — the status is internal to delay-tracker's monitoring logic.

---

## Forward Migration SQL

**Migration file**: `1770714617404_add-darwin-unavailable-status.cjs`

**Changes**:
1. Drop existing CHECK constraint on `monitoring_status` column
2. Add new CHECK constraint including `darwin_unavailable`

**Schema change**:
```sql
-- Drop old constraint
ALTER TABLE delay_tracker.monitored_journeys
DROP CONSTRAINT IF EXISTS monitored_journeys_monitoring_status_check;

-- Add new constraint with 6 values (was 5)
ALTER TABLE delay_tracker.monitored_journeys
ADD CONSTRAINT monitored_journeys_monitoring_status_check
CHECK (monitoring_status IN (
  'pending_rid',
  'active',
  'delayed',
  'completed',
  'cancelled',
  'darwin_unavailable'  -- NEW
));
```

**Justification for constraint change**:
- CHECK constraints enforce data integrity at database level per ADR-001
- Adding a new enum-like value requires dropping and recreating the constraint
- No data migration needed — new value only used by new consumer code

**Index impact**: None. Existing indexes on `monitoring_status` remain valid:
- `idx_monitored_journeys_next_check` (partial index WHERE `monitoring_status IN ('pending_rid', 'active')`) — NOT affected, `darwin_unavailable` is outside WHERE clause
- No other indexes reference this column

**Performance impact**: Negligible. CHECK constraint validation is O(1) for enum-like checks.

---

## Rollback Migration SQL

**Down migration strategy**:
1. Update any `darwin_unavailable` rows back to `pending_rid` (data cleanup)
2. Drop new constraint
3. Restore original constraint (5 values)

```sql
-- Step 1: Data cleanup (prevent constraint violation on rollback)
UPDATE delay_tracker.monitored_journeys
SET monitoring_status = 'pending_rid'
WHERE monitoring_status = 'darwin_unavailable';

-- Step 2: Drop new constraint
ALTER TABLE delay_tracker.monitored_journeys
DROP CONSTRAINT IF EXISTS monitored_journeys_monitoring_status_check;

-- Step 3: Restore original constraint
ALTER TABLE delay_tracker.monitored_journeys
ADD CONSTRAINT monitored_journeys_monitoring_status_check
CHECK (monitoring_status IN (
  'pending_rid',
  'active',
  'delayed',
  'completed',
  'cancelled'
));
```

**Rollback validation**:
- Run `SELECT COUNT(*) FROM delay_tracker.monitored_journeys WHERE monitoring_status = 'darwin_unavailable'` — should return 0 after rollback
- Verify constraint exists: `SELECT conname FROM pg_constraint WHERE conrelid = 'delay_tracker.monitored_journeys'::regclass AND conname = 'monitored_journeys_monitoring_status_check';`

---

## Integration Test Specifications

**Test scenarios** (for Jessie to implement in Phase TD-1):

### Test 1: New status value accepted
```typescript
// GIVEN: Kafka consumer receives journey.confirmed event
// WHEN: darwin-ingestor responds with 404 (service not found)
// THEN: monitored_journeys row created with status = 'darwin_unavailable'

const result = await db.one(`
  INSERT INTO delay_tracker.monitored_journeys
    (journey_id, user_id, service_date, origin_crs, destination_crs,
     scheduled_departure, scheduled_arrival, monitoring_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'darwin_unavailable')
  RETURNING *
`, [journeyId, userId, serviceDate, originCrs, destCrs, scheduledDep, scheduledArr]);

expect(result.monitoring_status).toBe('darwin_unavailable');
```

### Test 2: Invalid status rejected
```typescript
// GIVEN: Migration applied
// WHEN: Insert with invalid status value
// THEN: CHECK constraint violation error

await expect(
  db.one(`
    INSERT INTO delay_tracker.monitored_journeys
      (journey_id, user_id, service_date, origin_crs, destination_crs,
       scheduled_departure, scheduled_arrival, monitoring_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'invalid_status')
    RETURNING *
  `, [journeyId, userId, serviceDate, originCrs, destCrs, scheduledDep, scheduledArr])
).rejects.toThrow(/violates check constraint/);
```

### Test 3: Existing statuses still valid
```typescript
// GIVEN: Migration applied
// WHEN: Insert with original 5 status values
// THEN: All succeed

const statuses = ['pending_rid', 'active', 'delayed', 'completed', 'cancelled'];

for (const status of statuses) {
  const result = await db.one(`
    INSERT INTO delay_tracker.monitored_journeys
      (journey_id, user_id, service_date, origin_crs, destination_crs,
       scheduled_departure, scheduled_arrival, monitoring_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [uuidv4(), userId, serviceDate, originCrs, destCrs, scheduledDep, scheduledArr, status]);

  expect(result.monitoring_status).toBe(status);
}
```

### Test 4: Rollback data cleanup
```typescript
// GIVEN: Multiple rows with status = 'darwin_unavailable'
// WHEN: Down migration runs
// THEN: All darwin_unavailable rows reset to 'pending_rid'

// Setup
await db.none(`
  INSERT INTO delay_tracker.monitored_journeys
    (journey_id, user_id, service_date, origin_crs, destination_crs,
     scheduled_departure, scheduled_arrival, monitoring_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'darwin_unavailable')
`, [journeyId, userId, serviceDate, originCrs, destCrs, scheduledDep, scheduledArr]);

// Run down migration
await migrate('down');

// Verify cleanup
const count = await db.one(`
  SELECT COUNT(*) FROM delay_tracker.monitored_journeys
  WHERE monitoring_status = 'darwin_unavailable'
`);

expect(count.count).toBe('0');
```

---

## Performance Impact Assessment

**Affected queries**: None directly. The CHECK constraint is evaluated only on INSERT/UPDATE operations.

**Expected latency changes**:
- INSERT latency: +0.01ms (negligible — CHECK constraint is in-memory enum validation)
- UPDATE latency: +0.01ms (same as above)
- SELECT queries: No impact (constraint not evaluated on reads)

**Index impact**: No new indexes required. Existing partial index `idx_monitored_journeys_next_check` explicitly excludes `darwin_unavailable` (WHERE clause: `monitoring_status IN ('pending_rid', 'active')`), so no index bloat.

**Concurrency impact**: None. CHECK constraints are row-level and do not acquire table-level locks.

---

## Data Migration Strategy

**Not applicable** — this is an additive schema change. No existing data needs to be migrated.

**Future data**:
- New `darwin_unavailable` status only set by Kafka consumer logic (TD-DELAY-TRACKER-002)
- Existing rows remain in their current statuses
- No backfill required

---

## Fixture Data Samples for Jessie

### Sample Extraction Queries

Jessie can use these queries via Postgres MCP to create test fixtures:

```sql
-- Sample 1: Happy path - active monitoring
SELECT journey_id, user_id, monitoring_status, rid, service_date, origin_crs, destination_crs
FROM delay_tracker.monitored_journeys
WHERE monitoring_status = 'active' AND rid IS NOT NULL
LIMIT 2;

-- Sample 2: Edge case - pending RID (not yet resolved)
SELECT journey_id, user_id, monitoring_status, rid, service_date, origin_crs, destination_crs
FROM delay_tracker.monitored_journeys
WHERE monitoring_status = 'pending_rid' AND rid IS NULL
LIMIT 1;

-- Sample 3: Edge case - cancelled journey
SELECT journey_id, user_id, monitoring_status, rid, service_date, origin_crs, destination_crs
FROM delay_tracker.monitored_journeys
WHERE monitoring_status = 'cancelled'
LIMIT 1;

-- Sample 4: Edge case - darwin_unavailable (NEW - will be empty until consumer deployed)
SELECT journey_id, user_id, monitoring_status, rid, service_date, origin_crs, destination_crs
FROM delay_tracker.monitored_journeys
WHERE monitoring_status = 'darwin_unavailable'
LIMIT 2;

-- Sample 5: Constraint validation - check all valid statuses
SELECT monitoring_status, COUNT(*)
FROM delay_tracker.monitored_journeys
GROUP BY monitoring_status
ORDER BY monitoring_status;
```

**Representative test data** (for Jessie to create in test fixtures):

```typescript
// Happy path: Normal monitored journey
{
  journey_id: '550e8400-e29b-41d4-a716-446655440000',
  user_id: '123456789',
  monitoring_status: 'active',
  rid: '202601220830001',
  service_date: '2026-01-22',
  origin_crs: 'KGX',
  destination_crs: 'EDN',
  scheduled_departure: '2026-01-22T08:30:00Z',
  scheduled_arrival: '2026-01-22T13:00:00Z'
}

// Edge case: darwin_unavailable (NEW STATUS)
{
  journey_id: '550e8400-e29b-41d4-a716-446655440001',
  user_id: '123456789',
  monitoring_status: 'darwin_unavailable',
  rid: null,  // RID resolution failed
  service_date: '2026-01-22',
  origin_crs: 'KGX',
  destination_crs: 'EDN',
  scheduled_departure: '2026-01-22T08:30:00Z',
  scheduled_arrival: '2026-01-22T13:00:00Z'
}

// Edge case: pending_rid (waiting for RID)
{
  journey_id: '550e8400-e29b-41d4-a716-446655440002',
  user_id: '987654321',
  monitoring_status: 'pending_rid',
  rid: null,
  service_date: '2026-01-23',
  origin_crs: 'PAD',
  destination_crs: 'BRI',
  scheduled_departure: '2026-01-23T09:00:00Z',
  scheduled_arrival: '2026-01-23T10:30:00Z'
}
```

---

## Zero-Downtime Deployment

**Deployment strategy**: Single-phase additive change (no expand-migrate-contract needed)

**Phase 1: Deploy migration**
- Migration adds new status value to CHECK constraint
- Old code continues using existing 5 statuses (unaffected)
- New code can use `darwin_unavailable` (optional, not required)

**Phase 2: Deploy consumer code (TD-DELAY-TRACKER-002)**
- Kafka consumer begins setting `darwin_unavailable` status
- No breaking changes — existing endpoints and queries continue to work

**Rollback plan**:
1. Revert consumer deployment (stop Kafka consumer)
2. Run down migration (resets `darwin_unavailable` rows to `pending_rid`)
3. Verify constraint restored: `SELECT conname FROM pg_constraint WHERE conrelid = 'delay_tracker.monitored_journeys'::regclass;`

**Hot path considerations**: None. The `monitored_journeys` table is write-light (only on journey registration). No risk of lock contention.

---

## Operational Considerations

**Monitoring**:
- Add Grafana dashboard panel: `SELECT COUNT(*) FROM delay_tracker.monitored_journeys WHERE monitoring_status = 'darwin_unavailable'`
- Alert if count exceeds 10% of total monitored journeys (indicates Darwin data quality issue)

**Data retention**:
- `darwin_unavailable` journeys are terminal states (no further monitoring)
- data-retention-service should cleanup journeys with `monitoring_status IN ('completed', 'cancelled', 'darwin_unavailable')` after 90 days per ADR-009

**Backups**:
- Railway automated daily backups (no special handling required)
- Manual snapshot recommended before migration (Moykle Phase TD-4)

---

## Notion Documentation References

**System Index**: [2fa815ba-72ee-80d9-97e9-e16838db5b49](https://www.notion.so/2fa815ba72ee80d997e9e16838db5b49)
**Data Layer**: [2b3815ba72ee8167b721cd01cecda4b3](https://www.notion.so/2b3815ba72ee8167b721cd01cecda4b3)
**Domain**: Delay Detection & Monitoring (delay-tracker, darwin-ingestor)

**Key principles applied**:
- Schema-per-service: delay_tracker schema owned by delay-tracker service
- No cross-schema foreign keys: monitoring_status is internal to delay_tracker
- Transactional outbox: Not affected by this change (outbox table unchanged)
- Data type standards: VARCHAR(20) for monitoring_status (enum-like CHECK constraint)

---

## Summary

This RFC proposes a minimal, zero-risk schema change to add a sixth status value (`darwin_unavailable`) to the `monitored_journeys.monitoring_status` column. The change:

✅ Enables TD-DELAY-TRACKER-002 Kafka consumer to handle Darwin data gaps gracefully
✅ Requires no data migration or backfill
✅ Has zero performance impact (negligible CHECK constraint overhead)
✅ Maintains backward compatibility (old code unaffected)
✅ Includes full rollback strategy with data cleanup
✅ Provides comprehensive test specifications for Jessie
✅ Ready for Postgres MCP verification post-deployment

**Quality gate checklist** (Phase TD-0.5):
- [x] RFC includes rationale and impact analysis
- [x] Forward migration SQL provided with justifications
- [x] Rollback migration SQL with validation steps
- [x] Integration test specifications (4 scenarios)
- [x] Performance impact assessment (negligible)
- [x] Data migration strategy (not applicable)
- [x] Fixture data samples for Jessie (5 queries + 3 representative rows)
- [x] Schema ownership boundaries respected (delay_tracker schema only)
- [x] Naming follows conventions (snake_case, descriptive)
- [x] Constraints enforce data integrity (CHECK constraint at DB level)
- [x] Zero-downtime deployment strategy (single-phase additive)
- [x] Operational aspects covered (monitoring, retention, backups)
- [x] Notion Data Layer consulted and cited

**Ready for handoff to Jessie (Phase TD-1)** for test specification.
