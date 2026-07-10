/**
 * Unit Tests: BL-183 (TD-TIPLOC-STATIONS-001) — AC-4, AC-5, AC-6, AC-10
 * Re-engineer tiplocRepository to query timetable_loader.stations
 *
 * Phase: TD-1 — Test Specification (Jessie)
 * BL Item: BL-183 (TD-TIPLOC-STATIONS-001)
 * Service: delay-tracker
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation (Fundamental Delay Equation)
 * Governing ADR: ADR-001 — Schema-per-service (cross-schema SELECT is permitted for reads)
 *
 * CONTEXT:
 *   BL-181 created delay_tracker.tiploc_crs_mapping with 338 fabricated rows
 *   derived from the existing delay_tracker.delay_services table. The fabricated
 *   data never represented real TIPLOC↔CRS mappings — it was station names derived
 *   from a service table.
 *
 *   The correct approach (ADA Option 2): delay-tracker reads TIPLOC data from
 *   timetable_loader.stations which will be populated by the fixed seed script (AC-1/AC-2).
 *   This gives ~3,500+ real TIPLOC mappings vs 338 fabricated ones.
 *
 * REQUIRED CHANGES:
 *   AC-4: Create services/delay-tracker/src/repositories/tiploc-repository.ts
 *         implementing TiplocRepository interface (defined in sequential-leg-walk.ts)
 *         that queries timetable_loader.stations (SELECT crs_code, tiploc FROM
 *         timetable_loader.stations WHERE tiploc = $1 / WHERE crs_code = $1)
 *
 *   AC-5: Create rollback migration to DROP delay_tracker.tiploc_crs_mapping.
 *         New migration file: services/delay-tracker/migrations/<timestamp>_drop-tiploc-crs-mapping.cjs
 *         The down() of the existing 1775386062312_add-tiploc-crs-mapping.cjs migration
 *         already drops the table — but a FORWARD migration is also required to
 *         allow clean deployment without requiring a manual rollback.
 *
 *   AC-6: sequential-leg-walk.ts continues to use TiplocRepository interface unchanged.
 *         The ONLY change is that the concrete implementation now queries
 *         timetable_loader.stations instead of delay_tracker.tiploc_crs_mapping.
 *
 *   AC-10: Remove seed-data directory and old fixture file
 *          - services/delay-tracker/migrations/seed-data/tiploc-crs-mapping.json (DELETE)
 *          - services/delay-tracker/migrations/seed-data/ directory (DELETE)
 *
 * IMPORTANT:
 *   The TiplocRepository INTERFACE in sequential-leg-walk.ts does NOT change:
 *     getCrsByTiploc(tiplocCode: string): Promise<string | null>
 *     getTiplocsByCrs(crsCode: string): Promise<string[]>
 *   The existing 34 + 9 BL-181 tests mock at this interface and will continue to pass.
 *   Only the CONCRETE IMPLEMENTATION changes — these tests cover the new concrete class.
 *
 * Test Lock Rule: Blake MUST NOT modify these tests. (ADR-014, ADR-004)
 *
 * AC COVERAGE:
 *   AC-4a: TiplocRepository class exists at src/repositories/tiploc-repository.ts
 *   AC-4b: getCrsByTiploc() queries timetable_loader.stations WHERE tiploc = $1
 *   AC-4c: getTiplocsByCrs() queries timetable_loader.stations WHERE crs_code = $1
 *   AC-4d: getCrsByTiploc() returns null when no matching row found
 *   AC-4e: getTiplocsByCrs() returns empty array when no matching rows found
 *   AC-4f: getCrsByTiploc() returns the crs_code from the matching row
 *   AC-4g: getTiplocsByCrs() returns all tiploc values for a multi-TIPLOC station
 *   AC-5a: A new forward migration exists to DROP delay_tracker.tiploc_crs_mapping
 *   AC-5b: The new migration's up() drops tiploc_crs_mapping table
 *   AC-6a: SequentialLegWalk still accepts TiplocRepository via its interface
 *   AC-10a: seed-data/tiploc-crs-mapping.json no longer exists
 *   AC-10b: migrations/seed-data/ directory no longer exists
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// File system path constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(__dirname, '../../../migrations');
const SEED_DATA_DIR = path.join(MIGRATIONS_DIR, 'seed-data');
const SEED_DATA_FILE = path.join(SEED_DATA_DIR, 'tiploc-crs-mapping.json');
const OLD_MIGRATION = path.join(
  MIGRATIONS_DIR,
  '1775386062312_add-tiploc-crs-mapping.cjs'
);

// ---------------------------------------------------------------------------
// Mock DB client factory
// ---------------------------------------------------------------------------

function makeMockDbClient() {
  return {
    query: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// AC-4: TiplocRepository implementation — queries timetable_loader.stations
//
// NOTE: These tests use dynamic import() so that the entire suite can load and
// show individual test failures (RED) rather than a suite-level crash when the
// module doesn't exist yet. Each test that needs TiplocRepository calls
// loadTiplocRepository() and will fail with a clear error message.
// ---------------------------------------------------------------------------

async function loadTiplocRepository(): Promise<any> {
  // Dynamic import: fails with a descriptive error until Blake creates the file
  const mod = await import('../../../src/repositories/tiploc-repository.js');
  return mod.TiplocRepository;
}

describe('BL-183 (TD-TIPLOC-STATIONS-001): AC-4 — TiplocRepository queries timetable_loader.stations', () => {

  // AC-4a: The TiplocRepository class exists and is constructible
  describe('AC-4a: TiplocRepository is constructible', () => {
    it('should be a class that can be instantiated with a db client', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      const repo = new TiplocRepository({ dbClient: mockDbClient });

      expect(repo).toBeDefined();
      expect(typeof repo.getCrsByTiploc).toBe('function');
      expect(typeof repo.getTiplocsByCrs).toBe('function');
    });
  });

  // AC-4b: getCrsByTiploc() must query timetable_loader.stations WHERE tiploc = $1
  describe('AC-4b: getCrsByTiploc() queries timetable_loader.stations', () => {
    it('should query timetable_loader.stations with the tiploc code as a parameter', async () => {
      // Verified: timetable_loader.stations has tiploc and crs_code columns
      // per migration 1730620000000_add-tiploc-to-stations.ts and initial schema
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([{ crs_code: 'MAN' }]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      await repo.getCrsByTiploc('MNCRPIC');

      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining('timetable_loader.stations'),
        expect.arrayContaining(['MNCRPIC'])
      );
    });

    it('should include WHERE tiploc = $1 condition in the query', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([{ crs_code: 'KGX' }]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      await repo.getCrsByTiploc('KNGSCRS');

      const [sql, params] = mockDbClient.query.mock.calls[0];
      // Must query by tiploc column
      expect(sql.toLowerCase()).toContain('tiploc');
      expect(params).toEqual(['KNGSCRS']);
    });

    it('should NOT query delay_tracker.tiploc_crs_mapping (the fabricated table)', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      await repo.getCrsByTiploc('MNCRPIC');

      const [sql] = mockDbClient.query.mock.calls[0];
      // Must NOT reference the old fabricated mapping table
      expect(sql).not.toContain('tiploc_crs_mapping');
      expect(sql).not.toContain('delay_tracker.tiploc_crs_mapping');
    });
  });

  // AC-4c: getTiplocsByCrs() must query timetable_loader.stations WHERE crs_code = $1
  describe('AC-4c: getTiplocsByCrs() queries timetable_loader.stations', () => {
    it('should query timetable_loader.stations with the crs code as a parameter', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([
        { tiploc: 'BHAM' },
        { tiploc: 'BHAMNWS' },
      ]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      await repo.getTiplocsByCrs('BHM');

      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining('timetable_loader.stations'),
        expect.arrayContaining(['BHM'])
      );
    });

    it('should include WHERE crs_code = $1 condition in the query', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([{ tiploc: 'YORK' }]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      await repo.getTiplocsByCrs('YRK');

      const [sql, params] = mockDbClient.query.mock.calls[0];
      expect(sql.toLowerCase()).toContain('crs_code');
      expect(params).toEqual(['YRK']);
    });

    it('should NOT query delay_tracker.tiploc_crs_mapping (the fabricated table)', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      await repo.getTiplocsByCrs('MAN');

      const [sql] = mockDbClient.query.mock.calls[0];
      expect(sql).not.toContain('tiploc_crs_mapping');
      expect(sql).not.toContain('delay_tracker.tiploc_crs_mapping');
    });
  });

  // AC-4d: getCrsByTiploc() returns null when no row is found
  describe('AC-4d: getCrsByTiploc() returns null for unknown TIPLOC', () => {
    it('should return null when timetable_loader.stations has no row for the tiploc', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getCrsByTiploc('UNKNOWN');

      expect(result).toBeNull();
    });

    it('should return null when DB query returns empty array', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getCrsByTiploc('DOESNTEXIST');

      expect(result).toBeNull();
    });
  });

  // AC-4e: getTiplocsByCrs() returns empty array when no rows found
  describe('AC-4e: getTiplocsByCrs() returns [] for unknown CRS', () => {
    it('should return an empty array when timetable_loader.stations has no row for the crs', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getTiplocsByCrs('ZZZ');

      expect(result).toEqual([]);
    });
  });

  // AC-4f: getCrsByTiploc() returns the crs_code string from the matching row
  describe('AC-4f: getCrsByTiploc() returns the crs_code from the matched row', () => {
    it('should return the crs_code string when a matching station row exists', async () => {
      // Manchester Piccadilly: TIPLOC MNCRPIC → CRS MAN
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([{ crs_code: 'MAN' }]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getCrsByTiploc('MNCRPIC');

      expect(result).toBe('MAN');
    });

    it('should return the correct crs_code for Kings Cross (KNGSCRS → KGX)', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([{ crs_code: 'KGX' }]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getCrsByTiploc('KNGSCRS');

      expect(result).toBe('KGX');
    });
  });

  // AC-4g: getTiplocsByCrs() returns ALL tiploc values for multi-TIPLOC stations
  describe('AC-4g: getTiplocsByCrs() returns all TIPLOCs for multi-TIPLOC station', () => {
    it('should return multiple tiploc codes when a CRS has multiple matching stations', async () => {
      // Birmingham New Street has multiple platform TIPLOCs
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([
        { tiploc: 'BHAM' },
        { tiploc: 'BHAMNWS' },
      ]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getTiplocsByCrs('BHM');

      expect(result).toEqual(expect.arrayContaining(['BHAM', 'BHAMNWS']));
      expect(result).toHaveLength(2);
    });

    it('should return a single-element array for stations with one TIPLOC', async () => {
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([{ tiploc: 'YORK' }]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getTiplocsByCrs('YRK');

      expect(result).toEqual(['YORK']);
    });

    it('should handle stations where tiploc column is NULL (filters out NULL values)', async () => {
      // Some stations were not seeded with TIPLOCs yet — NULL rows must be excluded
      const TiplocRepository = await loadTiplocRepository();
      const mockDbClient = makeMockDbClient();
      mockDbClient.query.mockResolvedValue([
        { tiploc: null },
      ]);

      const repo = new TiplocRepository({ dbClient: mockDbClient });
      const result = await repo.getTiplocsByCrs('XYZ');

      // NULL tiploc rows should be excluded from results
      expect(result.every((t: string) => t !== null)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5: Rollback migration — DROP delay_tracker.tiploc_crs_mapping
// ---------------------------------------------------------------------------

describe('BL-183 (TD-TIPLOC-STATIONS-001): AC-5 — Migration exists to drop tiploc_crs_mapping', () => {

  // AC-5a: A new forward migration file must exist to drop the fabricated table.
  // Named with a timestamp higher than 1775386062312 so it runs after the add-migration.
  it('AC-5a: A forward migration file to drop tiploc_crs_mapping should exist in migrations/', () => {
    // The migration must be named with a timestamp and contain "drop" or "remove"
    // to identify it clearly as the removal migration.
    const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter(
      (f) => f.endsWith('.cjs') && f.toLowerCase().includes('tiploc')
    );

    // There should be at least 2 tiploc-related migrations:
    // 1. The original add migration (1775386062312_add-tiploc-crs-mapping.cjs)
    // 2. The new drop migration (higher timestamp)
    expect(migrationFiles.length).toBeGreaterThanOrEqual(2);

    // The new drop migration must have a HIGHER timestamp than the add migration
    const dropMigrations = migrationFiles.filter(
      (f) => f.toLowerCase().includes('drop') || f.toLowerCase().includes('remove')
    );
    expect(dropMigrations.length).toBeGreaterThanOrEqual(1);
  });

  // AC-5b: The new migration's up() function must DROP the tiploc_crs_mapping table.
  it('AC-5b: The drop migration up() should DROP TABLE delay_tracker.tiploc_crs_mapping', () => {
    const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter(
      (f) =>
        f.endsWith('.cjs') &&
        f.toLowerCase().includes('tiploc') &&
        (f.toLowerCase().includes('drop') || f.toLowerCase().includes('remove'))
    );

    // Must have found at least one drop migration
    expect(migrationFiles.length).toBeGreaterThanOrEqual(1);

    const dropMigrationContent = fs.readFileSync(
      path.join(MIGRATIONS_DIR, migrationFiles[0]),
      'utf-8'
    );

    // The up() function must drop the tiploc_crs_mapping table
    expect(dropMigrationContent).toContain('tiploc_crs_mapping');
    const hasDropTable =
      dropMigrationContent.includes('DROP TABLE') ||
      dropMigrationContent.includes('dropTable');
    expect(hasDropTable).toBe(true);
  });

  // AC-5c: The drop migration timestamp must be higher than the add migration timestamp
  // so it runs after the add migration in migration order.
  it('AC-5c: Drop migration timestamp should be greater than 1775386062312 (add migration)', () => {
    const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter(
      (f) =>
        f.endsWith('.cjs') &&
        f.toLowerCase().includes('tiploc') &&
        (f.toLowerCase().includes('drop') || f.toLowerCase().includes('remove'))
    );

    expect(migrationFiles.length).toBeGreaterThanOrEqual(1);

    // Extract timestamp from filename (first numeric sequence)
    const timestampMatch = migrationFiles[0].match(/^(\d+)_/);
    expect(timestampMatch).not.toBeNull();

    const dropTimestamp = parseInt(timestampMatch![1], 10);
    const addTimestamp = 1775386062312;

    expect(dropTimestamp).toBeGreaterThan(addTimestamp);
  });
});

// ---------------------------------------------------------------------------
// AC-6: SequentialLegWalk still accepts the TiplocRepository interface
// (interface is unchanged — only the concrete implementation changes)
// ---------------------------------------------------------------------------

describe('BL-183 (TD-TIPLOC-STATIONS-001): AC-6 — SequentialLegWalk accepts new TiplocRepository', () => {

  it('AC-6a: TiplocRepository should expose getCrsByTiploc and getTiplocsByCrs interface methods', async () => {
    const TiplocRepository = await loadTiplocRepository();
    const mockDbClient = makeMockDbClient();
    const repo = new TiplocRepository({ dbClient: mockDbClient });

    // The interface requires: getCrsByTiploc and getTiplocsByCrs
    // Verify the concrete implementation exposes both methods
    expect(typeof repo.getCrsByTiploc).toBe('function');
    expect(typeof repo.getTiplocsByCrs).toBe('function');
  });

  it('AC-6b: TiplocRepository should be usable as the tiplocRepository dep in SequentialLegWalk constructor', async () => {
    const TiplocRepository = await loadTiplocRepository();

    // Import SequentialLegWalk to verify it still accepts the same interface
    const { SequentialLegWalk } = await import(
      '../../../src/services/sequential-leg-walk.js'
    );

    const mockDbClient = makeMockDbClient();
    mockDbClient.query.mockResolvedValue([{ crs_code: 'MAN' }]);

    const repo = new TiplocRepository({ dbClient: mockDbClient });

    const mockDarwinClient = {
      getServiceWithStops: vi.fn().mockResolvedValue({ status: 'no_data' }),
    };
    const mockOtpClient = {
      findReplacementRoute: vi.fn().mockResolvedValue(null),
    };

    // SequentialLegWalk should accept a TiplocRepository as its tiplocRepository dep
    // without any TypeScript errors or runtime failures
    const slw = new SequentialLegWalk({
      tiplocRepository: repo,
      darwinClient: mockDarwinClient,
      otpClient: mockOtpClient,
    });

    expect(slw).toBeDefined();

    // Verify the repository is wired through correctly — resolveTiplocToCrs
    // delegates to tiplocRepository.getCrsByTiploc which hits our mock DB
    const crs = await slw.resolveTiplocToCrs('MNCRPIC');
    expect(mockDbClient.query).toHaveBeenCalled();
    expect(crs).toBe('MAN');
  });
});

// ---------------------------------------------------------------------------
// AC-10: seed-data handling
//
// RECONCILED under TD-DT-SEED (2026-07-10, Test Lock).
// AC-10a/b originally asserted migrations/seed-data/ must be DELETED. That
// requirement contradicted AC-10c (keep the add-tiploc-crs-mapping migration
// for audit trail): the retained migration reads seed-data/tiploc-crs-mapping.json
// at runtime, so deleting the file made every FRESH-database deploy die with
// ENOENT in 1775386062312_add-tiploc-crs-mapping.cjs (dev deploy 2026-07-10).
// The corrected requirement: the seed file must SHIP for as long as the
// migration that reads it exists. The original AC-10 intent — fabricated data
// must not be a runtime source — is still enforced by the drop migration
// (1775386100000) and the TiplocRepository stations-source tests above.
// See tests/migrations/TD-DT-SEED-seed-data-presence.test.ts for the full
// shape/content assertions.
// ---------------------------------------------------------------------------

describe('BL-183 (TD-TIPLOC-STATIONS-001): AC-10 — seed-data handling (reconciled under TD-DT-SEED)', () => {

  // AC-10a/b (reconciled): the seed file must exist because the retained
  // migration (AC-10c) reads it at runtime on every fresh database.
  it('AC-10a/b (reconciled): migrations/seed-data/tiploc-crs-mapping.json must ship while migration 1775386062312 reads it', () => {
    const fileExists = fs.existsSync(SEED_DATA_FILE);
    expect(fileExists).toBe(true);
    const dirExists = fs.existsSync(SEED_DATA_DIR);
    expect(dirExists).toBe(true);
  });

  // AC-10c: The original add-tiploc-crs-mapping migration file must be retained
  // for migration history audit trail. Blake must NOT delete it.
  it('AC-10c: The add-tiploc-crs-mapping migration file should still exist (historical record)', () => {
    // We keep the original migration file for historical audit trail.
    // The new drop migration supersedes it in the forward direction.
    const oldMigrationExists = fs.existsSync(OLD_MIGRATION);
    expect(oldMigrationExists).toBe(true);
  });
});
