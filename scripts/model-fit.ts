import 'dotenv/config';
import { execSync } from 'child_process';

/**
 * Odysseus Experiment 2: the hardware-aware model-fit oracle.
 *
 * Answers "which local model should Ollama serve on THIS machine" from the
 * chip's memory bandwidth and unified RAM — the two numbers that actually bound
 * local-LLM quality and speed on Apple Silicon. Scoring follows the Odysseus
 * Cookbook weights: quality 45%, speed 30%, fit 15%, context 10%.
 *
 * Run ON the mini (it reads the local hardware): npm run model:fit
 *   --dry  print the verdict without recording the decision fact
 *
 * Unless --dry, the verdict is saved as a `decision` fact (subject "local llm")
 * so it's retrievable in chat and supersedes cleanly on re-runs as new models
 * ship. On a non-Mac (or a machine without sysctl) it prints a note and exits
 * without writing anything.
 */

const DRY = process.argv.includes('--dry');
// launchd/dev-box PATHs differ; pin the binary like CLICLICK_BIN/SIPS_BIN do.
const SYSCTL_BIN = process.env.SYSCTL_BIN || '/usr/sbin/sysctl';

// Apple Silicon memory bandwidth, GB/s. Longest-match wins ("M4 Pro" before "M4").
const BANDWIDTH: Array<[string, number]> = [
  ['M1 Ultra', 800], ['M1 Max', 400], ['M1 Pro', 200], ['M1', 68],
  ['M2 Ultra', 800], ['M2 Max', 400], ['M2 Pro', 200], ['M2', 100],
  ['M3 Ultra', 819], ['M3 Max', 400], ['M3 Pro', 150], ['M3', 100],
  ['M4 Max', 546], ['M4 Pro', 273], ['M4', 120],
];

interface Candidate {
  tag: string;        // ollama pull tag
  weightsGB: number;  // q4_K_M on-disk/loaded size
  activeGB: number;   // weights the token loop actually streams (≠ weightsGB for MoE)
  quality: number;    // 0-100, rough instruction-following/extraction quality tier
  ctxK: number;       // practical context window (K tokens)
}

// A small, opinionated table — extraction/classification workloads, q4_K_M.
const CANDIDATES: Candidate[] = [
  { tag: 'llama3.2:3b',   weightsGB: 2.0,  activeGB: 2.0,  quality: 45, ctxK: 128 },
  { tag: 'llama3.1:8b',   weightsGB: 4.9,  activeGB: 4.9,  quality: 58, ctxK: 128 },
  { tag: 'qwen3:8b',      weightsGB: 5.2,  activeGB: 5.2,  quality: 63, ctxK: 40 },
  { tag: 'gemma3:12b',    weightsGB: 8.1,  activeGB: 8.1,  quality: 68, ctxK: 128 },
  { tag: 'qwen3:14b',     weightsGB: 9.3,  activeGB: 9.3,  quality: 72, ctxK: 40 },
  { tag: 'qwen3:30b-a3b', weightsGB: 18.6, activeGB: 2.1,  quality: 75, ctxK: 40 }, // MoE: 30B loaded, ~3B active
];

const KV_OVERHEAD_GB = 2.5;   // 16k ctx KV cache + Ollama runtime
const SYSTEM_HEADROOM_GB = 6; // macOS + the assistant stack itself

function readHardware(): { chip: string; ramGB: number } | null {
  try {
    const chip = execSync(`${SYSCTL_BIN} -n machdep.cpu.brand_string`, { stdio: 'pipe' }).toString().trim();
    const bytes = Number(execSync(`${SYSCTL_BIN} -n hw.memsize`, { stdio: 'pipe' }).toString().trim());
    if (!chip || Number.isNaN(bytes) || bytes <= 0) return null;
    return { chip, ramGB: Math.round(bytes / 1024 ** 3) };
  } catch {
    return null;
  }
}

function bandwidthFor(chip: string): number | null {
  for (const [name, gbps] of BANDWIDTH) {
    if (chip.includes(name)) return gbps;
  }
  return null;
}

const hw = readHardware();
if (!hw) {
  console.log('[model-fit] Not an Apple Silicon Mac (or sysctl unavailable) — nothing to score, nothing written.');
  console.log('[model-fit] Run this on the mini: npm run model:fit');
  process.exit(0);
}

const bw = bandwidthFor(hw.chip);
if (bw === null) {
  console.log(`[model-fit] Unrecognized chip "${hw.chip}" — bandwidth table needs a new row. Nothing written.`);
  process.exit(0);
}

const budgetGB = hw.ramGB - SYSTEM_HEADROOM_GB;
const scored = CANDIDATES
  .map((c) => {
    const needGB = c.weightsGB + KV_OVERHEAD_GB;
    const fits = needGB <= budgetGB;
    const tight = !fits && needGB <= budgetGB * 1.1;
    // Token generation is memory-bandwidth-bound: tok/s ≈ bandwidth / active bytes.
    const tokPerSec = bw / c.activeGB;
    return { ...c, needGB, fits, tight, tokPerSec };
  })
  .filter((c) => c.fits || c.tight);

if (scored.length === 0) {
  console.log(`[model-fit] ${hw.chip} / ${hw.ramGB}GB: no candidate fits alongside the stack. Nothing written.`);
  process.exit(0);
}

const maxTok = Math.max(...scored.map((c) => c.tokPerSec));
const ranked = scored
  .map((c) => ({
    ...c,
    score:
      0.45 * (c.quality / 100) +
      0.30 * (c.tokPerSec / maxTok) +
      0.15 * (c.fits ? 1 : 0.5) +
      0.10 * (c.ctxK >= 32 ? 1 : 0.5),
  }))
  .sort((a, b) => b.score - a.score);

console.log(`[model-fit] ${hw.chip} · ${hw.ramGB}GB unified RAM · ~${bw} GB/s bandwidth · model budget ${budgetGB}GB\n`);
for (const c of ranked) {
  console.log(
    `  ${c.score.toFixed(3)}  ${c.tag.padEnd(14)} q=${c.quality}  ~${Math.round(c.tokPerSec)} tok/s  needs ${c.needGB.toFixed(1)}GB${c.fits ? '' : ' (TIGHT)'}`,
  );
}

const winner = ranked[0];
const endpoint = process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434';
const verdict = `the mini is ${hw.chip} / ${hw.ramGB}GB; local model = ${winner.tag} (q4) served via Ollama at ${endpoint}`;
console.log(`\n[model-fit] Verdict: ${verdict}`);

const configured = process.env.LOCAL_LLM_MODEL || '';
if (!configured) {
  console.log(`[model-fit] LOCAL_LLM_MODEL is unset — to adopt: ollama pull ${winner.tag}, then set LOCAL_LLM_MODEL=${winner.tag}`);
} else if (configured === winner.tag) {
  console.log(`[model-fit] Configured LOCAL_LLM_MODEL=${configured} matches the recommendation. ✓`);
} else {
  console.log(`[model-fit] Configured LOCAL_LLM_MODEL=${configured}, but the recommendation is ${winner.tag} — consider switching.`);
}

if (DRY) {
  console.log('[model-fit] --dry: decision fact not written.');
  process.exit(0);
}

// Deferred import so the --dry / non-Mac paths never touch the DB.
const { saveFact } = await import('../src/db.js');
const id = saveFact({
  subject: 'local llm',
  predicate: 'model decision',
  object: verdict,
  fact_type: 'decision', // supersedes on (subject, predicate) — re-runs replace cleanly
  source: 'model-fit',
});
console.log(`[model-fit] Recorded decision fact #${id}.`);
