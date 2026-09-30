import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import db, {
  getBrainStats, listPendingActions, listRecentActions,
  getDailyActionSpendCents, getWeeklyActionSpendCents,
  getTaskStats, getOverdueTasksAll, searchFactsBroad, peopleSearch, searchIMessages,
  getStaleCommitments, getExpiringFacts, getRecentComputerUseActions,
  type Fact, type Person, type Action, type IMessageLogRow, type ComputerUseLogRow,
} from './db.js';
import { checkActionsEnabled, spendCaps } from './lib/spend-cap.js';
import { getBotName, getOwner } from './config.js';
import { arbiterConfig, collectAmbientItems } from './cos-outbound.js';
import { outboundTallySince, recentHeldOutbound } from './db.js';
import { startOfTodayET } from './lib/time-et.js';
import { toSqliteDate } from './lib/dates.js';

const DEFAULT_PORT = Number(process.env.ASSISTANT_DASH_PORT) || 4000;

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function listFacts(limit = 100): Fact[] {
  return db
    .prepare(
      `SELECT * FROM facts WHERE active = 1
       AND (valid_until IS NULL OR valid_until > datetime('now'))
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as Fact[];
}

function listPeople(limit = 100): (Person & { emails: string })[] {
  return db
    .prepare(
      `SELECT p.*, COALESCE(GROUP_CONCAT(pe.email, ', '), '') AS emails
       FROM people p LEFT JOIN person_emails pe ON pe.person_id = p.id
       GROUP BY p.id
       ORDER BY COALESCE(p.last_contact, p.created_at) DESC
       LIMIT ?`
    )
    .all(limit) as (Person & { emails: string })[];
}

function listOpenTasks(limit = 50): { id: number; title: string; due_date: string | null; priority: string; group_id: string }[] {
  return db
    .prepare(
      `SELECT id, title, due_date, priority, group_id FROM tasks
       WHERE status IN ('open','in_progress')
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC
       LIMIT ?`
    )
    .all(limit) as { id: number; title: string; due_date: string | null; priority: string; group_id: string }[];
}

function listRecentMessages(limit = 30): { group_id: string; role: string; content: string; created_at: string }[] {
  return db
    .prepare(
      `SELECT group_id, role, content, created_at FROM messages
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as { group_id: string; role: string; content: string; created_at: string }[];
}

type DashTask = { id: number; title: string; due_date: string | null; priority: string; status: string; group_id: string };

function listAllTasks(limit = 80): DashTask[] {
  return db
    .prepare(
      `SELECT id, title, due_date, priority, status, group_id FROM tasks
       WHERE status IN ('open','in_progress','snoozed')
          OR (status = 'done' AND completed_at > datetime('now','-7 days'))
       ORDER BY
         CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END,
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         due_date ASC
       LIMIT ?`
    )
    .all(limit) as DashTask[];
}

type DashMemory = { group_id: string; key: string; value: string; updated_at: string };

function listMemory(limit = 40): DashMemory[] {
  return db
    .prepare(
      `SELECT group_id, key, value, updated_at FROM memory
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as DashMemory[];
}

type DashInteraction = { name: string; channel: string | null; summary: string | null; when: string };

function listInteractions(limit = 30): DashInteraction[] {
  return db
    .prepare(
      `SELECT p.name AS name, i.channel AS channel, i.summary AS summary,
              COALESCE(i.occurred_at, i.created_at) AS "when"
       FROM interactions i JOIN people p ON p.id = i.person_id
       ORDER BY COALESCE(i.occurred_at, i.created_at) DESC LIMIT ?`
    )
    .all(limit) as DashInteraction[];
}

function usd(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function imsgWho(m: IMessageLogRow): string {
  return m.direction === 'out' ? getOwner().name : (m.chat_name || m.sender);
}

function renderOutboundSection(): string {
  const cfg = arbiterConfig();
  const today = toSqliteDate(startOfTodayET()) ?? '';
  const tally = outboundTallySince(today);
  const held = recentHeldOutbound(25);
  const staged = collectAmbientItems();

  const sentToday = tally
    .filter((t) => t.decision === 'sent' && t.would_hold === 0)
    .reduce((n, t) => n + t.n, 0);
  const wouldHold = tally.filter((t) => t.would_hold === 1).reduce((n, t) => n + t.n, 0);
  const heldToday = tally.filter((t) => t.decision !== 'sent').reduce((n, t) => n + t.n, 0);

  const pct = cfg.dailyBudget > 0 ? Math.min(100, Math.round((sentToday / cfg.dailyBudget) * 100)) : 0;
  const color = pct >= 90 ? '#c0392b' : pct >= 70 ? '#d68910' : '#27ae60';

  const modeNote = cfg.mode === 'observe'
    ? '<span class="pill" style="background:#d68910">OBSERVE — nothing is actually held yet</span>'
    : '<span class="pill" style="background:#27ae60">ENFORCE</span>';

  const heldRows = held.length
    ? held.map((h) => `<tr>
        <td>${escapeHtml(h.created_at?.slice(5, 16) ?? '')}</td>
        <td>${escapeHtml(h.source)}</td>
        <td>${escapeHtml(h.kind)}</td>
        <td><code>${escapeHtml(h.subject)}</code></td>
        <td><span class="pill">${escapeHtml(h.reason ?? '')}</span>${h.would_hold ? ' <span style="color:#999">(would)</span>' : ''}</td>
        <td>${escapeHtml((h.text_preview || '').slice(0, 110))}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" style="color:#999">nothing held</td></tr>';

  const stagedRows = staged.length
    ? staged.map((i) => `<tr><td>${escapeHtml(i.source)}</td><td>${escapeHtml(i.line)}</td></tr>`).join('')
    : '<tr><td colspan="2" style="color:#999">nothing waiting for the next brief</td></tr>';

  const tallyRows = tally.length
    ? tally.map((t) => `<tr>
        <td>${escapeHtml(t.source)}</td>
        <td>${escapeHtml(t.decision)}${t.would_hold ? ' (would hold)' : ''}</td>
        <td>${t.n}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="color:#999">no outbound today</td></tr>';

  return `<h2>Interrupts ${modeNote}</h2>
  <div class="stats">
    <div class="stat">
      <span class="v" style="color:${color}">${sentToday} <span style="font-size:13px;color:#999">/ ${cfg.dailyBudget}</span></span>
      <span class="k">interrupts sent today (${pct}%)</span>
    </div>
    <div class="stat"><span class="v">${wouldHold}</span><span class="k">would have been held</span></div>
    <div class="stat"><span class="v">${heldToday}</span><span class="k">actually held</span></div>
    <div class="stat"><span class="v">${staged.length}</span><span class="k">staged for next brief</span></div>
  </div>
  <h3>Held back</h3>
  <table><tr><th>when</th><th>source</th><th>kind</th><th>subject</th><th>reason</th><th>preview</th></tr>${heldRows}</table>
  <h3>Waiting for the next brief</h3>
  <table><tr><th>source</th><th>line</th></tr>${stagedRows}</table>
  <h3>By source, today</h3>
  <table><tr><th>source</th><th>decision</th><th>n</th></tr>${tallyRows}</table>`;
}

function renderActionsSection(): string {
  const { dailyCapCents, weeklyCapCents } = spendCaps();
  const dailyUsed = getDailyActionSpendCents();
  const weeklyUsed = getWeeklyActionSpendCents();
  const enabled = checkActionsEnabled().ok;
  const pending = listPendingActions(10);
  const recent = listRecentActions(10);

  const gauge = (label: string, used: number, cap: number) => {
    const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
    const color = pct >= 90 ? '#c0392b' : pct >= 70 ? '#d68910' : '#27ae60';
    return `<div class="stat">
      <span class="v" style="color:${color}">${usd(used)} <span style="font-size:13px;color:#999">/ ${usd(cap)}</span></span>
      <span class="k">${escapeHtml(label)} (${pct}%)</span>
    </div>`;
  };

  const statusPill = (s: string) => {
    const cls = s === 'done' ? 'preference' : s === 'failed' ? 'decision' : s === 'cancelled' ? '' : 'metric';
    return `<span class="pill ${cls}">${escapeHtml(s)}</span>`;
  };

  const pendingRows = pending.length
    ? pending.map((a: Action) => `<tr>
        <td class="meta">${a.id}</td>
        <td>${escapeHtml(a.summary)}</td>
        <td>${escapeHtml(a.kind)}</td>
        <td class="meta">${usd(a.estimated_cost_cents)}</td>
        <td>${a.reversible ? '<span class="pill">reversible</span>' : ''}</td>
        <td class="meta">${escapeHtml(a.proposed_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="meta">No pending actions.</td></tr>';

  const recentRows = recent.length
    ? recent.map((a: Action) => `<tr>
        <td class="meta">${a.id}</td>
        <td>${escapeHtml(a.summary)}</td>
        <td>${statusPill(a.status)}</td>
        <td class="meta">${usd(a.actual_cost_cents)}</td>
        <td>${escapeHtml(a.outcome ?? a.error ?? '')}</td>
        <td class="meta">${escapeHtml(a.executed_at ?? a.confirmed_at ?? a.proposed_at ?? '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="meta">No executed actions yet.</td></tr>';

  return `
<h2>Actions — spend &amp; queue</h2>
<div class="stats">
  <div class="stat"><span class="v" style="color:${enabled ? '#27ae60' : '#c0392b'}">${enabled ? 'ENABLED' : 'OFF'}</span><span class="k">kill switch</span></div>
  ${gauge('today', dailyUsed, dailyCapCents)}
  ${gauge('this week', weeklyUsed, weeklyCapCents)}
  <div class="stat"><span class="v">${pending.length}</span><span class="k">pending</span></div>
</div>

<h2>Pending actions (${pending.length})</h2>
<table><thead><tr><th>#</th><th>Summary</th><th>Kind</th><th>Est.</th><th></th><th>Proposed</th></tr></thead>
<tbody>${pendingRows}</tbody></table>

<h2>Recent actions (${recent.length})</h2>
<table><thead><tr><th>#</th><th>Summary</th><th>Status</th><th>Charged</th><th>Outcome</th><th>When</th></tr></thead>
<tbody>${recentRows}</tbody></table>
${renderComputerUseSection()}`;
}

function renderComputerUseSection(): string {
  const rows = getRecentComputerUseActions(15);
  const body = rows.length
    ? rows.map((r: ComputerUseLogRow) => `<tr>
        <td>${escapeHtml(r.action)}</td>
        <td>${escapeHtml(r.summary)}</td>
        <td class="meta">${escapeHtml(r.created_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="meta">No computer-use activity yet.</td></tr>';
  return `
<h2>Computer use — recent activity (${rows.length})</h2>
<table><thead><tr><th>Action</th><th>Summary</th><th>When</th></tr></thead>
<tbody>${body}</tbody></table>
`;
}

const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #fafafa; color: #222; }
  h1 { margin: 0 0 8px 0; font-size: 20px; }
  h2 { margin: 28px 0 8px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
  .stats { display: flex; gap: 24px; padding: 12px 16px; background: white; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); margin-bottom: 16px; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; }
  .stat .v { font-size: 22px; font-weight: 600; }
  .stat .k { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  th, td { text-align: left; padding: 6px 10px; font-size: 12px; vertical-align: top; }
  th { background: #f3f3f3; font-weight: 500; color: #555; }
  tr:nth-child(even) td { background: #fcfcfc; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; background: #eef; font-size: 10px; color: #335; margin-right: 4px; }
  .pill.preference { background: #efe; color: #353; }
  .pill.decision { background: #fee; color: #533; }
  .pill.metric { background: #ffe; color: #553; }
  .pill.commitment { background: #eef; color: #335; }
  .pill.feedback { background: #fef; color: #535; }
  .pill.done { background: #efe; color: #353; }
  .pill.snoozed { background: #eee; color: #777; }
  .msg-body { white-space: pre-wrap; word-break: break-word; max-width: 700px; max-height: 80px; overflow: hidden; color: #555; }
  .stale { color: #999; }
  .meta { color: #999; font-size: 11px; }
  .overdue td { background: #fff3f0 !important; }
  .search { margin: 0 0 12px 0; display: flex; gap: 8px; align-items: center; }
  .search input { flex: 1; max-width: 480px; padding: 8px 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; }
  .search button { padding: 8px 14px; font-size: 13px; border: 0; border-radius: 6px; background: #335; color: white; cursor: pointer; }
  .search a { font-size: 12px; color: #999; }
`;

function shell(inner: string, opts: { query?: string; autorefresh?: boolean } = {}): string {
  const q = opts.query ?? '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(getBotName())} brain</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.autorefresh ? '<meta http-equiv="refresh" content="30">' : ''}
<style>${STYLE}</style></head>
<body>
<h1>${escapeHtml(getBotName())} brain <span class="meta">${escapeHtml(new Date().toLocaleString())}</span></h1>
<form method="get" action="/" class="search">
  <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search facts, people, tasks, messages…">
  <button type="submit">Search</button>
  ${q ? '<a href="/">← back to dashboard</a>' : ''}
</form>
${inner}
</body></html>`;
}

function factsTable(facts: Fact[]): string {
  if (!facts.length) return '<p class="meta">No matching facts.</p>';
  return `<table><thead><tr><th>Subject</th><th>Predicate</th><th>Object</th><th>Type</th><th>Source</th><th>Updated</th></tr></thead>
<tbody>${facts.map(f => `<tr>
  <td>${escapeHtml(f.subject)}</td>
  <td>${escapeHtml(f.predicate)}</td>
  <td>${escapeHtml(f.object)}</td>
  <td><span class="pill ${escapeHtml(f.fact_type)}">${escapeHtml(f.fact_type)}</span></td>
  <td class="meta">${escapeHtml(f.source)}${f.source_ref ? ` <span class="stale">→ ${escapeHtml(f.source_ref.slice(0, 40))}</span>` : ''}</td>
  <td class="meta">${escapeHtml(f.updated_at)}</td>
</tr>`).join('')}</tbody></table>`;
}

function peopleTable(people: (Person & { emails?: string })[]): string {
  if (!people.length) return '<p class="meta">No matching people.</p>';
  return `<table><thead><tr><th>Name</th><th>Role / Company</th><th>Emails</th><th>Relationship</th><th>Last contact</th></tr></thead>
<tbody>${people.map(p => `<tr>
  <td>${escapeHtml(p.name)}</td>
  <td>${escapeHtml([p.role, p.company].filter(Boolean).join(' at '))}</td>
  <td class="meta">${escapeHtml(p.emails ?? '')}</td>
  <td>${p.relationship ? `<span class="pill">${escapeHtml(p.relationship)}</span>` : ''}</td>
  <td class="meta">${escapeHtml(p.last_contact ? p.last_contact.slice(0, 10) : '—')}</td>
</tr>`).join('')}</tbody></table>`;
}

function tasksTable(tasks: DashTask[]): string {
  if (!tasks.length) return '<p class="meta">No matching tasks.</p>';
  const now = new Date().toISOString();
  return `<table><thead><tr><th>#</th><th>Title</th><th>Status</th><th>Priority</th><th>Due</th><th>Group</th></tr></thead>
<tbody>${tasks.map(t => {
    const overdue = t.status !== 'done' && t.due_date && t.due_date < now;
    return `<tr class="${overdue ? 'overdue' : ''}">
  <td class="meta">${t.id}</td>
  <td>${escapeHtml(t.title)}</td>
  <td><span class="pill ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
  <td><span class="pill">${escapeHtml(t.priority)}</span></td>
  <td class="meta">${escapeHtml(t.due_date ?? '—')}${overdue ? ' ⚠️' : ''}</td>
  <td class="meta">${escapeHtml(t.group_id)}</td>
</tr>`;
  }).join('')}</tbody></table>`;
}

function imsgTable(rows: IMessageLogRow[]): string {
  if (!rows.length) return '<p class="meta">No matching messages.</p>';
  return `<table><thead><tr><th>When</th><th>Who</th><th>Chat</th><th>Message</th></tr></thead>
<tbody>${rows.map(m => `<tr>
  <td class="meta">${escapeHtml((m.ts || '').slice(0, 16).replace('T', ' '))}</td>
  <td class="meta">${escapeHtml(imsgWho(m))}</td>
  <td class="meta">${escapeHtml(m.chat_name ?? '')}</td>
  <td><div class="msg-body">${escapeHtml((m.text ?? '').slice(0, 400))}</div></td>
</tr>`).join('')}</tbody></table>`;
}

function renderSearchBody(q: string): string {
  const facts = searchFactsBroad(q, 40);
  const people = peopleSearch(q, 25);
  const like = `%${q.toLowerCase()}%`;
  const tasks = db.prepare(
    `SELECT id, title, due_date, priority, status, group_id FROM tasks
     WHERE LOWER(title) LIKE ? OR LOWER(COALESCE(notes,'')) LIKE ?
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END, due_date ASC
     LIMIT 40`
  ).all(like, like) as DashTask[];
  const messages = searchIMessages({ query: q, limit: 40 });

  return `
<h2>Facts matching “${escapeHtml(q)}” (${facts.length})</h2>
${factsTable(facts)}
<h2>People (${people.length})</h2>
${peopleTable(people)}
<h2>Tasks (${tasks.length})</h2>
${tasksTable(tasks)}
<h2>Messages (${messages.length})</h2>
${imsgTable(messages)}
`;
}

function renderDashboard(): string {
  const stats = getBrainStats();
  const taskStats = getTaskStats();
  const facts = listFacts(100);
  const people = listPeople(50);
  const tasks = listAllTasks(80);
  const overdue = getOverdueTasksAll();
  const memory = listMemory(40);
  const interactions = listInteractions(30);
  const recentIMsgs = searchIMessages({ limit: 30 });
  const staleCommitments = getStaleCommitments(10);
  const expiring = getExpiringFacts(7, 10);
  const messages = listRecentMessages(30);

  const agingRows = [
    ...staleCommitments.map(f => ({ kind: 'stale commitment', label: `${f.subject} — ${f.predicate}: ${f.object}`, when: f.created_at })),
    ...expiring.map(f => ({ kind: 'expiring', label: `${f.subject} — ${f.predicate}: ${f.object}`, when: f.valid_until ?? '' })),
  ];

  return `
<div class="stats">
  <div class="stat"><span class="v">${stats.facts_active}</span><span class="k">active facts</span></div>
  <div class="stat"><span class="v">${stats.people}</span><span class="k">people</span></div>
  <div class="stat"><span class="v">${taskStats.open}</span><span class="k">open tasks</span></div>
  <div class="stat"><span class="v" style="color:${taskStats.overdue > 0 ? '#c0392b' : '#222'}">${taskStats.overdue}</span><span class="k">overdue</span></div>
  <div class="stat"><span class="v">${stats.messages_24h}</span><span class="k">msgs / 24h</span></div>
  <div class="stat"><span class="v">${stats.last_reflection ? escapeHtml(stats.last_reflection.slice(0, 16).replace('T', ' ')) : '—'}</span><span class="k">last reflection</span></div>
</div>

${renderOutboundSection()}
${renderActionsSection()}

<h2>Tasks — open, overdue, snoozed &amp; recently done (${tasks.length})</h2>
${tasksTable(tasks)}

${agingRows.length ? `<h2>Aging — commitments &amp; expiring facts (${agingRows.length})</h2>
<table><thead><tr><th>Kind</th><th>What</th><th>When</th></tr></thead>
<tbody>${agingRows.map(a => `<tr>
  <td><span class="pill">${escapeHtml(a.kind)}</span></td>
  <td>${escapeHtml(a.label)}</td>
  <td class="meta">${escapeHtml((a.when || '').slice(0, 10))}</td>
</tr>`).join('')}</tbody></table>` : ''}

<h2>Facts (${facts.length})</h2>
${factsTable(facts)}

<h2>Reminders &amp; operational state — memory (${memory.length})</h2>
<table><thead><tr><th>Group</th><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
<tbody>${memory.map(m => `<tr>
  <td class="meta">${escapeHtml(m.group_id)}</td>
  <td>${escapeHtml(m.key)}</td>
  <td><div class="msg-body">${escapeHtml((m.value || '').slice(0, 400))}</div></td>
  <td class="meta">${escapeHtml((m.updated_at || '').slice(0, 16).replace('T', ' '))}</td>
</tr>`).join('')}</tbody></table>

<h2>People (${people.length})</h2>
${peopleTable(people)}

<h2>Interactions (${interactions.length})</h2>
<table><thead><tr><th>When</th><th>Who</th><th>Channel</th><th>Summary</th></tr></thead>
<tbody>${interactions.map(i => `<tr>
  <td class="meta">${escapeHtml((i.when || '').slice(0, 10))}</td>
  <td>${escapeHtml(i.name)}</td>
  <td class="meta">${escapeHtml(i.channel ?? '')}</td>
  <td>${escapeHtml(i.summary ?? '')}</td>
</tr>`).join('')}</tbody></table>

<h2>Recent iMessages (${recentIMsgs.length})</h2>
${imsgTable(recentIMsgs)}

<h2>Recent agent messages (${messages.length})</h2>
<table><thead><tr><th>When</th><th>Group</th><th>Role</th><th>Content</th></tr></thead>
<tbody>${messages.map(m => `<tr>
  <td class="meta">${escapeHtml(m.created_at)}</td>
  <td class="meta">${escapeHtml(m.group_id)}</td>
  <td class="meta">${escapeHtml(m.role)}</td>
  <td><div class="msg-body">${escapeHtml(m.content.slice(0, 600))}${m.content.length > 600 ? '…' : ''}</div></td>
</tr>`).join('')}</tbody></table>
`;
}

function renderPage(query?: string): string {
  const q = query?.trim();
  if (q) return shell(renderSearchBody(q), { query: q });
  return shell(renderDashboard(), { autorefresh: true });
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || '/';
  if (url === '/' || url.startsWith('/?')) {
    const q = new URL(url, 'http://localhost').searchParams.get('q') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(q));
    return;
  }
  if (url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getBrainStats(), null, 2));
    return;
  }
  res.writeHead(404);
  res.end('not found');
}

export function startDashboard(): void {
  const port = DEFAULT_PORT;
  const server = createServer(handle);
  server.on('error', (err) => {
    console.error('[Dashboard] server error:', err);
  });
  // Bind to loopback only. No auth — this is a local UI for the Mac mini.
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Dashboard] listening on http://127.0.0.1:${port}`);
  });
}
