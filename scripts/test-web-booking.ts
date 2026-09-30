// Online booking tests (Errands Phase 3): isolated DB, and the browser runner,
// calendar, notifier, and Chrome connection all stubbed. Nothing opens a
// browser, books, writes a calendar, or texts.
//   npm run test:web-booking
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-web-booking-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';

const db = await import('../src/db.js');
const wb = await import('../src/web-booking.js');
// Through the registry, the way the bot loads them (importing actions.ts first
// trips the tools/index.ts import cycle).
const { toolRegistry } = await import('../src/tools/index.js');
const { bookingBrowserTools } = await import('../src/tools/web-booking.js');
const { ownerAskedForCall } = await import('../src/tools/errands.js');
const { getOwner } = await import('../src/config.js');

const bookOnline = toolRegistry['web-booking'].find((t) => t.definition.name === 'book_online')!;
const confirm = toolRegistry.actions.find((t) => t.definition.name === 'confirm_action')!;
assert.ok(bookOnline && confirm, 'book_online is registered under actions');
assert.equal(toolRegistry['booking-browser'], bookingBrowserTools);

// ── Stubs ───────────────────────────────────────────────────────────────────
const told: Array<{ text: string; subject: string }> = [];
const events: Array<Record<string, unknown>> = [];
let connected = true;
let browserReply = '';
let browserCalls = 0;
let lastPrompt = '';
function stub(over: Partial<Parameters<typeof wb.setBookingDeps>[0] & object> = {}) {
  wb.setBookingDeps({
    isConnected: () => connected,
    runBrowser: async (prompt) => { browserCalls++; lastPrompt = prompt; return browserReply; },
    createEvent: async (opts) => { events.push(opts as unknown as Record<string, unknown>); return { eventId: 'evt1', htmlLink: null }; },
    notify: async (text, subject) => { told.push({ text, subject }); },
    withLock: async (_label, fn) => fn(),
    timeoutMs: 2000,
    ...over,
  });
}
stub();

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const OWNER = getOwner().id;
const request = 'book a table for 4 at a good Italian place in Springfield Saturday 7pm';
const ctx = { groupKey: 'admin', userId: OWNER, currentMessage: request };
const base = {
  what: 'dinner for 4',
  where: 'a good Italian place in Springfield NJ',
  when: 'Sat Oct 3, 7-8pm',
  party_size: 4,
  share: 'Name: Alex Rivera; cell 908-555-2100; email m@example.com',
};
const doneJson = JSON.stringify({
  status: 'done', summary: 'Dinner for 4 at Ferraro\'s, Sat Oct 3 7:15pm',
  booking: { title: 'Dinner at Ferraro\'s (4)', start: '2026-10-03T19:15', location: '8 Elm St, Springfield NJ', confirmation: 'ABC123' },
  url: 'https://resy.com/cities/nj/ferraros',
});

try {
  await check('result parsing: done, blocked, failed, fenced JSON', () => {
    const d = wb.parseBookingResult(`All set.\n\`\`\`json\n${doneJson}\n\`\`\``);
    assert.equal(d.status, 'done');
    assert.equal(d.booking?.confirmation, 'ABC123');
    assert.equal(d.booking?.start, '2026-10-03T19:15');
    const b = wb.parseBookingResult('{"status":"blocked","summary":"Resy wants a card to hold the table."}');
    assert.equal(b.status, 'blocked');
    assert.match(b.summary, /card/);
    const f = wb.parseBookingResult('{"status":"failed","summary":"No tables Saturday 7-8pm."}');
    assert.equal(f.status, 'failed');
  });

  await check('malformed output is a failure, never a booking', () => {
    for (const bad of ['', 'I booked it!', '{"status":"booked","summary":"x"}', '{"status":"done"}', '{not json',
      '{"status":"done","summary":"booked","booking":{"title":"x","start":"Saturday evening"}}']) {
      assert.equal(wb.parseBookingResult(bad).status, 'failed', `should fail: ${bad}`);
    }
  });

  await check('ISO times convert to ET wall clock', () => {
    assert.deepEqual(wb.toET('2026-10-03T19:15'), { date: '2026-10-03', time: '19:15' });
    assert.deepEqual(wb.toET('2026-10-03T23:15:00Z'), { date: '2026-10-03', time: '19:15' });
    assert.deepEqual(wb.toET('2026-10-03T19:15:00-04:00'), { date: '2026-10-03', time: '19:15' });
    assert.equal(wb.toET('Saturday'), null);
  });

  await check('proposal summary is phone-sized and refuses card/bank details', () => {
    const p = wb.prepareWebBooking(base);
    assert.ok(!('error' in p));
    if ('error' in p) return;
    assert.match(p.summary, /^🍽️ Book dinner for 4 at a good Italian place in Springfield NJ, Sat Oct 3, 7-8pm\n/);
    assert.match(p.summary, /no card or deposit · shares Name: Alex Rivera/);
    assert.equal(p.summary.split('\n').length, 2);
    const err = (x: Record<string, unknown>) => { const r = wb.prepareWebBooking(x); return 'error' in r ? r.error : ''; };
    assert.match(err({ ...base, share: 'Name: Alex; card 4111 1111 1111 1111' }), /never use card/);
    assert.match(err({ ...base, share: 'Name: Alex; 4111111111111111' }), /never use card/);
    assert.match(err({ ...base, share: '' }), /needs "share"/);
    assert.match(err({ ...base, when: '' }), /needs "when"/);
    assert.match(err({ ...base, party_size: 50 }), /1-20/);
    const oil = wb.prepareWebBooking({ what: 'oil change', where: 'Quick Lube Springfield', when: 'Thu Oct 1 afternoon', share: 'Name: Alex Rivera' });
    assert.ok(!('error' in oil) && oil.summary.startsWith('🗓️ Book oil change'));
  });

  await check('payment guard: no card fields, card numbers, pay buttons, or uploads', () => {
    assert.match(wb.paymentRefusal({ action: 'fill_input', selector: '#cardNumber', value: '1' })!, /payment/);
    assert.match(wb.paymentRefusal({ action: 'fill_input', selector: '#notes', value: '4111 1111 1111 1111' })!, /payment/);
    assert.match(wb.paymentRefusal({ action: 'click', text: 'Pay now' })!, /pays/);
    assert.match(wb.paymentRefusal({ action: 'click', text: 'Add card' })!, /pays/);
    assert.match(wb.paymentRefusal({ action: 'upload_file', selector: 'input' })!, /upload/);
    assert.equal(wb.paymentRefusal({ action: 'fill_input', selector: '#phone', value: '908-555-2100' }), null);
    assert.equal(wb.paymentRefusal({ action: 'click', text: 'Complete reservation' }), null);
    assert.equal(wb.paymentRefusal({ action: 'navigate', url: 'https://resy.com' }), null);
  });

  await check('booking browser tools refuse outside a booking window', async () => {
    assert.deepEqual(bookingBrowserTools.map((t) => t.definition.name).sort(), ['browser_action', 'browser_navigate']);
    const r = await bookingBrowserTools[0].handler({ action: 'navigate', url: 'https://resy.com' }, { groupKey: 'admin' });
    assert.match(String(r), /window is closed/);
  });

  await check('owner-verification: his words start the booking now, row logged as booking', async () => {
    browserReply = `\`\`\`json\n${doneJson}\n\`\`\``;
    const before = told.length;
    const out = String(await bookOnline.handler({ ...base, owner_request: 'book a table for 4 at a good Italian place in Springfield' }, ctx));
    const m = out.match(/Booking now \[action #(\d+)\]/);
    assert.ok(m, out);
    const id = Number(m![1]);
    for (let i = 0; i < 50 && db.getAction(id)!.status === 'executing'; i++) await new Promise((r) => setTimeout(r, 20));
    const row = db.getAction(id)!;
    assert.equal(row.kind, 'booking');
    assert.equal(row.tool_name, 'web_booking');
    assert.equal(row.status, 'done');
    assert.match(row.outcome!, /Ferraro's.*ABC123/);
    assert.ok(row.confirmed_at, 'auto-confirmed');
    assert.match(lastPrompt, /NEVER enter, select, or confirm a card/);
    assert.match(lastPrompt, /Name: Alex Rivera; cell 908-555-2100/);
    // calendar called on done
    const ev = events[events.length - 1];
    assert.equal(ev.date, '2026-10-03');
    assert.equal(ev.startTime, '19:15');
    assert.equal(ev.sourceRef, `booking:action:${id}`);
    assert.match(String(ev.description), /Confirmation: ABC123/);
    const note = told.slice(before);
    assert.equal(note.length, 1);
    assert.match(note[0].text, /^✅ Booked: Dinner for 4 at Ferraro's.*\(conf ABC123\)\. Added to your calendar\./);
    assert.equal(note[0].subject, `booking:${id}`);
  });

  await check('call_now still verifies calls through the moved helper', () => {
    const msg = 'Call springfield waste management about the clippings';
    assert.equal(ownerAskedForCall('Call springfield waste management', { groupKey: 'admin', userId: OWNER, currentMessage: msg }), true);
    assert.equal(ownerAskedForCall('Call springfield waste management', { groupKey: 'admin', userId: 'sam', currentMessage: msg }), false);
  });

  await check('bot\'s own idea (or words he never said) is a proposal, and go runs it', async () => {
    const calls = browserCalls;
    const own = String(await bookOnline.handler(base, ctx));
    assert.match(own, /^#(\d+) 🍽️ Book dinner for 4/);
    assert.match(own, /\n↩ go #action:\d+ · cancel · or say what to change$/);
    const fake = String(await bookOnline.handler({ ...base, owner_request: 'book dinner at Ferraro\'s for 6' }, ctx));
    assert.match(fake, /needs their "go"/);
    assert.equal(browserCalls, calls, 'nothing ran before go');
    const notOwner = String(await bookOnline.handler({ ...base, owner_request: 'book a table for 4 at a good Italian place' }, { ...ctx, userId: 'sam' }));
    assert.match(notOwner, /#\d+ 🍽️/, 'only the owner skips the gate');

    const id = Number(own.match(/^#(\d+)/)![1]);
    assert.equal(db.getAction(id)!.status, 'proposed');
    browserReply = '{"status":"blocked","summary":"OpenTable wants a card to hold Saturday tables.","url":"https://opentable.com/x"}';
    const before = told.length;
    const go = String(await confirm.handler({ id }));
    assert.match(go, /Booking dinner for 4 .* now in Chrome/);
    const result = await wb.lastBookingRun()!;
    assert.equal(result.status, 'blocked');
    const row = db.getAction(id)!;
    assert.equal(row.status, 'failed');
    assert.match(row.error!, /^blocked: OpenTable wants a card/);
    const note = told.slice(before);
    assert.equal(note.length, 1);
    assert.match(note[0].text, /^🧾 Couldn't finish booking dinner for 4 .*card.*Nothing was booked or paid\. Want me to call them instead\?$/);
  });

  await check('payment required → blocked, no calendar event', async () => {
    const evCount = events.length;
    browserReply = '{"status":"blocked","summary":"Needs a $25 deposit to book."}';
    const out = String(await bookOnline.handler({ ...base, owner_request: request }, ctx));
    const id = Number(out.match(/action #(\d+)/)![1]);
    for (let i = 0; i < 50 && db.getAction(id)!.status === 'executing'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(db.getAction(id)!.status, 'failed');
    assert.equal(events.length, evCount);
    assert.match(told[told.length - 1].text, /deposit.*call them instead/);
  });

  await check('malformed runner output fails and tells him', async () => {
    browserReply = 'Done! Your table is booked.';
    const out = String(await bookOnline.handler({ ...base, owner_request: request }, ctx));
    const id = Number(out.match(/action #(\d+)/)![1]);
    for (let i = 0; i < 50 && db.getAction(id)!.status === 'executing'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(db.getAction(id)!.status, 'failed');
    assert.match(told[told.length - 1].text, /^⚠️ Booking .* didn't go through: Couldn't read the booking result/);
  });

  await check('time box: a runner that never finishes is failed', async () => {
    stub({ runBrowser: () => new Promise<string>(() => { /* hangs */ }), timeoutMs: 50 });
    const r = await wb.runWebBooking(db.proposeAction({ kind: 'booking', tool_name: 'web_booking', summary: 's', payload_json: '{}', created_by_group: 'admin' }), base);
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /Ran out of time/);
    assert.equal(wb.bookingWindowOpen(), false, 'window closed after the run');
    stub();
  });

  await check('bridge not connected fails fast everywhere', async () => {
    connected = false;
    const calls = browserCalls;
    const out = String(await bookOnline.handler({ ...base, owner_request: request }, ctx));
    assert.match(out, /Chrome isn't connected.*call them instead/);
    const pid = db.proposeAction({ kind: 'booking', tool_name: 'web_booking', summary: 's', payload_json: JSON.stringify(base), created_by_group: 'admin' });
    const go = String(await confirm.handler({ id: pid }));
    assert.match(go, /needs you: Chrome isn't connected/);
    assert.equal(db.getAction(pid)!.status, 'failed');
    assert.equal(browserCalls, calls, 'browser never ran');
    connected = true;
  });

  console.log(`\nWeb booking tests passed: ${passed} checks.`);
} finally {
  wb.setBookingDeps(null);
  rmSync(tempRoot, { recursive: true, force: true });
}
