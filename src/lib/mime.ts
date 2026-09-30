/**
 * Minimal RFC 822 / MIME reader — enough to turn a raw fetched email into
 * { headers, plaintext body }, with no dependencies.
 *
 * Deliberately dependency-free: this runs on the mini inside the assistant
 * process, and the alternative (mailparser + its transitive tree) is a large
 * surface to add for header unfolding and two transfer encodings. Scope is
 * exactly what a reply poller needs — read a prospect's reply,
 * identify the thread, keep the text verbatim. It is NOT a general MIME
 * implementation: no nested-multipart recursion beyond one level of
 * alternative/mixed, no non-Latin single-byte charsets, no S/MIME.
 */

export interface ParsedMail {
  headers: Map<string, string[]>;
  from: string;          // bare address, lowercased
  fromDisplay: string;   // full "Name <addr>" as sent, decoded
  to: string;
  subject: string;
  date: string;          // raw Date header
  messageId: string;
  inReplyTo: string;
  references: string[];
  body: string;          // best-effort plaintext
  isAutoReply: boolean;
}

/** Split a raw message into its header block and body. */
function splitMessage(raw: Buffer): { head: string; body: Buffer } {
  for (const sep of ['\r\n\r\n', '\n\n']) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) return { head: raw.subarray(0, idx).toString('utf8'), body: raw.subarray(idx + sep.length) };
  }
  return { head: raw.toString('utf8'), body: Buffer.alloc(0) };
}

/** Unfold continuation lines and index headers by lowercased name. */
function parseHeaders(head: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const unfolded: string[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ' ' + line.trim();
    else unfolded.push(line);
  }
  for (const line of unfolded) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  }
  return map;
}

function decodeCharset(buf: Buffer, charset: string): string {
  const cs = charset.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cs === 'utf8' || cs === 'utf' || cs === 'usascii' || cs === 'ascii' || cs === '') {
    return buf.toString('utf8');
  }
  if (cs === 'iso88591' || cs === 'latin1' || cs === 'windows1252' || cs === 'cp1252') {
    return buf.toString('latin1');
  }
  // Unknown charset: utf8 is the least-bad guess and never throws.
  return buf.toString('utf8');
}

function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '=') {
      const pair = text.slice(i + 1, i + 3);
      if (/^\r?\n/.test(text.slice(i + 1))) {         // soft line break
        i += text[i + 1] === '\r' ? 2 : 1;
        continue;
      }
      if (/^[0-9a-fA-F]{2}$/.test(pair)) { out.push(parseInt(pair, 16)); i += 2; continue; }
    }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/** Decode RFC 2047 encoded-words ("=?UTF-8?Q?Re=3A_hi?=") in a header value. */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset, enc, text) => {
    try {
      const buf = String(enc).toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : decodeQuotedPrintable(String(text).replace(/_/g, ' '));
      return decodeCharset(buf, String(charset));
    } catch {
      return String(text);
    }
  });
}

/** Pull the bare address out of a From/To header value, lowercased. */
export function bareAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  const candidate = angled ? angled[1] : value;
  const m = candidate.match(/[^\s<>,;"()]+@[^\s<>,;"()]+/);
  return m ? m[0].trim().toLowerCase() : '';
}

/** Extract every <...> message id from a References / In-Reply-To header. */
export function messageIds(value: string): string[] {
  return (value.match(/<[^>\s]+>/g) || []).map((s) => s.trim());
}

function paramOf(headerValue: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*"?([^";\\s]+)"?`, 'i').exec(headerValue);
  return m ? m[1] : '';
}

/**
 * Walk a (possibly multipart) body and return the best plaintext rendering.
 * Prefers text/plain; falls back to text/html with tags stripped.
 */
function extractText(body: Buffer, contentType: string, encoding: string, depth = 0): string {
  const type = contentType.toLowerCase();

  if (type.startsWith('multipart/') && depth < 4) {
    const boundary = paramOf(contentType, 'boundary');
    if (boundary) {
      const parts = body.toString('binary').split(`--${boundary}`);
      let html = '';
      for (const part of parts) {
        if (!part.trim() || part.trim() === '--') continue;
        const partBuf = Buffer.from(part.replace(/^\r?\n/, ''), 'binary');
        const { head, body: pBody } = splitMessage(partBuf);
        const pHeaders = parseHeaders(head);
        const pType = pHeaders.get('content-type')?.[0] || 'text/plain';
        const pEnc = pHeaders.get('content-transfer-encoding')?.[0] || '7bit';
        const text = extractText(pBody, pType, pEnc, depth + 1);
        if (!text.trim()) continue;
        if (/^text\/plain/i.test(pType)) return text;   // plain wins outright
        if (/^text\/html/i.test(pType) && !html) html = text;
        if (/^multipart\//i.test(pType)) return text;
      }
      return html;
    }
  }

  let decoded: Buffer;
  const enc = encoding.trim().toLowerCase();
  const asText = body.toString('binary');
  if (enc === 'base64') decoded = Buffer.from(asText.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') decoded = decodeQuotedPrintable(asText);
  else decoded = Buffer.from(asText, 'binary');

  let text = decodeCharset(decoded, paramOf(contentType, 'charset'));
  if (/^text\/html/i.test(type)) {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n');
  }
  return text.replace(/\r\n/g, '\n').trim();
}

/** Headers that mark a message as machine-generated (vacation responder, etc.). */
function detectAutoReply(headers: Map<string, string[]>): boolean {
  const auto = headers.get('auto-submitted')?.[0] || '';
  if (auto && !/^no$/i.test(auto.trim())) return true;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return true;
  const precedence = headers.get('precedence')?.[0] || '';
  if (/auto_reply|bulk|junk/i.test(precedence)) return true;
  return false;
}

export function parseMail(raw: Buffer): ParsedMail {
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const h = (name: string) => headers.get(name)?.[0] || '';

  const fromRaw = h('from');
  const contentType = h('content-type') || 'text/plain';
  const encoding = h('content-transfer-encoding') || '7bit';

  return {
    headers,
    from: bareAddress(fromRaw),
    fromDisplay: decodeEncodedWords(fromRaw),
    to: bareAddress(h('to')),
    subject: decodeEncodedWords(h('subject')),
    date: h('date'),
    messageId: (messageIds(h('message-id'))[0] || '').trim(),
    inReplyTo: (messageIds(h('in-reply-to'))[0] || '').trim(),
    references: messageIds(h('references')),
    body: extractText(body, contentType, encoding),
    isAutoReply: detectAutoReply(headers),
  };
}
