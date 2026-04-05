/**
 * Migration: Add tiploc_crs_mapping table to delay_tracker schema
 *
 * RFC: RFC-007-tiploc-crs-mapping.md
 * BL Item: BL-181 (TD-DELAY-CALC-001)
 * Governing Decision: ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 *
 * Context:
 *   Darwin stores train calling points using TIPLOC codes (e.g., MNCRPIC), not CRS codes
 *   (e.g., MAN). The Sequential Leg Walk algorithm (ADR-021) must look up the actual arrival
 *   time at the passenger's destination stop in Darwin data. Since delay-tracker receives CRS
 *   codes from journey.confirmed events but Darwin uses TIPLOC codes, a static mapping table
 *   is required within the delay_tracker schema.
 *
 * Per ADR-001: Schema-per-service — table MUST be in delay_tracker schema (no cross-schema FK).
 * Per ADR-003: node-pg-migrate for all migrations.
 * Per ADR-021: TIPLOC↔CRS mapping is owned by delay_tracker service.
 *
 * Schema:
 *   tiploc_code VARCHAR(7) PRIMARY KEY  — TIPLOC code (Darwin internal identifier)
 *   crs_code    CHAR(3) NOT NULL        — CRS code (customer-facing, e.g., KGX, MAN)
 *   station_name VARCHAR(255)           — Human-readable station name (informational)
 *   created_at  TIMESTAMPTZ             — Record creation timestamp
 *
 * Seed data:
 *   ~280 rows covering all major UK stations from NaPTAN/CORPUS data.
 *   The full ~2,600 row dataset is the production target; this migration seeds
 *   a representative set covering all TOC-served stations required for delay-tracker
 *   operation. See BL-182 (Tech Debt) for full NaPTAN import.
 *
 * Storage impact note (darwin-ingestor threshold change):
 *   ADR-021 requires lowering darwin-ingestor's SIGNIFICANT_DELAY_THRESHOLD_MINUTES
 *   from 15 to 1 minute. This migration does not implement that change (it is a
 *   darwin-ingestor service code change), but the data volume impact is assessed in
 *   RFC-007 section "Storage Impact Assessment".
 *
 * Zero-downtime:
 *   This is a pure additive migration (new table). No existing tables are modified.
 *   Rollback drops the table and its index — safe at any point.
 */

'use strict';

const path = require('path');
const fs = require('fs');

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // Step 1: Create the tiploc_crs_mapping table in delay_tracker schema
  // Per ADR-001: delay_tracker owns this table exclusively — no cross-schema FK.
  // Per ADR-021: Maps Darwin TIPLOC codes to customer-facing CRS codes for the
  //              Sequential Leg Walk algorithm.
  //
  // NOTE: Using pgm.db.query() (immediate execution) instead of pgm.createTable()
  // (deferred execution) because Step 3 uses pgm.db.query() for parameterised
  // INSERT. Mixing deferred pgm.createTable() with immediate pgm.db.query()
  // causes the INSERT to run before the CREATE TABLE.
  await pgm.db.query(`
    CREATE TABLE delay_tracker.tiploc_crs_mapping (
      tiploc_code VARCHAR(7) PRIMARY KEY,
      crs_code    CHAR(3) NOT NULL,
      station_name VARCHAR(255),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Step 2: Create index on crs_code for reverse lookups
  // Query pattern: delay-tracker needs to resolve CRS → TIPLOC(s) when checking
  // whether a Darwin stop matches the passenger's destination.
  // One CRS code may map to multiple TIPLOC codes (e.g., large terminus stations
  // with multiple TIPLOC entries for different platforms/areas).
  await pgm.db.query(`
    CREATE INDEX idx_tiploc_crs_mapping_crs_code
    ON delay_tracker.tiploc_crs_mapping (crs_code)
  `);

  // Step 3: Seed the mapping data from the JSON file
  // Source: NaPTAN/CORPUS data — authoritative UK station code mapping.
  // This seeds ~280 rows covering all major TOC-served stations.
  // Full ~2,600 row import tracked in BL-182.
  const seedFilePath = path.join(__dirname, 'seed-data', 'tiploc-crs-mapping.json');
  const seedData = JSON.parse(fs.readFileSync(seedFilePath, 'utf-8'));

  if (seedData.length === 0) {
    // Guard against empty seed file causing a misleading successful migration
    throw new Error('tiploc-crs-mapping.json seed file is empty — migration aborted');
  }

  // Insert in batches of 100 to avoid overly large parameter lists
  const batchSize = 100;
  for (let i = 0; i < seedData.length; i += batchSize) {
    const batch = seedData.slice(i, i + batchSize);

    // Build parameterised INSERT for this batch
    const valuePlaceholders = batch
      .map((_, idx) => {
        const base = idx * 3;
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      })
      .join(', ');

    const values = batch.flatMap(row => [
      row.tiploc_code,
      row.crs_code,
      row.station_name ?? null,
    ]);

    await pgm.db.query(
      `INSERT INTO delay_tracker.tiploc_crs_mapping (tiploc_code, crs_code, station_name)
       VALUES ${valuePlaceholders}
       ON CONFLICT (tiploc_code) DO UPDATE
         SET crs_code = EXCLUDED.crs_code,
             station_name = EXCLUDED.station_name`,
      values
    );
  }
};

exports.down = async (pgm) => {
  // Using immediate pgm.db.query() to match the up migration style.
  await pgm.db.query(`
    DROP INDEX IF EXISTS delay_tracker.idx_tiploc_crs_mapping_crs_code
  `);
  await pgm.db.query(`
    DROP TABLE IF EXISTS delay_tracker.tiploc_crs_mapping CASCADE
  `);
};
