/**
 * strip-gtfs-prefix.ts
 *
 * Vendored from @railrepay/gtfs-utils (BL-179).
 *
 * Strips the GTFS feed-index prefix from a RID (Run ID).
 *
 * GTFS data carries RIDs with a numeric feed-index prefix separated by a
 * colon (e.g. "1:202603117664795"). Darwin Ingestor stores bare RIDs
 * ("202603117664795"). This function normalises the format so lookups succeed.
 *
 * Pattern: /^\d+:/ — one or more leading digits followed by a colon.
 * Examples:
 *   "1:202603117664795"  → "202603117664795"
 *   "12:202601150800123" → "202601150800123"
 *   "202603117664795"    → "202603117664795" (no-op, already bare)
 *   "AB:RID"             → "AB:RID"           (no-op, not a digit prefix)
 *   null                 → null
 *   undefined            → undefined
 *
 * TD: Consolidate to npm-published @railrepay/gtfs-utils package.
 * See Backlog for follow-up TD item.
 */

export function stripGtfsPrefix(value: string): string;
export function stripGtfsPrefix(value: null): null;
export function stripGtfsPrefix(value: undefined): undefined;
export function stripGtfsPrefix(value: string | null | undefined): string | null | undefined;
export function stripGtfsPrefix(value: string | null | undefined): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return value.replace(/^\d+:/, '');
}
