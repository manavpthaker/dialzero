// Shared phone-number normalizer for dedup/lookup across user routing, the people
// CRM (person_phones), the iMessage daemon, and the Contacts importer.
//
// iMessage handles arrive as "+12125552368"; Contacts may store "(212) 555-2368",
// "1-212-555-2368", etc. Collapsing to the last 10 digits makes a US number key on a
// single canonical value regardless of the "+1"/"1" country prefix or punctuation.
//
// Returns '' when there are no digits at all. For numbers with fewer than 10 digits
// (short codes, partial entries) it returns whatever digits exist — better a stable
// (if coarse) key than dropping the contact entirely.
export function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}
