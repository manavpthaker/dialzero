// Run: npx tsx scripts/test-computer-use.ts        (from /tmp/assistant-cu)
// Exercises every computer_use path on-device. Importing db.ts auto-creates the
// schema in this worktree's own assistant.db.
//
// v2 changes vs the first harness:
//  - Uses `open -e <file>` to get a GUARANTEED-focused editable doc, instead of
//    `open -a TextEdit` (which doesn't reliably focus a new document — the first
//    run's keystrokes were stolen by a modal permission dialog + an unfocused app).
//  - Derives click coords from the screenshot's reported geometry instead of
//    hardcoding them.
//  - Saves a "before input" and "after input" screenshot to /tmp so the typed
//    text can be confirmed visually.
import { writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { getAction } from '../src/db.js';
import {
  computerUseTools,
  runComputerUseAction,
  computerUseInputAvailable,
} from '../src/tools/computer-use.js';

const handler = computerUseTools[0].handler;
const ctx = { groupKey: 'admin' } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Take a screenshot via the real tool path; save the jpeg, return its geometry.
async function shoot(savePath: string): Promise<{ imageW: number; imageH: number } | null> {
  const shot: any = await handler({ action: 'screenshot' }, ctx);
  if (!Array.isArray(shot)) {
    console.log('  screenshot returned (NOT an image — likely a permission error):', shot);
    return null;
  }
  const img = shot.find((b: any) => b.type === 'image');
  const txt = shot.find((b: any) => b.type === 'text');
  writeFileSync(savePath, Buffer.from(img.source.data, 'base64'));
  console.log('  screenshot text:', txt?.text);
  console.log('  saved', savePath);
  const m = String(txt?.text).match(/image is (\d+)×(\d+)px/);
  return m ? { imageW: Number(m[1]), imageH: Number(m[2]) } : null;
}

// Drive a gated action through the real propose→confirm path: handler stages it
// (returns "Action #N…"), then we fetch + run the executor, exactly as
// confirm_action would. This is the path that needs Accessibility.
async function gated(input: any, label: string) {
  const dm = (await handler(input, ctx)) as string;
  const m = dm.match(/Action #(\d+)/);
  if (!m) { console.log(`[${label}] not staged:`, dm); return; }
  const action = getAction(Number(m[1]))!;
  try {
    const res = await runComputerUseAction(action);
    console.log(`[${label}] executed:`, res.outcome);
  } catch (e) {
    console.log(`[${label}] executor error:`, (e as Error).message);
  }
}

async function main() {
  console.log('cliclick installed?', computerUseInputAvailable());

  // 1. screenshot (free, read-only). With the system_profiler geometry fix this
  //    should now ALWAYS report "image is W×Hpx" on the first call.
  console.log('\n[1] screenshot');
  const geo = await shoot('/tmp/cu-shot.jpg');
  if (!geo) console.log('  ⚠️  no geometry reported — clicks would be unavailable.');
  else console.log(`  ✓ geometry OK: ${geo.imageW}×${geo.imageH}px`);

  // 2. focused editable doc via `open -e` (no Finder AppleEvent, no modal).
  console.log('\n[2] open a focused TextEdit doc');
  writeFileSync('/tmp/cu-harness.txt', '');          // create the file first
  execFileSync('/usr/bin/open', ['-e', '/tmp/cu-harness.txt'], { stdio: 'ignore' });
  await sleep(2500);                                  // let TextEdit focus the text view

  // 3. type + key_press (gated) into the focused doc.
  console.log('\n[3] type + key_press into the doc');
  await gated({ action: 'type', text: 'assistant computer_use OK' }, 'type');
  await sleep(400);
  await gated({ action: 'key_press', key: 'return' }, 'key_press');
  await sleep(400);

  // 4. PROOF screenshot — should show the typed text in the doc.
  console.log('\n[4] proof screenshot (look for the typed text)');
  await shoot('/tmp/cu-after.jpg');

  // 5. click (gated) at screen center, derived from geometry. Watch the cursor.
  console.log('\n[5] click at image center');
  if (geo) await gated({ action: 'click', x: Math.round(geo.imageW / 2), y: Math.round(geo.imageH / 2) }, 'click');
  else console.log('  skipped (no geometry).');
  await sleep(400);

  // 6. scroll (gated).
  console.log('\n[6] scroll');
  await gated({ action: 'scroll', direction: 'down', amount: 2 }, 'scroll');

  // 7. switch_app (free) — now via `open -a`, no Automation consent.
  console.log('\n[7] switch_app → Finder');
  console.log(' ', await handler({ action: 'switch_app', app: 'Finder' }, ctx));
}
main();
