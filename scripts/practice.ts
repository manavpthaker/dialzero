// npm run practice                     → recent practice-line results
// npm run practice -- --all            → ask the running bot to dial all six scenes (~10-15 min)
// npm run practice -- --scene=menu     → one scene (hello, greeting, menu, hold, voicemail, hangup)
// npm run practice -- --twiml=hold     → print a scene's opening TwiML (no call)
// The calls are placed by the running bot, which owns the phone webhooks; results
// land here and in the weekly scorecard.
import 'dotenv/config';
import { SCENES, practiceNumber, recentResults, requestRun, sceneStep, type Scene } from '../src/practice-line.js';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const isScene = (s: string | undefined): s is Scene => !!s && (SCENES as string[]).includes(s);

const twiml = arg('twiml');
if (twiml) {
  if (!isScene(twiml)) { console.log(`Scenes: ${SCENES.join(', ')}`); process.exit(1); }
  console.log(sceneStep(twiml, '', new URLSearchParams(), `${process.env.PHONE_PUBLIC_URL ?? ''}/twilio/voice`).twiml);
  process.exit(0);
}

const scene = arg('scene');
if (process.argv.includes('--all') || scene) {
  if (scene && !isScene(scene)) { console.log(`Unknown scene "${scene}". Scenes: ${SCENES.join(', ')}`); process.exit(1); }
  const scenes = scene ? [scene as Scene] : SCENES;
  requestRun(scenes);
  console.log(`Queued ${scenes.join(', ')} on the practice line (${practiceNumber() || 'not set'}). The bot starts within a minute; each scene takes 1-3 minutes.`);
  console.log('Check back with: npm run practice');
  process.exit(0);
}

const results = recentResults(30);
if (!results.length) console.log('No practice-line results yet. Run one with: npm run practice -- --scene=hello');
for (const r of results) {
  console.log(`${r.at.slice(0, 16).replace('T', ' ')} UTC  ${r.scene.padEnd(9)} ${r.pass ? 'pass' : 'FAIL'}${r.detail ? `  (${r.detail})` : ''}`);
  for (const p of r.problems) console.log(`    - ${p}`);
}
process.exit(0);
