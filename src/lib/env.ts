// Centralized env-var parsing. Before this, the codebase had three different
// boolean conventions (`!== 'false'`, `=== 'false'`, `=== 'true'`), the last of
// which wrongly disabled a feature for any value other than the literal "true".
// These helpers give one consistent meaning everywhere.

const FALSY = new Set(['false', '0', 'no', 'off']);

/**
 * Parse a boolean env var. Undefined/empty → `defaultValue`. Otherwise enabled
 * unless the value is one of false/0/no/off (case-insensitive). So with default
 * `true`, only an explicit falsy value disables; any other value keeps it on.
 */
export function parseBoolEnv(key: string, defaultValue = true): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return !FALSY.has(raw.trim().toLowerCase());
}

/** Parse a numeric env var (int or float). Missing/NaN → `defaultValue`. */
export function parseNumEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

/** Parse a string env var. Missing/empty → `defaultValue`. */
export function parseStrEnv(key: string, defaultValue: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? defaultValue : raw;
}
