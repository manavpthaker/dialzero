// Ask the running bot to do the morning check now (it owns the browser + phone).
import 'dotenv/config';
import { setMemory, getMemory } from '../src/db.js';
setMemory('canary', 'run_now', '1');
console.log('Asked the bot to run the morning check (within a minute). Last result:', getMemory('canary', 'last') ?? 'none');
