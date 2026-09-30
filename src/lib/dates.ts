// Single source of truth for date normalization between JS-land and SQLite-land.
//
// SQLite's `datetime('now')` returns 'YYYY-MM-DD HH:MM:SS' (space-separated, UTC).
// JS's `Date.toISOString()` returns 'YYYY-MM-DDTHH:MM:SS.sssZ'.
// Comparing the two as strings breaks at character 10 ('T' (0x54) > ' ' (0x20)), so
// `WHERE valid_until > datetime('now')` against an ISO-T value silently excludes rows
// that should match. All writers must funnel through here.

export function toSqliteDate(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;

  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === 'number') {
    d = new Date(value);
  } else {
    // Already in SQLite form? Pass through unchanged.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
    d = new Date(value);
  }

  if (Number.isNaN(d.getTime())) return null;

  // 'YYYY-MM-DDTHH:MM:SS.sssZ' → 'YYYY-MM-DD HH:MM:SS' (UTC).
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
