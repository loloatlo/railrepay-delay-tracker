/**
 * Migration: Drop delay_tracker.tiploc_crs_mapping
 *
 * BL-183 (TD-TIPLOC-STATIONS-001) — AC-5
 *
 * The delay_tracker.tiploc_crs_mapping table was created in BL-181 with 338
 * fabricated rows derived from delay_services station names. It never held real
 * TIPLOC↔CRS mappings. delay-tracker now reads from timetable_loader.stations
 * which has ~3,500+ correct mappings seeded from Darwin reference data.
 *
 * LESSON LEARNED (BL-181 deployment failure):
 * Use pgm.db.query() for immediate execution — NOT deferred pgm.dropTable().
 * Deferred operations cause issues in the Railway migration environment.
 */

'use strict';

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  // Drop the index first, then the table (immediate execution via db.query)
  await pgm.db.query(`
    DROP INDEX IF EXISTS delay_tracker.idx_tiploc_crs_mapping_tiploc;
  `);

  await pgm.db.query(`
    DROP TABLE IF EXISTS delay_tracker.tiploc_crs_mapping;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = async (pgm) => {
  // Recreate the table for rollback safety (empty — seed data was fabricated)
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS delay_tracker.tiploc_crs_mapping (
      tiploc_code   VARCHAR(10)  NOT NULL,
      crs_code      VARCHAR(3)   NOT NULL,
      station_name  VARCHAR(255) NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tiploc_code)
    );
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_tiploc_crs_mapping_tiploc
      ON delay_tracker.tiploc_crs_mapping (tiploc_code);
  `);
};
