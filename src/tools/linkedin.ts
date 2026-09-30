import { sendCommand, isBrowserConnected } from '../browser-bridge.js';
import type { ToolDef, ToolContext } from './index.js';
import { upsertPerson, addInteraction } from '../db.js';

interface LinkedInHit { name: string; url?: string; subtitle?: string }

export const linkedinTools: ToolDef[] = [
  {
    definition: {
      name: 'linkedin_search',
      description: 'Search LinkedIn for people at a specific company or with specific titles. Uses the real Chrome browser with your active LinkedIn session — no credentials needed.',
      input_schema: {
        type: 'object' as const,
        properties: {
          company: { type: 'string', description: 'Company name to search' },
          title: { type: 'string', description: 'Job title to filter by (optional)' },
          keywords: { type: 'string', description: 'Additional keywords (optional)' },
        },
        required: ['company'],
      },
    },
    handler: async (input, _context?: ToolContext) => {
      const company = input.company as string;
      const title = input.title as string | undefined;
      const keywords = input.keywords as string | undefined;

      if (!isBrowserConnected()) {
        return 'Chrome extension not connected — open Chrome on the Mac mini and ensure the Assistant Bridge extension is loaded.';
      }

      let tabId: number | undefined;

      try {
        // Build LinkedIn people search URL
        let searchTerms = company;
        if (title) searchTerms += ` ${title}`;
        if (keywords) searchTerms += ` ${keywords}`;

        const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchTerms)}&origin=GLOBAL_SEARCH_HEADER`;

        // Navigate in a new tab so we don't clobber the group's browsing session
        const navResult = await sendCommand('navigate', { url, newTab: true }, 25000) as {
          tabId: number; title: string; url: string; text: string;
        };
        tabId = navResult.tabId;

        // Check if we're logged in
        if (navResult.url.includes('/login') || navResult.url.includes('/authwall')) {
          return 'LinkedIn session expired. Please log into LinkedIn in Chrome and try again.';
        }

        // Extract search result cards using LinkedIn's DOM structure
        const extractResult = await sendCommand('get_page_source', { tabId }, 10000) as {
          html: string; length: number;
        };

        // Parse results from page source
        const hits = parseLinkedInResults(extractResult.html);

        if (hits.length === 0) {
          // Fallback: use the page text from navigate
          const textHits = parseLinkedInFromText(navResult.text);
          if (textHits.length === 0) {
            return `No results found for "${searchTerms}" on LinkedIn.\n\nPage text preview: ${navResult.text.slice(0, 500)}`;
          }
          ingestPeople(textHits, company);
          return `## LinkedIn People Search: ${searchTerms}\n\n${textHits.map(formatHit).join('\n\n---\n\n')}`;
        }

        ingestPeople(hits, company);
        return `## LinkedIn People Search: ${searchTerms}\n\n${hits.map(formatHit).join('\n\n---\n\n')}`;
      } catch (err) {
        return `LinkedIn search error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        // Clean up the LinkedIn tab
        if (tabId) {
          sendCommand('close_tab', { tabId }).catch(() => {});
        }
      }
    },
  },
];

function parseLinkedInResults(html: string): LinkedInHit[] {
  const hits: LinkedInHit[] = [];

  // Match LinkedIn profile links with surrounding context
  // Pattern: /in/username in href, with nearby name/title text
  const profileRegex = /href="https?:\/\/www\.linkedin\.com\/in\/([^"?]+)[^"]*"[^>]*>([^<]+)/gi;
  const seen = new Set<string>();

  let match;
  while ((match = profileRegex.exec(html)) !== null) {
    const username = match[1];
    const name = match[2].trim().replace(/\s+/g, ' ');

    // Skip noise (empty, too short, "View" links, etc.)
    if (!name || name.length < 3 || name.length > 80 || seen.has(username)) continue;
    if (/^(view|see|connect|follow|message)/i.test(name)) continue;

    seen.add(username);
    hits.push({ name, url: `https://www.linkedin.com/in/${username}` });
  }

  return hits.slice(0, 10);
}

function parseLinkedInFromText(text: string): LinkedInHit[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const hits: LinkedInHit[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (
      line.length > 3 && line.length < 60 &&
      !line.includes('Search') && !line.includes('Filter') &&
      !line.includes('Page') && !line.includes('result') &&
      /^[A-Z]/.test(line) &&
      lines[i + 1] && (lines[i + 1].includes(' at ') || lines[i + 1].includes(' - '))
    ) {
      hits.push({ name: line, subtitle: lines[i + 1] });
      i++;
    }
  }

  return hits.slice(0, 10);
}

function formatHit(h: LinkedInHit): string {
  const lines = [`**${h.name}**`];
  if (h.subtitle) lines.push(h.subtitle);
  if (h.url) lines.push(h.url);
  return lines.join('\n');
}

function parseSubtitle(subtitle: string | undefined): { role?: string; company?: string } {
  if (!subtitle) return {};
  // Common forms: "Senior PM at Acme", "Director - Acme Corp"
  const atSplit = subtitle.split(' at ');
  if (atSplit.length === 2) return { role: atSplit[0].trim(), company: atSplit[1].trim() };
  const dashSplit = subtitle.split(' - ');
  if (dashSplit.length === 2) return { role: dashSplit[0].trim(), company: dashSplit[1].trim() };
  return {};
}

function ingestPeople(hits: LinkedInHit[], searchedCompany: string) {
  try {
    for (const h of hits) {
      const parsed = parseSubtitle(h.subtitle);
      const personId = upsertPerson({
        name: h.name,
        linkedin_url: h.url,
        company: parsed.company || searchedCompany,
        role: parsed.role,
        relationship: 'lead',
      });
      if (h.url) {
        addInteraction({
          person_id: personId,
          channel: 'linkedin',
          ref: h.url,
          occurred_at: new Date().toISOString(),
          summary: `Surfaced in LinkedIn search "${searchedCompany}"`,
        });
      }
    }
  } catch { /* never let graph writes break search */ }
}
