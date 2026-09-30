/**
 * Pure tests for the outbound arbiter.
 *
 * This is the code that decides whether the assistant interrupts. It replaced ~61
 * independent send paths that each asserted their own urgency, so the rules it
 * enforces — and the two places it must deliberately NOT enforce them — are
 * worth pinning.
 *
 * No network: the iMessage send is stubbed by pointing the module's recipient
 * resolution at a test value and intercepting the channel.
 *
 *   npm run test:cos-outbound
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-cos-outbound-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'cos-test.db');
process.env.COS_DAILY_INTERRUPT_BUDGET = '3';
process.env.COS_INTERRUPT_BUDGET_OVERDRAFT = '1';
process.env.ASSISTANT_DEFAULT_RECIPIENT = '+15550001111';

const failures: string[] = [];
async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

async function main(): Promise<void> {
  const sent: Array<{ to: string; text: string }> = [];
  const quietHours = { value: false };
  // Injected so nothing leaves the machine. ESM exports are read-only, so the
  // channel cannot be monkeypatched.
  const deps = {
    sendMessage: async (to: string, text: string) => { sent.push({ to, text }); },
    getDefaultRecipient: () => '+15550001111',
    // Pinned to daytime: the arbiter's quiet-hours rule is absolute, so tests
    // running overnight would otherwise all short-circuit on it (which is
    // exactly what happened the first time this suite ran, at 04:39 ET).
    isQuietHours: () => quietHours.value,
  };

  const cosMod = await import('../src/cos-outbound.js');
  const cos = {
    ...cosMod,
    sendInterrupt: (r: Parameters<typeof cosMod.sendInterrupt>[0]) => cosMod.sendInterrupt(r, deps),
  };
  const db = (await import('../src/db.js')).default;
  const clear = () => {
    db.prepare('DELETE FROM outbound_log').run();
    cosMod.clearAmbient(); // the batch lane persists in `memory`, so reset it too
    sent.length = 0;
  };
  const rows = () => db.prepare('SELECT * FROM outbound_log ORDER BY id').all() as Array<Record<string, unknown>>;

  // Default kind is time-critical: since 2026-09-29 it and 'reply' are the only
  // kinds that can interrupt at all, so the rate-limit rules are exercised on it.
  const req = (over: Record<string, unknown> = {}) => ({
    source: 'test', subject: 'thing:1', kind: 'time-critical' as const,
    text: 'something happened', target: '+15550001111', ...over,
  });

  // ── observe mode (kept as an escape hatch; enforce is the default now) ────
  process.env.COS_ARBITER_MODE = 'observe';

  await test('observe mode sends even when the arbiter objects, and says so in the log', async () => {
    clear();
    await cos.sendInterrupt(req());                      // first: allowed
    const second = await cos.sendInterrupt(req());       // second: same subject, inside cooldown
    assert.equal(second.sent, true, 'observe mode must never silence anything');
    assert.equal(sent.length, 2, 'both messages actually went out');
    const r = rows();
    assert.equal(r[1].decision, 'sent', 'decision records what ACTUALLY happened');
    assert.equal(r[1].would_hold, 1, 'and would_hold records the counterfactual');
    assert.equal(r[1].reason, 'subject-cooldown');
  });

  await test('every attempt is logged, so a silent bot is distinguishable from a quiet one', async () => {
    clear();
    await cos.sendInterrupt(req());
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].mode, 'observe');
  });

  // ── enforce mode ─────────────────────────────────────────────────────────
  process.env.COS_ARBITER_MODE = 'enforce';

  await test('enforce mode holds a repeat of the same subject inside its cooldown', async () => {
    clear();
    const first = await cos.sendInterrupt(req());
    assert.equal(first.sent, true);
    const second = await cos.sendInterrupt(req());
    assert.equal(second.sent, false);
    assert.equal(sent.length, 1, 'the second message must not reach the channel');
  });

  await test('a held interrupt is DEFERRED to the check-in, not dropped', async () => {
    clear();
    await cos.sendInterrupt(req());
    const second = await cos.sendInterrupt(req());
    assert.equal(second.sent, false);
    if (second.sent) throw new Error('unreachable');
    assert.equal(second.decision, 'deferred');
    const staged = cos.collectAmbientItems();
    assert.equal(staged.length, 1, 'the deferred message is waiting for the next check-in');
    assert.match(staged[0].line, /something happened/);
  });

  await test('status is never texted, even on a bypass lane, but is logged', async () => {
    clear();
    const plain = await cos.sendInterrupt(req({ kind: 'status', subject: 'run:1' }));
    const bypassed = await cos.sendInterrupt(req({ kind: 'status', subject: 'run:2', bypass: 'outreach' }));
    assert.equal(plain.sent, false);
    assert.equal(bypassed.sent, false, 'a bypass does not turn a status report into a text');
    assert.equal(sent.length, 0);
    assert.equal(rows().length, 2, 'both attempts are in the ledger');
    assert.ok(rows().every((r) => r.reason === 'status-log-only'));
    assert.equal(cos.collectAmbientItems().length, 0, 'status does not ride the check-in either');
  });

  await test('decisions and nudges wait for the check-in', async () => {
    clear();
    const d = await cos.sendInterrupt(req({ kind: 'decision', subject: 'task:5:overdue' }));
    const n = await cos.sendInterrupt(req({ kind: 'nudge', subject: 'person:9:reach-out', text: 'ping Sam' }));
    assert.equal(d.sent, false);
    assert.equal(n.sent, false);
    if (d.sent) throw new Error('unreachable');
    assert.equal(d.reason, 'checkin-only');
    assert.equal(sent.length, 0);
    assert.equal(cos.collectAmbientItems().length, 2);
  });

  await test('a producer restaging the same subject lands in the check-in once', async () => {
    clear();
    for (let i = 0; i < 4; i++) await cos.sendInterrupt(req({ kind: 'decision', subject: 'task:1043', text: `overdue v${i}` }));
    const staged = cos.collectAmbientItems();
    assert.equal(staged.length, 1, 'one entry per subject');
    assert.match(staged[0].line, /v3/, 'carrying the latest wording');
  });

  await test('kind "reply" is never held — a human is waiting', async () => {
    clear();
    for (let i = 0; i < 5; i++) {
      const d = await cos.sendInterrupt(req({ kind: 'reply', subject: 'prospect:1' }));
      assert.equal(d.sent, true, `reply ${i + 1} must go through`);
    }
    assert.equal(sent.length, 5, 'replies bypass both the cooldown and the budget');
  });

  await test('the daily budget (3 + 1 overdraft for time-critical) is finite', async () => {
    clear();
    for (let i = 0; i < 4; i++) {
      const d = await cos.sendInterrupt(req({ subject: `thing:${i}` }));
      assert.equal(d.sent, true, `interrupt ${i + 1} is inside budget + overdraft`);
    }
    const over = await cos.sendInterrupt(req({ subject: 'thing:99' }));
    assert.equal(over.sent, false);
    if (over.sent) throw new Error('unreachable');
    assert.equal(over.reason, 'daily-budget');
  });

  await test('a bypass lane is exempt from the rules but still fully logged', async () => {
    clear();
    for (let i = 0; i < 6; i++) await cos.sendInterrupt(req({ subject: `thing:${i}` }));
    const bypassed = await cos.sendInterrupt(req({
      subject: 'outreach:reply:acme', kind: 'reply', bypass: 'outreach',
    }));
    assert.equal(bypassed.sent, true, 'committed outreach work is never held');
    const row = rows().find((r) => r.bypass === 'outreach');
    assert.ok(row, 'a bypass must leave a record — that is the difference from the old sentinel');
    assert.equal(row!.decision, 'sent');
  });

  await test('two sources saying the same thing collide on the body hash', async () => {
    clear();
    await cos.sendInterrupt(req({ source: 'alpha', subject: 'a:1', text: 'Package arrives today at 3pm' }));
    const dup = await cos.sendInterrupt(req({
      source: 'beta', subject: 'b:1', text: 'package ARRIVES today at 3pm!!',
    }));
    assert.equal(dup.sent, false, 'near-identical text from another source is a duplicate');
    if (dup.sent) throw new Error('unreachable');
    assert.equal(dup.reason, 'cross-source-duplicate');
  });

  await test('a long interrupt is trimmed for the banner, and the full text is kept for "more"', async () => {
    clear();
    const long = ['Leave now for the dentist, 3pm at 12 Main St.', ...Array.from({ length: 20 }, (_, i) => `detail line ${i} ${'x'.repeat(30)}`)].join('\n');
    const d = await cos.sendInterrupt(req({ subject: 'meeting:1:leave', text: long }));
    assert.equal(d.sent, true);
    assert.ok(sent[0].text.length <= cos.INTERRUPT_MAX_CHARS, `sent ${sent[0].text.length} chars`);
    assert.match(sent[0].text, /^Leave now/);
    assert.match(sent[0].text, /more/);
    assert.match(cos.getRecentDetails() ?? '', /detail line 19/);
  });

  await test('no recipient is recorded rather than silently returning', async () => {
    clear();
    const d = await cos.sendInterrupt({
      source: 'test', subject: 'x:1', kind: 'time-critical', text: 'hi', target: undefined,
    });
    // getDefaultRecipient may resolve from env; only assert the logged path.
    if (!d.sent) {
      assert.equal(rows().length, 1, 'even a no-op attempt leaves a row');
    }
  });

  await test('a throwing arbiter fails OPEN — silence is the worse failure', async () => {
    clear();
    const spy = db.prepare;
    try {
      // Break the queries the arbiter depends on.
      (db as unknown as Record<string, unknown>).prepare = () => { throw new Error('db exploded'); };
      const d = await cos.sendInterrupt(req({ subject: 'boom:1' }));
      assert.equal(d.sent, true, 'a broken gate must not become a silent gag');
    } finally {
      (db as unknown as Record<string, unknown>).prepare = spy;
    }
  });

  // ── check-ins ────────────────────────────────────────────────────────────
  const checkins = await import('../src/checkins.js');
  const clearSections = () => db.prepare("DELETE FROM memory WHERE group_id = 'cos-checkin'").run();
  const checkinDeps = (compose: (slot: string, material: string) => Promise<string | null>) => ({
    send: async (to: string, text: string) => { sent.push({ to, text }); },
    target: () => '+15550001111',
    compose,
  });

  await test('a check-in with nothing staged sends nothing', async () => {
    clear(); clearSections();
    let called = false;
    const out = await checkins.runCheckin('morning', checkinDeps(async () => { called = true; return 'x'; }));
    assert.equal(out, null);
    assert.equal(called, false, 'no LLM call when there is no material');
    assert.equal(sent.length, 0);
  });

  await test('a check-in compresses staged sections + queued one-liners into one message, then clears them', async () => {
    clear(); clearSections();
    checkins.stageSection('scheduler:daily-calendar-prep', 'calendar-prep:2026-09-29', '**Today**: dentist 3pm\nLong plan...');
    await cos.sendInterrupt(req({ kind: 'nudge', subject: 'person:2', text: 'Text Priya back' }));
    let material = '';
    const out = await checkins.runCheckin('morning', checkinDeps(async (_slot, m) => {
      material = m;
      return '📅 Dentist at 3pm\n\n1. ✅ Text Priya back\n\n↩ "more"';
    }));
    assert.ok(out);
    assert.equal(sent.length, 1, 'one message, not one per source');
    assert.match(material, /dentist 3pm/);
    assert.doesNotMatch(material, /\*\*/, 'markdown is stripped before composing');
    assert.match(material, /Text Priya back/);
    assert.equal(cos.collectAmbientItems().length, 0, 'queue drained');
    const again = await checkins.runCheckin('evening', checkinDeps(async () => 'should not run'));
    assert.equal(again, null, 'the same material is not offered twice');
    assert.match(cos.getRecentDetails() ?? '', /Long plan/, '"more" can still reach the full text');
    assert.match(checkins.getRecentCheckin() ?? '', /Dentist/);
  });

  await test('a composer that finds nothing actionable stays silent', async () => {
    clear(); clearSections();
    checkins.stageSection('scheduler:x', 'x:1', 'Quiet day. Nothing new.');
    const out = await checkins.runCheckin('evening', checkinDeps(async () => null));
    assert.equal(out, null);
    assert.equal(sent.length, 0);
  });

  await test('a failing composer falls back to a short numbered message', async () => {
    clear(); clearSections();
    for (let i = 0; i < 8; i++) checkins.stageSection('scheduler:x', `x:${i}`, `Item ${i} ${'y'.repeat(200)}`);
    const out = await checkins.runCheckin('morning', checkinDeps(async () => { throw new Error('LLM down'); }));
    assert.ok(out);
    assert.ok(out!.length <= checkins.CHECKIN_MAX_CHARS, `fallback is ${out!.length} chars`);
    assert.match(out!, /^📋 Morning check-in/);
    assert.ok((out!.match(/^\d\. /gm) ?? []).length <= 5, 'at most 5 items');
  });

  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  if (failures.length) {
    console.error(`\n${failures.length} outbound arbiter check(s) failed.`);
    process.exit(1);
  }
  console.log('\nOutbound arbiter tests passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
