import type { ToolDef } from './index.js';
import { notionEnabled, notionFetch } from '../lib/notion-client.js';

// Notion integration — writes into the owner's "Other Brain" database (a
// catch-all for books / movies / products / ideas / places / etc., tagged by a
// rich `Type` multi-select). The assistant captures on their behalf: name +
// best-fit tag(s) + their comment (page body) + a link. The database ID comes
// from NOTION_OTHER_BRAIN_DB. The shared client lives in
// lib/notion-client.ts (also used by the journal + dashboard sync).

const OTHER_BRAIN_DB = process.env.NOTION_OTHER_BRAIN_DB?.trim() || '';
const NOT_CONFIGURED = 'Notion is not configured (NOTION_TOKEN or NOTION_OTHER_BRAIN_DB missing in .env).';

// The Type options that already exist on the Other Brain DB. We canonicalize the
// agent's tag (case-insensitive) to one of these so we never spawn a duplicate
// option ("book" -> "Book"). A genuinely new tag is dropped rather than created.
const BRAIN_TAGS = [
  'Activity', 'Article', 'Art', 'Book', 'Client', 'Comms', 'Contact', 'Content', 'Design',
  'DIY', 'Event', 'Fashion', 'File', 'Goal', 'Grocery', 'Health', 'Hospitality', 'Idea',
  'Inspiration', 'Login', 'Market Research', 'Meeting', 'Mental Health', 'Movie', 'Music',
  'Non-profits', 'Note', 'Partnership', 'Place', 'Photo', 'Product', 'Productivity', 'Proposal',
  'Quote', 'Recipe', 'Restaurant', 'Software', 'Tips', 'Travel', 'TV', 'Video', 'Writing',
  'Parenting', 'Plants & garden', 'Tech', 'Baby', 'Pregnancy', 'Tools', 'Services', 'Career',
  'Education', 'Exercise', 'Hair', 'Finance', 'Family', 'Household', 'Home', 'Gifts', 'Food',
  'Marketing', 'Real Estate', 'Tweet',
];

function canonicalTags(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const t of arr) {
    const match = BRAIN_TAGS.find((b) => b.toLowerCase() === String(t).trim().toLowerCase());
    if (match && !out.includes(match)) out.push(match);
  }
  return out;
}

export const notionTools: ToolDef[] = [
  {
    definition: {
      name: 'save_to_other_brain',
      description:
        "Save anything of interest to the owner's Other Brain in Notion — a book, movie, TV show, product, article, recipe, idea, quote, place, restaurant, music, tweet, tech, etc. — tagged by type with their comment. USE WHEN: the owner says \"save this\", \"add X to my brain\", \"note this book/movie/product\", or shares something they want to keep. Pick the best-fitting existing tag(s) for `type`. Put their reaction/why-they-saved-it in `notes`.",
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'The item name / title' },
          type: {
            type: 'string',
            description:
              'Best-fitting existing tag. Common: Book, Movie, TV, Product, Article, Recipe, Idea, Quote, Place, Restaurant, Music, Video, Tech, Travel, Inspiration, Note, Tweet, Gifts, Food, Health, Career. Comma-separate for multiple.',
          },
          notes: { type: 'string', description: "The owner's comment — why they saved it, their reaction. Goes in the page body." },
          link: { type: 'string', description: 'URL, if any' },
        },
        required: ['name', 'type'],
      },
    },
    handler: async (input) => {
      if (!notionEnabled() || !OTHER_BRAIN_DB) return NOT_CONFIGURED;
      const { name, type, notes, link } = input as { name: string; type: string; notes?: string; link?: string };
      const tags = canonicalTags(typeof type === 'string' ? type.split(',') : type);
      const properties: Record<string, unknown> = {
        Name: { title: [{ text: { content: name } }] },
      };
      if (tags.length) properties.Type = { multi_select: tags.map((t) => ({ name: t })) };
      if (link) properties.Link = { url: link };
      const children = notes
        ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: notes } }] } }]
        : undefined;
      try {
        const page = await notionFetch('/pages', 'POST', {
          parent: { database_id: OTHER_BRAIN_DB },
          properties,
          ...(children ? { children } : {}),
        });
        return `Saved to Other Brain: ${name} [${tags.join(', ') || 'untagged'}]${notes ? ` — "${notes}"` : ''}\n${(page.url as string) || ''}`;
      } catch (err) {
        return `Couldn't save to Other Brain: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    definition: {
      name: 'search_other_brain',
      description:
        "Search the owner's Other Brain in Notion for things they saved. USE WHEN: \"what did I save about X\", \"find that book/product I noted\", \"what's in my brain about Y\".",
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Text to match against saved item names' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      if (!notionEnabled() || !OTHER_BRAIN_DB) return NOT_CONFIGURED;
      const { query } = input as { query: string };
      try {
        const res = await notionFetch(`/databases/${OTHER_BRAIN_DB}/query`, 'POST', {
          filter: { property: 'Name', title: { contains: query } },
          page_size: 10,
        });
        const rows = (res.results as Array<Record<string, unknown>>) || [];
        if (rows.length === 0) return `Nothing in Other Brain matching "${query}".`;
        const lines = rows.map((r) => {
          const props = r.properties as Record<string, { title?: Array<{ plain_text: string }>; multi_select?: Array<{ name: string }>; url?: string }>;
          const nm = props.Name?.title?.map((t) => t.plain_text).join('') || '(untitled)';
          const tg = props.Type?.multi_select?.map((m) => m.name).join(', ') || '';
          const lk = props.Link?.url ? ` ${props.Link.url}` : '';
          return `- ${nm}${tg ? ` [${tg}]` : ''}${lk}`;
        });
        return `Other Brain matches for "${query}":\n${lines.join('\n')}`;
      } catch (err) {
        return `Couldn't search Other Brain: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
