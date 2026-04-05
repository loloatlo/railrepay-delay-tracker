/**
 * TiplocRepository
 *
 * BL-183 (TD-TIPLOC-STATIONS-001) — AC-4, AC-6
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation
 * Governing ADR: ADR-001 — Schema-per-service (cross-schema SELECT permitted for reads)
 *
 * Replaces the fabricated delay_tracker.tiploc_crs_mapping table (BL-181)
 * with a correct implementation that queries timetable_loader.stations,
 * which holds ~3,500+ real TIPLOC↔CRS mappings seeded from Darwin reference data.
 *
 * The TiplocRepository interface in sequential-leg-walk.ts is UNCHANGED.
 * Only this concrete implementation changes.
 */

export interface TiplocRepositoryDeps {
  dbClient: {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  };
}

/**
 * TiplocRepository queries timetable_loader.stations for TIPLOC↔CRS mappings.
 *
 * Cross-schema SELECT is permitted per ADR-001.
 */
export class TiplocRepository {
  private dbClient: TiplocRepositoryDeps['dbClient'];

  constructor(deps: TiplocRepositoryDeps) {
    this.dbClient = deps.dbClient;
  }

  /**
   * Look up a CRS code for a given TIPLOC code.
   * Returns null if no matching station is found.
   */
  async getCrsByTiploc(tiplocCode: string): Promise<string | null> {
    const rows = await this.dbClient.query<{ crs_code: string }>(
      'SELECT crs_code FROM timetable_loader.stations WHERE tiploc = $1',
      [tiplocCode],
    );

    if (rows.length === 0) {
      return null;
    }

    return rows[0].crs_code;
  }

  /**
   * Look up all TIPLOC codes for a given CRS code.
   * Returns an empty array if no matching stations are found.
   * Filters out rows where tiploc IS NULL (stations not yet seeded with TIPLOC data).
   */
  async getTiplocsByCrs(crsCode: string): Promise<string[]> {
    const rows = await this.dbClient.query<{ tiploc: string | null }>(
      'SELECT tiploc FROM timetable_loader.stations WHERE crs_code = $1 AND tiploc IS NOT NULL',
      [crsCode],
    );

    return rows
      .map((row) => row.tiploc)
      .filter((tiploc): tiploc is string => tiploc !== null);
  }
}
