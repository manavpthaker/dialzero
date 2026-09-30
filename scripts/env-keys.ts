import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Finds every environment variable the shipped code reads, so the generated
// .env.example (npm run env:example) can prove it documents all of them.
// Test scripts are skipped: they set fixture values, not user settings.

const PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /\benv\??\.([A-Z][A-Z0-9_]{2,})\b/g,
  /\b(?:parseBoolEnv|parseNumEnv|parseStrEnv|env|num|requireEnv)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
];
const MCP_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]+)\}/g;

/** Read by the OS or the shell, not settings a user writes in .env. */
export const IGNORED_ENV_KEYS = new Set(['HOME', 'PATH', 'USER', 'SHELL', 'TMPDIR', 'NODE_ENV']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(path);
  }
}

export function scanEnvKeys(root: string): Map<string, string[]> {
  const files: string[] = [];
  walk(join(root, 'src'), files);
  walk(join(root, 'scripts'), files);
  files.push(join(root, 'mcp-servers.json'));
  const found = new Map<string, string[]>();
  for (const file of files) {
    const rel = relative(root, file);
    if (/^scripts\/test-/.test(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const re of rel.endsWith('.json') ? [MCP_PLACEHOLDER] : PATTERNS) {
      for (const m of text.matchAll(re)) {
        const key = m[1];
        if (IGNORED_ENV_KEYS.has(key)) continue;
        const where = found.get(key) ?? [];
        if (!where.includes(rel)) where.push(rel);
        found.set(key, where);
      }
    }
  }
  return found;
}
