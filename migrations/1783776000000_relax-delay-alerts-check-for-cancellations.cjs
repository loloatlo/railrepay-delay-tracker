/**
 * Migration: Allow delay_minutes = 0 on delay_alerts rows that record a CANCELLATION
 *
 * Context (dt-ci-green remediation, 2026-07-11):
 *   The initial schema created delay_alerts with CHECK (delay_minutes > 0) AND an
 *   is_cancellation column. Every cancellation write path in the service inserts
 *   delay_minutes = 0 with is_cancellation = true:
 *     - src/kafka/journey-confirmed-handler.ts  createDelayAlert()  (historic journeys)
 *     - src/services/delay-evaluation.service.ts ensure path        (ADR-031 endpoint)
 *   Both paths crash with 23514 (delay_alerts_delay_minutes_check) the moment Darwin
 *   reports a cancelled service with no recorded delay minutes. The locked integration
 *   test TD-DELAY-TRACKER-002 ("should handle cancellations") specifies exactly this
 *   behaviour and exposed the conflict the first time its suite setup ever succeeded.
 *
 * Change:
 *   CHECK (delay_minutes > 0)
 *     -> CHECK (delay_minutes > 0 OR (is_cancellation AND delay_minutes >= 0))
 *   Strictly looser: every previously valid row remains valid; zero/negative
 *   delay_minutes on NON-cancellation rows are still rejected, and negative values
 *   are rejected even for cancellations.
 *
 * Zero-downtime:
 *   ALTER TABLE ... DROP/ADD CONSTRAINT on a small table; the new predicate is a
 *   superset of the old one so validation of existing rows cannot fail.
 *
 * LESSON LEARNED (BL-181 deployment failure):
 *   Use pgm.db.query() for immediate execution — NOT deferred pgm.* builders.
 */

'use strict';

exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  // Defensive: confirm table exists before altering (pattern per 1770714617404)
  const tableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'delay_alerts'
    );
  `);

  if (!tableExists.rows[0].exists) {
    return;
  }

  await pgm.db.query(`
    ALTER TABLE delay_tracker.delay_alerts
    DROP CONSTRAINT IF EXISTS delay_alerts_delay_minutes_check;
  `);

  await pgm.db.query(`
    ALTER TABLE delay_tracker.delay_alerts
    ADD CONSTRAINT delay_alerts_delay_minutes_check
    CHECK (delay_minutes > 0 OR (is_cancellation AND delay_minutes >= 0));
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  const tableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'delay_alerts'
    );
  `);

  if (!tableExists.rows[0].exists) {
    return;
  }

  // Data cleanup so the restored (stricter) constraint can validate:
  // zero-minute cancellation alerts cannot exist under the original constraint.
  // Pattern per 1770714617404's down() data cleanup.
  await pgm.db.query(`
    DELETE FROM delay_tracker.delay_alerts
    WHERE delay_minutes <= 0;
  `);

  await pgm.db.query(`
    ALTER TABLE delay_tracker.delay_alerts
    DROP CONSTRAINT IF EXISTS delay_alerts_delay_minutes_check;
  `);

  await pgm.db.query(`
    ALTER TABLE delay_tracker.delay_alerts
    ADD CONSTRAINT delay_alerts_delay_minutes_check
    CHECK (delay_minutes > 0);
  `);
};
