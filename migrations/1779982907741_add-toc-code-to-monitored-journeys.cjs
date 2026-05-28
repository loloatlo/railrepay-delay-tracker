/**
 * Migration: Add toc_code column to delay_tracker.monitored_journeys
 *
 * Context: BL-314 — on-demand eligibility path fails because delay-tracker's
 * GET /delays/:journeyId response returns toc_code=null. BL-313 added toc_code
 * to the write path in application code but never created the backing column,
 * so every INSERT silently discarded the value and every read returned null.
 *
 * Column format decision (verified against prod, 2026-05-28):
 *   - darwin_ingestor.delay_services stores Darwin single-char codes (C, G, W, S...)
 *   - darwin_ingestor.outbox_events payload.tocCode = 'C' (same single-char)
 *   - eligibility_engine.toc_rulepacks keys are 2-char ATOC codes (XC, GW, SE, AW...)
 *   - eligibility_engine.eligibility_evaluations.toc_code = 2-char ATOC (SE, AW, GW)
 *   - There IS a Darwin→ATOC normalization in the pipeline, but it lives in
 *     darwin-ingestor's HTTP API response (GET /api/v1/delays), NOT in the DB.
 *     The delay-tracker read path calls that API and receives the ATOC code.
 *     The delay-tracker write path persists whatever the API returns.
 *     Therefore this column stores 2-char ATOC codes (e.g. 'XC', 'SE', 'GW').
 *   - Both darwin_ingestor.delay_services.toc_code and
 *     eligibility_engine.toc_rulepacks.toc_code are VARCHAR(10).
 *     We match that width.
 *
 * Nullable: YES — existing rows pre-date this migration and cannot be
 * backfilled automatically. A targeted one-off backfill script covers the
 * specific stale row (journey_id = 5a0f1380-514d-4901-8a29-18c33ce4e0fc).
 * New inserts via the fixed write path will always supply the value.
 *
 * Per ADR-001: Schema-per-service — delay_tracker owns this column.
 * Per ADR-003: node-pg-migrate for all migrations.
 * Per ADR-018: Per-service migration tracking.
 * Per ADR-030 (amended): toc_code must be persisted, not live-read.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // Defensive: confirm table exists before altering
  const tableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'monitored_journeys'
    );
  `);

  if (!tableExists.rows[0].exists) {
    // Table doesn't exist — initial schema migration will create it with the column.
    // This guard prevents failure in a fresh environment running migrations in order.
    return;
  }

  // Defensive: skip if column already exists (idempotency guard)
  const columnExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'monitored_journeys'
      AND column_name = 'toc_code'
    );
  `);

  if (columnExists.rows[0].exists) {
    return;
  }

  // Add the toc_code column — nullable because existing rows pre-date this migration.
  // Width matches darwin_ingestor.delay_services.toc_code and
  // eligibility_engine.toc_rulepacks.toc_code (both VARCHAR(10)).
  // Stored value format: 2-char ATOC code as returned by darwin-ingestor's HTTP API
  // (e.g. 'XC', 'SE', 'GW') — NOT the raw Darwin single-char code ('C', 'S', 'G').
  pgm.addColumn(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    {
      toc_code: {
        type: 'varchar(10)',
        notNull: false,
      },
    }
  );
};

exports.down = async (pgm) => {
  // Defensive: confirm table exists
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

  // Defensive: skip if column was never added
  const columnExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_schema = 'delay_tracker'
      AND table_name = 'monitored_journeys'
      AND column_name = 'toc_code'
    );
  `);

  if (!columnExists.rows[0].exists) {
    return;
  }

  pgm.dropColumn(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'toc_code',
    { ifExists: true }
  );
};
