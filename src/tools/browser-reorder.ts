// Tier 2 Phase 1 — browser-driven reorder executor.
//
// This is NOT an agent-callable tool. It runs INSIDE confirm_action (see
// actions.ts EXECUTORS) so the propose → confirm gate can't be skipped. It
// re-builds the cart from scratch at execute time (stateless — no requirement
// that a tab from propose-time still exists), reads the final total, drift-
// checks it against the price the user approved, then places the order.
//
// Real storefronts vary wildly, so the flow is best-effort: it accepts optional
// site-specific selectors in the payload and otherwise falls back to text-based
// clicking. Every failure path throws a typed error so confirm_action records
// the row as 'failed' and the agent can re-propose — nothing spends silently.

import { sendCommand, isBrowserConnected } from '../browser-bridge.js';
import { parseBoolEnv } from '../lib/env.js';
import type { Action } from '../db.js';

export interface ReorderPayload {
  store: string;
  item_url: string;
  quantity?: number;
  max_price_cents?: number;        // hard ceiling the user implicitly approved
  // Optional site-specific selectors. When omitted we fall back to common text.
  add_to_cart_selector?: string;
  quantity_selector?: string;
  checkout_url?: string;
  checkout_selector?: string;
  place_order_selector?: string;
  confirmation_selector?: string;
}

const DRIFT_TOLERANCE = 0.05; // 5%

// Skips the final "place order" click and returns the observed total as a
// simulated outcome. Lets the golden-path / edit / cancel flows be exercised
// end-to-end without spending real money. Set ACTIONS_REORDER_DRY_RUN=true.
function isDryRun(): boolean {
  return parseBoolEnv('ACTIONS_REORDER_DRY_RUN', false);
}

// Pull a dollar total out of page text. Prefers a "Total $X" line (ignoring
// "Subtotal"); falls back to the largest $amount on the page.
function parseTotalCents(text: string): number | null {
  const toCents = (s: string) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);
  const labelled: number[] = [];
  for (const line of text.split(/\n+/)) {
    if (/total/i.test(line) && !/subtotal/i.test(line)) {
      const m = line.match(/\$\s?([0-9][0-9,]*\.[0-9]{2})/);
      if (m) labelled.push(toCents(m[1]));
    }
  }
  if (labelled.length) return Math.max(...labelled);
  const all = [...text.matchAll(/\$\s?([0-9][0-9,]*\.[0-9]{2})/g)].map((m) => toCents(m[1]));
  return all.length ? Math.max(...all) : null;
}

async function navigate(url: string): Promise<{ tabId: number; text: string }> {
  const r = await sendCommand('navigate', { url, newTab: true }, 30000) as Record<string, unknown>;
  return { tabId: (r.tabId as number), text: (r.text as string) || '' };
}

async function clickBySelectorOrText(tabId: number, selector: string | undefined, texts: string[]): Promise<void> {
  if (selector) {
    await sendCommand('click', { selector, tabId }, 15000);
    return;
  }
  // Try each candidate label until one clicks without throwing.
  let lastErr: unknown;
  for (const t of texts) {
    try {
      await sendCommand('click', { text: t, tabId }, 15000);
      return;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`could not find a clickable element for any of: ${texts.join(', ')}${lastErr ? ` (${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ''}`);
}

async function readPageText(tabId: number): Promise<string> {
  try {
    const r = await sendCommand('extract_text', { selector: 'body', tabId }, 15000) as { text?: string };
    return r.text || '';
  } catch {
    return '';
  }
}

/**
 * Executor body for kind='reorder'. Receives the full Action row so it can
 * drift-check the live total against estimated_cost_cents (the price the user
 * approved). Throws on any unsafe / stuck state; confirm_action turns that into
 * a 'failed' row + a DM to the user.
 */
export async function runBrowserReorder(action: Action): Promise<{ outcome: string; outcome_url?: string; actual_cost_cents: number }> {
  if (!isBrowserConnected()) {
    throw new Error('human_handoff_needed: Chrome extension not connected — open Chrome on the Mac mini and retry.');
  }

  let payload: ReorderPayload;
  try {
    payload = JSON.parse(action.payload_json) as ReorderPayload;
  } catch {
    throw new Error(`invalid payload_json on action #${action.id}`);
  }
  if (!payload.item_url) throw new Error('payload missing item_url');
  const quantity = payload.quantity && payload.quantity > 0 ? payload.quantity : 1;

  // 1. Open the item.
  const { tabId } = await navigate(payload.item_url);

  // 2. Set quantity (best-effort) + add to cart.
  if (quantity > 1 && payload.quantity_selector) {
    try { await sendCommand('fill_input', { selector: payload.quantity_selector, value: String(quantity), tabId }, 15000); } catch { /* best-effort */ }
  }
  await clickBySelectorOrText(tabId, payload.add_to_cart_selector, ['Add to Cart', 'Add to cart', 'Add to basket', 'Buy Now']);

  // 3. Go to checkout.
  if (payload.checkout_url) {
    await sendCommand('navigate', { url: payload.checkout_url, tabId }, 30000);
  } else {
    await clickBySelectorOrText(tabId, payload.checkout_selector, ['Proceed to checkout', 'Checkout', 'Place order', 'Continue to checkout']);
  }

  // 4. Read the final total.
  const checkoutText = payload.confirmation_selector
    ? await (async () => { try { const r = await sendCommand('extract_text', { selector: payload.confirmation_selector, tabId }, 15000) as { text?: string }; return r.text || ''; } catch { return ''; } })()
    : await readPageText(tabId);
  const totalCents = parseTotalCents(checkoutText);
  if (totalCents === null) {
    throw new Error('human_handoff_needed: could not read an order total at checkout — the page may need a CAPTCHA, a login, or a non-standard layout. Re-propose with a checkout_selector or place the order manually.');
  }

  // 5. Safety checks before committing money.
  if (payload.max_price_cents != null && totalCents > payload.max_price_cents) {
    throw new Error(`price_drift: live total $${(totalCents / 100).toFixed(2)} exceeds the max you set ($${(payload.max_price_cents / 100).toFixed(2)}). Order NOT placed.`);
  }
  if (action.estimated_cost_cents != null && action.estimated_cost_cents > 0) {
    const drift = Math.abs(totalCents - action.estimated_cost_cents) / action.estimated_cost_cents;
    if (drift > DRIFT_TOLERANCE) {
      throw new Error(`price_drift: live total $${(totalCents / 100).toFixed(2)} differs from the approved estimate $${(action.estimated_cost_cents / 100).toFixed(2)} by ${(drift * 100).toFixed(0)}% (>5%). Order NOT placed — re-propose at the current price.`);
    }
  }

  // 6. Dry-run short-circuit (testing): don't actually buy.
  if (isDryRun()) {
    const cur = await sendCommand('get_current_url', { tabId }, 10000) as { url?: string };
    return { outcome: `[dry-run] would place order at ${payload.store} — total $${(totalCents / 100).toFixed(2)}`, outcome_url: cur.url, actual_cost_cents: totalCents };
  }

  // 7. Place the order.
  await clickBySelectorOrText(tabId, payload.place_order_selector, ['Place your order', 'Place order', 'Submit order', 'Complete purchase', 'Pay now']);

  // 8. Read confirmation.
  const confirmText = await readPageText(tabId);
  const cur = await sendCommand('get_current_url', { tabId }, 10000) as { url?: string };
  const orderMatch = confirmText.match(/(?:order|confirmation|order\s*#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i);
  const orderId = orderMatch ? orderMatch[1] : 'placed (no confirmation # parsed)';

  return {
    outcome: `Order ${orderId} at ${payload.store} — total $${(totalCents / 100).toFixed(2)}`,
    outcome_url: cur.url,
    actual_cost_cents: totalCents,
  };
}
