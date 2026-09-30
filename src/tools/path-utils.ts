import { resolve, normalize } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

/**
 * Centralized guardrails for file-touching tools — read_context_file,
 * write_context_file, list_repo_files, git_commit_summary, spawn_codex,
 * save_jd_analysis. Rejects path traversal and obvious secret patterns; gates
 * absolute reads to a small allowlist of GitHub repo roots so a runaway tool
 * call can't grep `/etc/passwd` or read another project's `.env`.
 */

const GH_ROOT = process.env.ASSISTANT_GH_ROOT
  || `${homedir()}/GitHub`;

// Repos assistant tools may read/write into. Set ASSISTANT_ALLOWED_REPOS in .env
// (comma-separated) to allowlist your own sibling projects. Defaults to just
// this repo so a fresh deploy can't be steered into reading arbitrary folders.
const ALLOWED_REPOS_RAW = process.env.ASSISTANT_ALLOWED_REPOS || 'assistant';

export const ALLOWED_REPO_ROOTS: string[] = ALLOWED_REPOS_RAW
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => resolve(GH_ROOT, r));

// Files assistant must never read, regardless of which repo they live in.
// Match against the *basename* and against suffix patterns.
const SECRET_BASENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.test',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials.json', 'service-account.json', 'gcloud-key.json',
  '.netrc', '.npmrc', '.pypirc',
]);
const SECRET_SUFFIXES = ['.pem', '.p12', '.pfx', '.key', '.crt', '.cer', '.jks', '.keystore'];
const SECRET_PREFIXES = ['.env.'];  // .env.* — backups, .env.local, etc.

function basename(p: string): string {
  const norm = normalize(p);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function looksLikeSecret(p: string): boolean {
  const b = basename(p);
  if (SECRET_BASENAMES.has(b)) return true;
  for (const s of SECRET_SUFFIXES) if (b.endsWith(s)) return true;
  for (const pfx of SECRET_PREFIXES) if (b.startsWith(pfx)) return true;
  return false;
}

function withinAnyRoot(abs: string): string | null {
  for (const root of ALLOWED_REPO_ROOTS) {
    if (abs === root || abs.startsWith(root + '/')) return root;
  }
  return null;
}

export interface ResolveOpts {
  /** Allow paths under the assistant repo only (for context-file writes). */
  assistantOnly?: boolean;
  /** Skip the secret-file check (e.g., for reading a documented config). Use sparingly. */
  allowSecrets?: boolean;
}

/**
 * Resolves `inputPath` to an absolute path under an allowed repo root.
 * Throws on:
 *   - paths that escape the GitHub root after normalization
 *   - paths outside the allowlist
 *   - paths whose basename matches a secret pattern (unless allowSecrets)
 * Returns the absolute, normalized path.
 */
export function resolveSafePath(inputPath: string, opts: ResolveOpts = {}): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('path-utils: empty or non-string path');
  }
  const abs = resolve(inputPath.startsWith('/') ? inputPath : `${GH_ROOT}/${inputPath}`);
  // Normalize() in resolve() collapses `..` — anything that escapes is detectable
  // by checking the result against the allowed roots.
  const root = withinAnyRoot(abs);
  if (!root) {
    throw new Error(`path-utils: ${abs} is outside the allowed repo roots`);
  }
  if (opts.assistantOnly) {
    const assistant = resolve(GH_ROOT, 'assistant');
    if (root !== assistant) {
      throw new Error(`path-utils: ${abs} is not under assistant (assistantOnly)`);
    }
  }
  if (!opts.allowSecrets && looksLikeSecret(abs)) {
    throw new Error(`path-utils: ${abs} matches a secret-file pattern`);
  }
  return abs;
}

/**
 * For tools that take a repo name (not a path) — e.g. git_commit_summary
 * or spawn_codex. Returns the resolved absolute repo root on success.
 */
export function validateRepoName(name: string): string {
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`path-utils: invalid repo name "${name}" (allowed: A-Z, a-z, 0-9, _, -)`);
  }
  const abs = resolve(GH_ROOT, name);
  if (!withinAnyRoot(abs)) {
    throw new Error(`path-utils: repo "${name}" is not in the allowlist`);
  }
  return abs;
}

/**
 * Slugify a JD analysis filename. Used by `save_jd_analysis`. Produces
 * `YYYY-MM-DD-company-role` with strict alphanumeric + hyphen so the
 * filename and the corresponding fact subject are guaranteed to match.
 */
export function slugifyForAnalysis(date: string, company: string, role: string): string {
  const clean = (s: string) =>
    s.toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')   // strip combining marks
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  const c = clean(company) || 'unknown';
  const r = clean(role) || 'unknown';
  return `${date}-${c}-${r}`;
}

/**
 * Slug-only variant used as a fact subject. Drops the date prefix so the
 * subject is stable across re-analyses.
 */
export function subjectFromAnalysis(company: string, role: string): string {
  const slug = slugifyForAnalysis('', company, role);
  return slug.replace(/^-/, '');
}

// Tier 1 Phase 3 — content drafts live OUTSIDE any tracked git repo so
// `sync-repos.sh` never races a `git pull` against our local writes. We
// deliberately do NOT add a content repo to ALLOWED_REPOS — drafts get
// their own root, gated by ASSISTANT_DRAFTS_ROOT (default ~/assistant-drafts).

const DRAFTS_ROOT = process.env.ASSISTANT_DRAFTS_ROOT || `${homedir()}/assistant-drafts`;

function slugForDraft(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Resolve a path under ASSISTANT_DRAFTS_ROOT for a content draft. Creates the
 * `<root>/<kind>` directory if missing. Validates the resolved path stays
 * under the root after normalization (so a malicious title like
 * `../../etc/passwd` is rejected via the slug step + a final root check).
 *
 * Returns the absolute path; caller is responsible for writing the file.
 */
export function draftsPath(kind: 'linkedin' | 'newsletter', title: string, dateOverride?: string): string {
  if (!kind || (kind !== 'linkedin' && kind !== 'newsletter')) {
    throw new Error(`path-utils: invalid draft kind "${kind}"`);
  }
  const slug = slugForDraft(title);
  if (!slug) {
    throw new Error('path-utils: draft title produced an empty slug');
  }
  const date = dateOverride || new Date().toISOString().slice(0, 10);
  const dir = resolve(DRAFTS_ROOT, kind);
  const filename = `${date}-${slug}.md`;
  const full = resolve(dir, filename);
  // Defense in depth: even though slugify scrubs path separators, confirm the
  // final resolved path is still inside the drafts root.
  const rootAbs = resolve(DRAFTS_ROOT);
  if (!full.startsWith(rootAbs + '/')) {
    throw new Error(`path-utils: resolved draft path ${full} escapes drafts root`);
  }
  mkdirSync(dir, { recursive: true });
  return full;
}

export { DRAFTS_ROOT };
