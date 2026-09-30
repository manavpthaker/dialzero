// `npm run chat`: talk to your assistant in the terminal instead of iMessage.
// Same brain, memory, tools and settings as the real thing. Nothing goes out:
// any text it would send (to you or anyone else) is printed here instead.
// Calls, emails and bookings are real if those features are set up, so they
// still wait for your "go" like they do over iMessage.
//
//   npm run chat
//   npm run chat -- --once "what's on my calendar tomorrow?"
import 'dotenv/config';
import { createInterface } from 'readline';
import { initUsers, resolveUser } from '../src/user-resolver.js';
import { initGroups, resolveGroup } from '../src/group-resolver.js';
import { runAgent } from '../src/agent.js';
import { setOutboundOverride } from '../src/channels/imessage.js';
import { withLlmContext } from '../src/lib/llm-context.js';
import { getBotName, getOwner } from '../src/config.js';
import { llmConfigured, llmProvider } from '../src/lib/openai.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

if (!llmConfigured()) {
  console.error('No AI key yet. Run npm run onboard (or add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env).');
  process.exit(1);
}

// Chat as the owner. Without a phone number in .env, use a local stand-in.
const owner = getOwner();
const handleEnv = owner.phoneEnv || `USER_${owner.id.toUpperCase()}`;
if (!process.env[handleEnv] && !process.env[owner.emailEnv || `${handleEnv}_EMAIL`]) {
  process.env[handleEnv] = '+15555552368';
}
const handle = process.env[handleEnv] || process.env[owner.emailEnv || `${handleEnv}_EMAIL`] || '';

initUsers();
initGroups();
const user = resolveUser(handle);
const group = resolveGroup(handle);
if (!user || !group) {
  console.error(`Couldn't resolve you as the owner (${handleEnv}). Check .env and config/profile.json.`);
  process.exit(1);
}

let replyingToYou = true;
setOutboundOverride(async (recipient, text) => {
  // Replies to you are printed by the loop below; anything else is a text it sent someone.
  if (recipient === handle && replyingToYou) return;
  console.log(dim(`[would text ${recipient}]`) + ` ${text}`);
});

const bot = getBotName();

async function ask(text: string): Promise<void> {
  replyingToYou = true;
  const reply = await withLlmContext(
    { caller: `agent:${group!.key}`, lane: 'interactive', groupKey: group!.key },
    () => runAgent(group!, user!, text, undefined, async (p) => { console.log(dim(`  ${p}`)); }, undefined, handle),
  );
  console.log(`${cyan(bot)} › ${reply}\n`);
}

const onceIdx = process.argv.indexOf('--once');
if (onceIdx !== -1) {
  await ask(process.argv.slice(onceIdx + 1).join(' '));
  process.exit(0);
}

console.log(`\nChatting with ${bot} (${llmProvider() === 'claude' ? 'Claude' : 'OpenAI'}). Nothing is texted to anyone; type "exit" to stop.\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => rl.question('you › ', async (line) => {
  const text = line.trim();
  if (!text) return prompt();
  if (/^(exit|quit|bye)$/i.test(text)) { rl.close(); process.exit(0); }
  try {
    await ask(text);
  } catch (err) {
    console.log(dim(`  (error: ${err instanceof Error ? err.message : String(err)})\n`));
  }
  prompt();
});
prompt();
