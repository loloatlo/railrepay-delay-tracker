/**
 * Migration: Add 'darwin_unavailable' status to monitored_journeys
 *
 * Context: TD-DELAY-TRACKER-002 - Adding Kafka consumer for journey.confirmed events
 * to delay-tracker service. When darwin-ingestor data is unavailable for a journey,
 * we need to mark it as 'darwin_unavailable' in monitoring_status.
 *
 * Changes:
 * - ALTER monitored_journeys.monitoring_status CHECK constraint to include 'darwin_unavailable'
 * - Original values: ('pending_rid', 'active', 'delayed', 'completed', 'cancelled')
 * - New values: ('pending_rid', 'active', 'delayed', 'completed', 'cancelled', 'darwin_unavailable')
 *
 * Per ADR-001: Schema-per-service - delay_tracker owns monitoring_status constraint
 * Per ADR-003: node-pg-migrate for all migrations
 * Per ADR-018: Per-service migration tracking (delay_tracker schema, pgmigrations table)
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // Step 1: Check if table exists (defensive check per ADR-018 init-schema.sql pattern)
  const tableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'monitored_journeys'
    );
  `);

  if (!tableExists.rows[0].exists) {
    // Table doesn't exist yet - skip migration (init-schema.sql will create it)
    return;
  }

  // Step 2: Drop the existing CHECK constraint
  // Note: PostgreSQL auto-generates constraint name as "{table}_{column}_check"
  pgm.dropConstraint(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'monitored_journeys_monitoring_status_check',
    { ifExists: true }
  );

  // Step 3: Add new CHECK constraint with 'darwin_unavailable' included
  pgm.addConstraint(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'monitored_journeys_monitoring_status_check',
    {
      check: "monitoring_status IN ('pending_rid', 'active', 'delayed', 'completed', 'cancelled', 'darwin_unavailable')",
    }
  );
};

exports.down = async (pgm) => {
  // Step 1: Check if table exists (defensive check)
  const tableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'monitored_journeys'
    );
  `);

  if (!tableExists.rows[0].exists) {
    return;
  }

  // Step 2: Drop the new constraint
  pgm.dropConstraint(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'monitored_journeys_monitoring_status_check',
    { ifExists: true }
  );

  // Step 3: Restore original CHECK constraint (5 values only)
  pgm.addConstraint(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'monitored_journeys_monitoring_status_check',
    {
      check: "monitoring_status IN ('pending_rid', 'active', 'delayed', 'completed', 'cancelled')",
    }
  );

  // Step 4: Data cleanup - reset any 'darwin_unavailable' rows to 'pending_rid'
  // This ensures rollback doesn't violate the restored constraint
  await pgm.db.query(`
    UPDATE delay_tracker.monitored_journeys
    SET monitoring_status = 'pending_rid'
    WHERE monitoring_status = 'darwin_unavailable';
  `);
};
