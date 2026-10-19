// No imports on purpose: actions.ts and codex.ts use this, and pulling in
// owner-request.ts from there would make an import cycle with tools/index.ts.

/**
 * The owner's own words in a turn prompt: a leading "[...]" note the
 * assistant's code wrote (whose examples may say "ok") is not something
 * they said.
 */
export function ownerOwnText(message: string): string {
  return message.replace(/^\s*\[[^\]\n]*(?:\][^\n]*)?\]\s*\n/, '');
}
