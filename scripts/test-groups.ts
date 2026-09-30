import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const groups = [
  { env: 'GROUP_ADMIN', name: 'Admin' },
  { env: 'GROUP_FAMILY', name: 'Family' },
  { env: 'GROUP_WORK', name: 'Work' },
  { env: 'GROUP_HOME', name: 'Home' },
  { env: 'GROUP_HEALTH', name: 'Health' },
];

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './auth_state' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('ready', async () => {
  console.log('Connected — sending test messages...');
  for (const g of groups) {
    const jid = process.env[g.env];
    if (!jid) { console.log(`Skipping ${g.name} — no JID`); continue; }
    await client.sendMessage(jid, `[assistant] This is the ${g.name} group. Mapping confirmed.`);
    console.log(`Sent to ${g.name} (${jid})`);
  }
  console.log('Done!');
  process.exit(0);
});

client.initialize();
