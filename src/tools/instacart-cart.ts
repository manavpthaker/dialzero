// instacart_cart (registered under `web-booking`, admin/DM only): fill the
// owner's Instacart cart in their Chrome from a list of items or the Family
// Groceries list, and stop before checkout. A thin wrapper over do_online, so it
// runs on the same website-job machinery: run-now on the owner's words (or a
// Family request they OK'd), the browser lock, the payment guard, "keep going
// until done", and the result by text. Instacart's own API needs a business
// application, so this is the Chrome route.

import type { ToolDef, ToolContext } from './index.js';
import { listFamilyListItems } from '../db.js';
import { webTaskTools } from './web-task.js';

export function instacartTask(items: string[], store?: string, notes?: string): string {
  const list = items.map((it, i) => `${i + 1}. ${it}`).join('\n');
  return [
    `Fill the owner's Instacart cart. Do NOT check out, place the order, or change payment, address or delivery settings.`,
    store ? `Store: ${store} (switch to it if another store is selected).` : 'Store: keep the store that is already selected; if none is, use the one from their most recent order.',
    `For each item: search it; prefer a match from "Buy it again" or their past orders; otherwise the closest plain match in a normal size. Set the quantity if one is given. If it's already in the cart, leave it. If an item can't be found, note it and move on.`,
    `When done, open the cart and report: items added, the cart subtotal shown, items not found, and any choices you guessed at (e.g. "picked 2% milk, half gallon").`,
    notes ? `Also: ${notes}` : '',
    `Items:\n${list}`,
  ].filter(Boolean).join('\n');
}

export const instacartCartTools: ToolDef[] = [
  {
    definition: {
      name: 'instacart_cart',
      description: `Put groceries in the owner's Instacart cart in their Chrome, stopping before checkout (they check out themselves). USE WHEN they say "put X on Instacart", "add the groceries to my cart", "order the grocery list" (you only fill the cart; you never place the order). items = what to add (with quantities if given), or from_family_list true to use the open items on the Family Groceries list. owner_request = their exact words (or the exact words of a Family request they approved), so it runs now. The result (added / not found / subtotal) comes back by text.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "Their exact words asking for it (or the approved Family request's exact words)." },
          items: { type: 'array', items: { type: 'string' }, description: 'Items with optional quantity, e.g. "2 gallons milk".' },
          from_family_list: { type: 'boolean', description: 'Use the open items on the Family Groceries list.' },
          store: { type: 'string', description: 'Store name if they named one, e.g. "the corner market".' },
          notes: { type: 'string', description: 'Anything else they said, e.g. "organic if it\'s not much more".' },
        },
      },
    },
    handler: async (input, context?: ToolContext) => {
      let items = Array.isArray(input.items) ? input.items.map((x) => String(x).trim()).filter(Boolean) : [];
      if (input.from_family_list === true) {
        const groceries = listFamilyListItems({ status: 'open', limit: 100 })
          .filter((it) => /grocer/i.test(it.list_name))
          .map((it) => (it.quantity ? `${it.quantity} ${it.text}` : it.text));
        items = [...new Set([...items, ...groceries])];
      }
      if (!items.length) return 'Nothing to add: give items, or use from_family_list when the Groceries list has open items.';
      if (items.length > 60) return 'That is more than 60 items; split it.';
      const store = typeof input.store === 'string' && input.store.trim() ? input.store.trim() : undefined;
      const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : undefined;
      return webTaskTools[0].handler({
        ...(typeof input.owner_request === 'string' ? { owner_request: input.owner_request } : {}),
        task: instacartTask(items, store, notes),
        site: 'https://www.instacart.com',
        notes: 'Stop before checkout. Never press Place order, Checkout, or Pay.',
      }, context);
    },
  },
];
