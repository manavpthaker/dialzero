import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ToolDef } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUSEHOLD_PATH = join(__dirname, '..', '..', 'context', 'personal', 'household.md');

function ensureFile() {
  const dir = dirname(HOUSEHOLD_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(HOUSEHOLD_PATH)) writeFileSync(HOUSEHOLD_PATH, '# Household Inventory\n\n', 'utf-8');
}

export const householdTools: ToolDef[] = [
  {
    definition: {
      name: 'read_household',
      description: 'Read the household inventory file.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      ensureFile();
      return readFileSync(HOUSEHOLD_PATH, 'utf-8');
    },
  },
  {
    definition: {
      name: 'update_household',
      description: 'Update the household inventory file. Replaces the full content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'New content for household.md' },
        },
        required: ['content'],
      },
    },
    handler: async (input) => {
      ensureFile();
      writeFileSync(HOUSEHOLD_PATH, input.content as string, 'utf-8');
      return 'Household inventory updated.';
    },
  },
  {
    definition: {
      name: 'append_household',
      description: 'Append a line or section to the household inventory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Text to append' },
        },
        required: ['text'],
      },
    },
    handler: async (input) => {
      ensureFile();
      const existing = readFileSync(HOUSEHOLD_PATH, 'utf-8');
      writeFileSync(HOUSEHOLD_PATH, existing + '\n' + (input.text as string), 'utf-8');
      return 'Added to household inventory.';
    },
  },
];
