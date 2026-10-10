// npm run scorecard            → this week's numbers
// npm run scorecard -- --review → full report: vs last week + top failure causes (saved to ~/assistant-scorecards)
import 'dotenv/config';
import { buildScorecard, weeklyReport } from '../src/scorecard.js';
const days = Number(process.argv.find((a) => /^--days=/.test(a))?.split('=')[1] ?? 7);
if (process.argv.includes('--review')) console.log(await weeklyReport());
else console.log(buildScorecard(days).text);
process.exit(0);
