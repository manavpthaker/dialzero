/**
 * Decode the NSString payload used by Messages.app when `message.text` is
 * NULL and the visible body exists only in the typedstream `attributedBody`.
 *
 * Keep this shared between live delivery and historical backfill. Treat an
 * unrecognized archive as unreadable instead of guessing at arbitrary bytes.
 */
export function decodeIMessageAttributedBody(
  value: Buffer | null | undefined,
): string | null {
  if (!value || value.length === 0) return null;
  const marker = value.indexOf('NSString', 0, 'latin1');
  if (marker === -1) return null;

  let cursor = marker + 'NSString'.length;
  while (cursor < value.length && value[cursor] !== 0x2b && value[cursor] !== 0x2a) {
    cursor += 1;
  }
  if (cursor >= value.length) return null;
  cursor += 1;
  if (cursor >= value.length) return null;

  const lengthMarker = value[cursor];
  let length: number;
  let start: number;
  if (lengthMarker === 0x81) {
    if (cursor + 2 >= value.length) return null;
    length = value.readUInt16LE(cursor + 1);
    start = cursor + 3;
  } else if (lengthMarker === 0x82) {
    if (cursor + 4 >= value.length) return null;
    length = value.readUInt32LE(cursor + 1);
    start = cursor + 5;
  } else {
    length = lengthMarker;
    start = cursor + 1;
  }

  if (length <= 0 || start + length > value.length) return null;
  const text = value.subarray(start, start + length).toString('utf8').trim();
  return text || null;
}

