import { connect as tlsConnect, type TLSSocket } from 'tls';

/**
 * Minimal read-only IMAP4rev1 client over Node's built-in `tls`.
 *
 * Dependency-free on purpose. Built for a reply poller,
 * which needs four verbs — LOGIN, SELECT, UID SEARCH, UID FETCH — and must never
 * mutate the mailbox (it uses EXAMINE, the read-only SELECT, and BODY.PEEK so
 * nothing is marked \Seen behind the owner's back; their inbox is a human workspace,
 * not a queue this owns).
 *
 * The one genuinely fiddly part of IMAP is literals: a server line ending in
 * `{1234}` means "the next 1234 bytes are data, not protocol". A naive
 * line-splitter corrupts any message containing a CRLF-plus-tag-looking line.
 * `parseInto` below tracks literals explicitly.
 */

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs: number;
}

export type Segment =
  | { type: 'line'; value: string }
  | { type: 'literal'; value: Buffer };

export interface ImapResponse {
  ok: boolean;
  status: string;      // OK / NO / BAD
  detail: string;      // text of the tagged completion line
  segments: Segment[];
}

export class ImapError extends Error {}

/**
 * Literal-aware accumulator for one command's response.
 *
 * Split out from the socket so the fiddly part is testable without networking.
 * IMAP interleaves protocol lines with byte-counted literals: a line ending in
 * `{1234}` means the next 1234 bytes are DATA and must not be scanned for line
 * breaks or tags. Get this wrong and any message whose body contains a line
 * like "b7 OK done" truncates the response.
 */
export class ResponseAccumulator {
  private buffer: Buffer = Buffer.alloc(0);
  private literalRemaining = 0;
  readonly segments: Segment[] = [];
  done: ImapResponse | null = null;

  constructor(private tag: string) {}

  /** Feed received bytes; returns the completed response once the tag arrives. */
  push(chunk: Buffer): ImapResponse | null {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    return this.parse();
  }

  /** Bytes left over after the tagged completion (belong to the next command). */
  rest(): Buffer {
    return this.buffer;
  }

  private parse(): ImapResponse | null {
    if (this.done) return this.done;
    for (;;) {
      if (this.literalRemaining > 0) {
        if (this.buffer.length < this.literalRemaining) return null;  // need more bytes
        this.segments.push({ type: 'literal', value: this.buffer.subarray(0, this.literalRemaining) });
        this.buffer = this.buffer.subarray(this.literalRemaining);
        this.literalRemaining = 0;
        continue;
      }

      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) return null;
      const line = this.buffer.subarray(0, idx).toString('utf8');
      this.buffer = this.buffer.subarray(idx + 2);
      this.segments.push({ type: 'line', value: line });

      // `{123}` = synchronizing literal, `{123+}` = non-synchronizing.
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (lit) { this.literalRemaining = parseInt(lit[1], 10); continue; }

      if (line.startsWith(this.tag + ' ')) {
        const m = /^\S+\s+(OK|NO|BAD)\s*(.*)$/i.exec(line);
        const status = (m?.[1] || 'BAD').toUpperCase();
        this.done = { ok: status === 'OK', status, detail: m?.[2] || '', segments: this.segments };
        return this.done;
      }
    }
  }
}

export class ImapClient {
  private socket: TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private tagSeq = 0;
  private pending: {
    acc: ResponseAccumulator;
    resolve: (r: ImapResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(private cfg: ImapConfig) {}

  /** Connect and wait for the server greeting. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect(
        { host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host },
        () => {
          if (!socket.authorized && socket.authorizationError) {
            reject(new ImapError(`TLS not authorized: ${socket.authorizationError}`));
            socket.destroy();
            return;
          }
          resolve();
        },
      );
      socket.setTimeout(this.cfg.timeoutMs);
      socket.on('timeout', () => { socket.destroy(new ImapError('socket timeout')); });
      socket.on('error', (err) => {
        reject(err);
        this.failPending(err);
      });
      socket.on('close', () => this.failPending(new ImapError('connection closed')));
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      this.socket = socket;
    });
    // Consume the untagged greeting (`* OK ...`) before issuing commands.
    await this.waitForGreeting();
  }

  private greetingResolve: (() => void) | null = null;

  private waitForGreeting(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ImapError('no server greeting')), this.cfg.timeoutMs);
      this.greetingResolve = () => { clearTimeout(timer); resolve(); };
      this.drain();
    });
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (p) { this.pending = null; clearTimeout(p.timer); p.reject(err); }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.drain();
  }

  /**
   * Consume as much of the buffer as forms complete protocol units.
   * Literal-aware: after a line ending `{N}`, exactly N bytes are data.
   */
  private drain(): void {
    // Greeting phase: just wait for one complete line.
    if (this.greetingResolve) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) return;
      this.buffer = this.buffer.subarray(idx + 2);
      const done = this.greetingResolve;
      this.greetingResolve = null;
      done();
      return;
    }

    const p = this.pending;
    if (!p) return;

    const done = p.acc.push(this.buffer);
    this.buffer = Buffer.alloc(0);
    if (!done) return;
    // Anything past the tagged completion belongs to the next command.
    this.buffer = p.acc.rest();
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(done);
  }

  /** Issue one command and resolve when its tagged completion arrives. */
  command(text: string): Promise<ImapResponse> {
    if (!this.socket) return Promise.reject(new ImapError('not connected'));
    if (this.pending) return Promise.reject(new ImapError('a command is already in flight'));
    const tag = `b${++this.tagSeq}`;
    return new Promise<ImapResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => { this.pending = null; reject(new ImapError(`command timed out: ${text.split(' ')[0]}`)); },
        this.cfg.timeoutMs,
      );
      this.pending = { acc: new ResponseAccumulator(tag), resolve, reject, timer };
      this.socket!.write(`${tag} ${text}\r\n`, 'utf8');
      this.drain();   // bytes may already be buffered
    });
  }

  private async require(text: string, what: string): Promise<ImapResponse> {
    const r = await this.command(text);
    if (!r.ok) throw new ImapError(`${what} failed: ${r.status} ${r.detail}`);
    return r;
  }

  /** IMAP quoted-string: backslash-escape backslash and dquote. */
  private static quote(s: string): string {
    return `"${s.replace(/([\\"])/g, '\\$1')}"`;
  }

  async login(): Promise<void> {
    await this.require(
      `LOGIN ${ImapClient.quote(this.cfg.user)} ${ImapClient.quote(this.cfg.password)}`,
      'IMAP LOGIN',
    );
  }

  /** EXAMINE = SELECT without write access. Returns UIDVALIDITY when advertised. */
  async examine(mailbox: string): Promise<{ uidValidity: number }> {
    const r = await this.require(`EXAMINE ${ImapClient.quote(mailbox)}`, `IMAP EXAMINE ${mailbox}`);
    let uidValidity = 0;
    for (const seg of r.segments) {
      if (seg.type !== 'line') continue;
      const m = /UIDVALIDITY\s+(\d+)/i.exec(seg.value);
      if (m) uidValidity = parseInt(m[1], 10);
    }
    return { uidValidity };
  }

  /** UID SEARCH; returns matching UIDs ascending. */
  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.require(`UID SEARCH ${criteria}`, 'IMAP UID SEARCH');
    const uids: number[] = [];
    for (const seg of r.segments) {
      if (seg.type !== 'line') continue;
      const m = /^\*\s+SEARCH\b(.*)$/i.exec(seg.value);
      if (!m) continue;
      for (const tok of m[1].trim().split(/\s+/)) {
        const n = parseInt(tok, 10);
        if (Number.isFinite(n)) uids.push(n);
      }
    }
    return uids.sort((a, b) => a - b);
  }

  /**
   * UID FETCH one message's full RFC822 bytes, without setting \Seen.
   * Returns null when the UID has vanished (expunged between search and fetch).
   */
  async uidFetchRaw(uid: number): Promise<Buffer | null> {
    const r = await this.require(`UID FETCH ${uid} (BODY.PEEK[])`, `IMAP UID FETCH ${uid}`);
    for (const seg of r.segments) if (seg.type === 'literal') return seg.value;
    return null;
  }

  async logout(): Promise<void> {
    try { await this.command('LOGOUT'); } catch { /* closing anyway */ }
    this.close();
  }

  close(): void {
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }
}
