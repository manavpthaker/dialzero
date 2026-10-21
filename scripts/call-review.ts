// npm run calls:review                 → last 7 days of real calls, one block each
// npm run calls:review -- --days=30    → a longer window
// npm run calls:review -- --practice   → include the daily practice calls
// npm run calls:review -- --id=12      → one call with its full timed transcript
// npm run calls:review -- --recordings → also list each call's Twilio recording links (reads Twilio)
import 'dotenv/config';
import { listCalls, type CallLogRow } from '../src/call-log.js';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const days = Number(arg('days') ?? 7);
const id = Number(arg('id') ?? 0);
const withRecordings = process.argv.includes('--recordings');

const rows = listCalls({ days: id ? 3650 : days, includePractice: id ? true : process.argv.includes('--practice') })
  .filter((r) => !id || r.id === id);

const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);

async function recordings(r: CallLogRow): Promise<string[]> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return ['(no Twilio credentials in .env)'];
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
  const paths = [
    r.conference_sid ? `Conferences/${r.conference_sid}/Recordings.json` : '',
    r.twilio_sid ? `Calls/${r.twilio_sid}/Recordings.json` : '',
  ].filter(Boolean);
  const out: string[] = [];
  for (const p of paths) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${p}`, { headers: { Authorization: auth } });
    if (!res.ok) { out.push(`(${p}: Twilio ${res.status})`); continue; }
    const j = await res.json() as { recordings?: Array<{ sid: string; duration: string }> };
    for (const rec of j.recordings ?? []) out.push(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${rec.sid}.mp3 (${rec.duration}s)`);
  }
  return out.length ? out : ['(no recording)'];
}

if (!rows.length) console.log(id ? `No call #${id} in the call log.` : `No calls in the last ${days} days.`);
for (const r of [...rows].reverse()) {
  console.log(`#${r.id} ${r.created_at} UTC  ${r.target}${r.practice ? ' (practice)' : ''}  errand #${r.errand_id ?? '—'}`);
  console.log(`  ${r.verdict ?? 'not reviewed'}; answered by ${r.answered_by ?? '?'}; ended: ${(r.end_reason ?? '?').replace(/_/g, ' ')}; ${Math.round(r.duration_s ?? 0)}s`);
  console.log(`  first words ${sec(r.first_words_ms)} after pickup; reply ${sec(r.median_reply_ms)} median, ${sec(r.max_reply_ms)} max over ${r.replies}${r.audio_timed === 0 ? ' (timed to composing, not voice)' : ''}; talked over ${r.talk_overs}x; echoes dropped ${r.echoes}`);
  if (r.summary) console.log(`  ${r.summary}`);
  if (r.learned) console.log(`  Learned: ${r.learned}`);
  if (r.next_step) console.log(`  Next: ${r.next_step}`);
  if (r.menu) console.log(`  Menu: ${r.menu}`);
  if (id) console.log(`\n${r.transcript ?? '(transcript cleared after 30 days)'}`);
  if (withRecordings) for (const line of await recordings(r)) console.log(`  Recording: ${line}`);
  console.log('');
}
process.exit(0);
