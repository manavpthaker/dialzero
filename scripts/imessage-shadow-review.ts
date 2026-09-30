import 'dotenv/config';
import { listIMessageExtractionDrafts } from '../src/db.js';

const limitArg = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? 25);
const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(limitArg, 100)) : 25;
const drafts = listIMessageExtractionDrafts({ status: 'pending', limit });

if (!drafts.length) {
  console.log('No pending iMessage extraction drafts.');
  process.exit(0);
}

for (const draft of drafts.reverse()) {
  console.log(`\n#${draft.id} · ${draft.source_start ?? '?'} → ${draft.source_end ?? '?'} · created ${draft.created_at}`);
  try {
    console.log(JSON.stringify(JSON.parse(draft.extraction_json), null, 2));
  } catch {
    console.log(draft.extraction_json);
  }
}

console.log(`\n${drafts.length} pending shadow draft(s). Nothing above has been written to facts, tasks, people, interactions, or Google Tasks.`);
