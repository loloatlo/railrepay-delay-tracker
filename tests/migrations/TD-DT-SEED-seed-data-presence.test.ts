/**
 * TD-DT-SEED — Migration seed data must ship with the repo (and therefore the image).
 *
 * Bug (dev-environment deploy 2026-07-10):
 *   Deploying delay-tracker against a FRESH database dies in migration
 *   1775386062312_add-tiploc-crs-mapping.cjs with
 *     ENOENT: /app/migrations/seed-data/tiploc-crs-mapping.json
 *
 *   The migration reads the seed file at runtime:
 *     path.join(__dirname, 'seed-data', 'tiploc-crs-mapping.json')
 *   Commit 3d40be4 (BL-183) deleted that file from git while leaving the
 *   migration in place. Production never noticed because the migration is
 *   already recorded in pgmigrations and never re-runs; every fresh database
 *   (dev environments, CI Testcontainers, local bootstrap) re-runs it and dies.
 *
 * This test is the honest reproduction: it fails on any checkout that does not
 *   contain the seed file, exactly as the migration would. It also validates the
 *   shape the migration consumes (tiploc_code, crs_code, optional station_name)
 *   so a malformed restore cannot slip through. The full fresh-DB `migrate up`
 *   run is already exercised by the existing Testcontainers suites
 *   (tests/migrations/initial-schema.test.ts and friends), which fail on the
 *   same ENOENT today.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const migrationsDir = path.join(__dirname, '../../migrations');
const seedFilePath = path.join(migrationsDir, 'seed-data', 'tiploc-crs-mapping.json');

describe('TD-DT-SEED: migration seed data ships with the repo', () => {
  it('migrations/seed-data/tiploc-crs-mapping.json exists (fresh-DB migration 1775386062312 reads it at runtime)', () => {
    expect(
      fs.existsSync(seedFilePath),
      `Missing ${seedFilePath} — fresh-database deploys die with ENOENT in ` +
        '1775386062312_add-tiploc-crs-mapping.cjs. The file must be tracked in git ' +
        'so it reaches CI checkouts and the Docker image (COPY migrations ./migrations).'
    ).toBe(true);
  });

  it('parses as a non-empty JSON array (migration aborts on an empty seed file)', () => {
    const seedData = JSON.parse(fs.readFileSync(seedFilePath, 'utf-8'));
    expect(Array.isArray(seedData)).toBe(true);
    // Mirrors the migration's own guard: empty seed => throw.
    expect(seedData.length).toBeGreaterThan(0);
  });

  it('every row has the shape the migration INSERT consumes', () => {
    const seedData: Array<{
      tiploc_code: string;
      crs_code: string;
      station_name?: string | null;
    }> = JSON.parse(fs.readFileSync(seedFilePath, 'utf-8'));

    for (const row of seedData) {
      // tiploc_code VARCHAR(7) PRIMARY KEY
      expect(typeof row.tiploc_code).toBe('string');
      expect(row.tiploc_code.length).toBeGreaterThan(0);
      expect(row.tiploc_code.length).toBeLessThanOrEqual(7);

      // crs_code CHAR(3) NOT NULL
      expect(typeof row.crs_code).toBe('string');
      expect(row.crs_code).toHaveLength(3);

      // station_name VARCHAR(255), nullable (migration maps undefined -> null)
      if (row.station_name !== undefined && row.station_name !== null) {
        expect(typeof row.station_name).toBe('string');
        expect(row.station_name.length).toBeLessThanOrEqual(255);
      }
    }

    // tiploc_code is the PRIMARY KEY — duplicates would make row counts misleading
    const tiplocs = seedData.map((r) => r.tiploc_code);
    expect(new Set(tiplocs).size).toBe(tiplocs.length);
  });
});
