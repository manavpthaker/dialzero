import 'dotenv/config';
import { buildRelationshipPulsePrompt, gatherRelationshipPulse } from '../src/relationship-pulse.js';

const context = gatherRelationshipPulse();
if (!context) {
  console.log('RELATIONSHIP_CLEAR');
  process.exit(0);
}

console.log(buildRelationshipPulsePrompt(context));
