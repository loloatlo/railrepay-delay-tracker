/**
 * Test Fixtures: TIPLOC↔CRS Mapping
 *
 * Source: RFC-007 — tiploc_crs_mapping table (BL-181 TD-DELAY-CALC-001)
 * Governing Decision: ADR-021 — Fundamental Delay Equation
 * Purpose: Provide realistic test data for delay-tracker Sequential Leg Walk algorithm tests
 *
 * IMPORTANT: These fixtures use real TIPLOC and CRS codes from NaPTAN/CORPUS data.
 * They are a representative subset; the full table has ~2,600 rows.
 */

export interface TiplocCrsMappingFixture {
  tiploc_code: string;   // VARCHAR(7) PRIMARY KEY — Darwin/Network Rail internal code
  crs_code: string;      // CHAR(3) — National Rail customer-facing code
  station_name: string | null;
}

// ---------------------------------------------------------------------------
// Happy path: major interchange stations used in Sequential Leg Walk tests
// ---------------------------------------------------------------------------

/** London Kings Cross — LNER/Thameslink major terminus */
export const kingssCross: TiplocCrsMappingFixture = {
  tiploc_code: 'KNGSCRS',
  crs_code: 'KGX',
  station_name: 'London Kings Cross',
};

/** Manchester Piccadilly — primary Manchester terminus */
export const manchesterPiccadilly: TiplocCrsMappingFixture = {
  tiploc_code: 'MNCRPIC',
  crs_code: 'MAN',
  station_name: 'Manchester Piccadilly',
};

/** Edinburgh Waverley — primary Scottish terminus */
export const edinburghWaverley: TiplocCrsMappingFixture = {
  tiploc_code: 'EDINBGH',
  crs_code: 'EDB',
  station_name: 'Edinburgh Waverley',
};

/** Leeds — key Northern interchange */
export const leeds: TiplocCrsMappingFixture = {
  tiploc_code: 'LEEDS',
  crs_code: 'LDS',
  station_name: 'Leeds',
};

/** York — major East Coast Main Line interchange */
export const york: TiplocCrsMappingFixture = {
  tiploc_code: 'YORK',
  crs_code: 'YRK',
  station_name: 'York',
};

/** London Euston — West Coast Main Line terminus */
export const euston: TiplocCrsMappingFixture = {
  tiploc_code: 'EUSTN',
  crs_code: 'EUS',
  station_name: 'London Euston',
};

/** London Paddington — GWR terminus */
export const paddington: TiplocCrsMappingFixture = {
  tiploc_code: 'PADDGTN',
  crs_code: 'PAD',
  station_name: 'London Paddington',
};

/** Bristol Temple Meads — GWR/CrossCountry hub */
export const bristolTempleMeads: TiplocCrsMappingFixture = {
  tiploc_code: 'BRISLT',
  crs_code: 'BRI',
  station_name: 'Bristol Temple Meads',
};

/** Cardiff Central — TfW hub (used in real-world regression case from BL-181) */
export const cardiffCentral: TiplocCrsMappingFixture = {
  tiploc_code: 'CARDIFF',
  crs_code: 'CDF',
  station_name: 'Cardiff Central',
};

/** Newcastle — ECML northern hub */
export const newcastle: TiplocCrsMappingFixture = {
  tiploc_code: 'NEWCSTL',
  crs_code: 'NCL',
  station_name: 'Newcastle',
};

/** Clapham Junction — busiest interchange in UK */
export const claphamJunction: TiplocCrsMappingFixture = {
  tiploc_code: 'CLPHMJN',
  crs_code: 'CLJ',
  station_name: 'Clapham Junction',
};

/** London St Pancras — HS1/Midland Mainline terminus */
export const stPancras: TiplocCrsMappingFixture = {
  tiploc_code: 'STPNCRS',
  crs_code: 'STP',
  station_name: 'London St Pancras International',
};

// ---------------------------------------------------------------------------
// Edge case: station with multiple TIPLOC codes for the same CRS
// (Birmingham has BHAM for New Street; both BHAM and BHAMCS → BHM/BMO)
// ---------------------------------------------------------------------------

/** Birmingham New Street — TIPLOC BHAM */
export const birminghamNewStreet: TiplocCrsMappingFixture = {
  tiploc_code: 'BHAM',
  crs_code: 'BHM',
  station_name: 'Birmingham New Street',
};

// ---------------------------------------------------------------------------
// Edge case: null station_name (allowed — field is informational only)
// ---------------------------------------------------------------------------

/** Synthetic row with null station_name — tests nullable column behaviour */
export const tiplocWithNullName: TiplocCrsMappingFixture = {
  tiploc_code: 'TPLCNUL',
  crs_code: 'ZZZ',
  station_name: null,
};

// ---------------------------------------------------------------------------
// Convenience collections
// ---------------------------------------------------------------------------

/** All interchange stations used in happy-path Sequential Leg Walk tests */
export const majorInterchangeFixtures: TiplocCrsMappingFixture[] = [
  kingssCross,
  manchesterPiccadilly,
  edinburghWaverley,
  leeds,
  york,
  euston,
  paddington,
  bristolTempleMeads,
  cardiffCentral,
  newcastle,
  claphamJunction,
  stPancras,
  birminghamNewStreet,
];

/** All fixtures including edge cases */
export const allTiplocFixtures: TiplocCrsMappingFixture[] = [
  ...majorInterchangeFixtures,
  tiplocWithNullName,
];

// ---------------------------------------------------------------------------
// Sample extraction queries for Jessie (ADR-017 requirement)
// ---------------------------------------------------------------------------
//
// Run these via Postgres MCP after migration to extract representative rows:
//
// -- Happy path: lookup by TIPLOC (Darwin's native identifier)
// SELECT tiploc_code, crs_code, station_name
// FROM delay_tracker.tiploc_crs_mapping
// WHERE tiploc_code = 'MNCRPIC';
//
// -- Reverse lookup: CRS → all TIPLOC codes (for stations with multiple TIPLOCs)
// SELECT tiploc_code, crs_code, station_name
// FROM delay_tracker.tiploc_crs_mapping
// WHERE crs_code = 'MAN';
//
// -- Edge case: null station_name rows
// SELECT tiploc_code, crs_code
// FROM delay_tracker.tiploc_crs_mapping
// WHERE station_name IS NULL
// LIMIT 3;
//
// -- Volume check: confirm seed data loaded
// SELECT COUNT(*) AS total_rows,
//        COUNT(DISTINCT crs_code) AS distinct_crs,
//        COUNT(*) FILTER (WHERE station_name IS NULL) AS null_names
// FROM delay_tracker.tiploc_crs_mapping;
//
// -- Boundary value: maximum-length TIPLOC code (7 chars)
// SELECT tiploc_code, length(tiploc_code) AS code_length
// FROM delay_tracker.tiploc_crs_mapping
// WHERE length(tiploc_code) = 7
// LIMIT 5;

export default {
  kingssCross,
  manchesterPiccadilly,
  edinburghWaverley,
  leeds,
  york,
  euston,
  paddington,
  bristolTempleMeads,
  cardiffCentral,
  newcastle,
  claphamJunction,
  stPancras,
  birminghamNewStreet,
  tiplocWithNullName,
  majorInterchangeFixtures,
  allTiplocFixtures,
};
