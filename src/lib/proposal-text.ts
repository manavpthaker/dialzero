// How a proposal reads to the owner: the plan in plain words, then "Go?".
// No action numbers: those are for the bot. The tool result tells the model
// the id separately so it can confirm_action when the owner says go.

export function proposalText(id: number, summary: string, extra = ''): string {
  const owner = `${summary.trim()}${extra}\nGo?`;
  return `Send the owner exactly this, nothing added:\n${owner}\n\n(For you only: this is action id ${id}. When they say go/yes/do it, call confirm_action(id=${id}). "no"/"cancel" → cancel_action. A change → confirm_action with edits. Never show them the number.)`;
}
