// iMessage renders no markdown — `**bold**`, `## headers`, `---` rules, and `*`
// bullets all show up as literal characters on the phone. The CoS's outbound is
// plaintext-only, so every composed message passes through this before sending.
// A prompt instruction alone isn't enough (models still reach for `---` as a
// separator); this is the guarantee.

export function toPlainText(input: string): string {
  let s = input;

  // Bold / italic markers — keep the inner text, drop the markers.
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1$2'); // *italic* but not bullets

  // ATX headers: strip leading #'s (and any trailing #'s).
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/\s+#+\s*$/gm, '');

  // Horizontal-rule / divider lines (---, ***, ___, ===).
  s = s.replace(/^\s*([-*_=])\1{2,}\s*$/gm, '');

  // Markdown bullets `* ` / `+ ` at line start → plain `- `.
  s = s.replace(/^(\s*)[*+]\s+/gm, '$1- ');

  // Inline code / link syntax that reads as noise in plain text.
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');

  // Collapse the blank-line gaps left by removed rules; trim edges.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
