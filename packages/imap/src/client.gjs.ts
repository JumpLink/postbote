/**
 * Minimal IMAP client (GJS-only): connect, login, select, list, search, fetch.
 *
 * Speaks the subset of RFC 3501 this project needs. All response and MIME parsing lives in the
 * pure @postbote/protocol modules — this file is socket plumbing and command sequencing only.
 *
 * Privacy: the password is pulled from the target's `getPassword()` thunk at login and never
 * logged, stored, or returned. Every body read uses BODY.PEEK, so nothing here can set \Seen.
 */

import GLib from 'gi://GLib?version=2.0';
import type Gio from 'gi://Gio?version=2.0';

import {
  bytesToLatin1,
  buildSearchPlan,
  type FolderInfo,
  GnomeError,
  imapLiteralPlaceholder,
  type LiteralSink,
  type MailSearchCriteria,
  type MailTarget,
  parseFolderList,
  parseSearchUids,
  planHasLiterals,
  quoteImapString,
  renderSearchPlan,
  type SearchPart,
} from '@postbote/protocol';
import { ByteReader, openTlsStream } from './transport.gjs.ts';

export interface ImapResponse {
  ok: boolean;
  status: string;
  lines: string[];
  literals: string[];
  text: string;
}

/** Mailbox state reported by SELECT/EXAMINE — the cursor an incremental sync resumes from. */
export interface MailboxStatus {
  uidValidity: number | null;
  uidNext: number | null;
  exists: number;
}

/** Outcome of a streamed part transfer. */
export interface FetchStreamResult {
  bytes: number;
  /** True when the part was larger than the cap and nothing was written. */
  refused: boolean;
  declaredSize: number;
}

export class ImapClient {
  private conn!: Gio.IOStream;
  private reader!: ByteReader;
  private output!: Gio.OutputStream;
  private tag = 0;
  private capabilities = new Set<string>();

  async connect(target: MailTarget): Promise<void> {
    this.conn = await openTlsStream(target);
    this.reader = new ByteReader(this.conn.get_input_stream());
    this.output = this.conn.get_output_stream();
    const greeting = await this.reader.readLine();
    if (!greeting || !/^\*\s+(OK|PREAUTH)/i.test(greeting)) {
      throw new GnomeError(`unexpected IMAP greeting from ${target.host}`);
    }
    this.collectCapabilities(greeting);
  }

  private collectCapabilities(text: string): void {
    const m = /\[?CAPABILITY\s+([^\]\r\n]+)\]?/i.exec(text);
    if (!m) return;
    for (const cap of m[1].trim().split(/\s+/)) this.capabilities.add(cap.toUpperCase());
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability.toUpperCase());
  }

  private async write(text: string): Promise<void> {
    await this.output.write_all_async(new TextEncoder().encode(text), GLib.PRIORITY_DEFAULT, null);
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    await this.output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null);
  }

  /** Read a tagged response, inlining server literals as `\0idx\0` placeholders. */
  private async readResponse(tag: string): Promise<ImapResponse> {
    const literals: string[] = [];
    const lines: string[] = [];
    let status = '';
    for (;;) {
      let line = await this.reader.readLine();
      if (line === null) throw new GnomeError('IMAP connection closed unexpectedly');
      // A literal `{n}` is always at the end of a line; there may be several.
      for (;;) {
        const m = /\{(\d+)\}$/.exec(line);
        if (!m) break;
        const litBytes = await this.reader.readBytes(Number.parseInt(m[1], 10));
        const idx = literals.length;
        literals.push(bytesToLatin1(litBytes));
        line = `${line.slice(0, m.index)}${imapLiteralPlaceholder(idx)}`;
        const cont = await this.reader.readLine();
        if (cont === null) break;
        line += cont;
      }
      lines.push(line);
      if (line.startsWith(`${tag} `)) {
        const m = new RegExp(`^${tag}\\s+(OK|NO|BAD)`, 'i').exec(line);
        status = m ? m[1].toUpperCase() : '';
        break;
      }
    }
    const response = { ok: status === 'OK', status, lines, literals, text: lines.join('\n') };
    this.collectCapabilities(response.text);
    return response;
  }

  private nextTag(): string {
    return `a${++this.tag}`;
  }

  private async command(cmd: string): Promise<ImapResponse> {
    const tag = this.nextTag();
    await this.write(`${tag} ${cmd}\r\n`);
    return this.readResponse(tag);
  }

  /**
   * Send a command whose arguments include non-ASCII values, as synchronizing literals.
   *
   * ONE code path for any number of literals in any position. The previous implementation could
   * only send a single literal, hard-coded as SEARCH's final TEXT argument, so a second
   * non-ASCII criterion was silently impossible to express.
   */
  private async commandWithLiterals(parts: SearchPart[]): Promise<ImapResponse> {
    const tag = this.nextTag();
    let pending = `${tag} `;
    for (const part of parts) {
      if (typeof part === 'string') {
        pending += part;
        continue;
      }
      const bytes = new TextEncoder().encode(part.literal);
      // Announce the literal, then WAIT for the server's `+` before sending its bytes. Sending
      // early (a non-synchronizing literal) needs the LITERAL+ capability, which not every
      // server has, and desynchronizes the connection when it does not.
      await this.write(`${pending}{${bytes.length}}\r\n`);
      const cont = await this.reader.readLine();
      if (!cont || !cont.startsWith('+')) {
        throw new GnomeError(`IMAP server refused a literal: ${cont ?? 'connection closed'}`);
      }
      await this.writeBytes(bytes);
      pending = '';
    }
    await this.write(`${pending}\r\n`);
    return this.readResponse(tag);
  }

  async login(user: string, password: string): Promise<void> {
    const r = await this.command(`LOGIN ${quoteImapString(user)} ${quoteImapString(password)}`);
    if (!r.ok) throw new GnomeError('IMAP LOGIN failed (check credentials in GNOME Online Accounts)');
  }

  /**
   * SELECT a mailbox and return its cursor state.
   *
   * `path` must be the WIRE name (modified UTF-7). Passing a display name is how non-ASCII
   * mailboxes used to fail — see `encodeMutf7`.
   */
  async select(path: string): Promise<MailboxStatus> {
    const r = await this.command(`SELECT ${quoteImapString(path)}`);
    if (!r.ok) throw new GnomeError(`IMAP SELECT ${path} failed`);
    const num = (re: RegExp): number | null => {
      const m = re.exec(r.text);
      return m ? Number.parseInt(m[1], 10) : null;
    };
    return {
      uidValidity: num(/\[UIDVALIDITY\s+(\d+)\]/i),
      uidNext: num(/\[UIDNEXT\s+(\d+)\]/i),
      exists: num(/^\*\s+(\d+)\s+EXISTS/im) ?? 0,
    };
  }

  /** Open a mailbox read-only. Cannot set \Seen even by accident. */
  async examine(path: string): Promise<MailboxStatus> {
    const r = await this.command(`EXAMINE ${quoteImapString(path)}`);
    if (!r.ok) throw new GnomeError(`IMAP EXAMINE ${path} failed`);
    const num = (re: RegExp): number | null => {
      const m = re.exec(r.text);
      return m ? Number.parseInt(m[1], 10) : null;
    };
    return {
      uidValidity: num(/\[UIDVALIDITY\s+(\d+)\]/i),
      uidNext: num(/\[UIDNEXT\s+(\d+)\]/i),
      exists: num(/^\*\s+(\d+)\s+EXISTS/im) ?? 0,
    };
  }

  /**
   * List every mailbox, with role resolution.
   *
   * Prefers `LIST (SPECIAL-USE)` when the server advertises RFC 6154, so roles come from the
   * server rather than from guessing at names; falls back to a plain LIST otherwise.
   */
  async listFolders(): Promise<FolderInfo[]> {
    if (this.has('SPECIAL-USE')) {
      const r = await this.command('LIST "" "*" RETURN (SPECIAL-USE)');
      if (r.ok) return parseFolderList(r.lines, r.literals);
      // Some servers advertise the capability and still reject the RETURN clause; fall through.
    }
    const r = await this.command('LIST "" "*"');
    if (!r.ok) throw new GnomeError('IMAP LIST failed');
    return parseFolderList(r.lines, r.literals);
  }

  /**
   * Run a UID SEARCH for the given criteria; returns matching UIDs.
   *
   * An all-ASCII query takes the plain single-line path and never touches the literal protocol.
   * If a UTF-8 search is rejected with `[BADCHARSET]`, it is retried without the CHARSET clause
   * — some servers only match ASCII then, so the caller is told the result is approximate
   * rather than being handed a silently narrower answer.
   */
  async search(criteria: MailSearchCriteria): Promise<{ uids: number[]; approximate: boolean }> {
    const plan = buildSearchPlan(criteria);

    if (!planHasLiterals(plan)) {
      const r = await this.command(`UID SEARCH ${renderSearchPlan(plan)}`);
      if (!r.ok) throw new GnomeError('IMAP SEARCH failed');
      return { uids: parseSearchUids(r.text), approximate: false };
    }

    const withCharset: SearchPart[] = [`UID SEARCH CHARSET ${plan.charset} `, ...plan.parts];
    const r = await this.commandWithLiterals(withCharset);
    if (r.ok) return { uids: parseSearchUids(r.text), approximate: false };

    if (/BADCHARSET/i.test(r.text)) {
      const retry = await this.commandWithLiterals(['UID SEARCH ', ...plan.parts]);
      if (!retry.ok) throw new GnomeError('IMAP SEARCH failed (server rejected UTF-8)');
      return { uids: parseSearchUids(retry.text), approximate: true };
    }
    throw new GnomeError('IMAP SEARCH failed');
  }

  /** FETCH header/metadata for a set of UIDs. */
  async fetchSummaries(uids: number[]): Promise<ImapResponse> {
    return this.command(`UID FETCH ${uids.join(',')} (UID FLAGS RFC822.SIZE ENVELOPE)`);
  }

  /** FETCH header/metadata plus the part tree, for indexing and for listing attachments. */
  async fetchSummariesWithStructure(uids: number[]): Promise<ImapResponse> {
    return this.command(
      `UID FETCH ${uids.join(',')} (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE)`,
    );
  }

  /** FETCH a single message in full (UID + flags + envelope + raw body). */
  async fetchFull(uid: string): Promise<ImapResponse> {
    return this.command(`UID FETCH ${uid} (UID FLAGS RFC822.SIZE ENVELOPE BODY.PEEK[])`);
  }

  /** FETCH one message's part tree. */
  async fetchStructure(uid: string): Promise<ImapResponse> {
    return this.command(`UID FETCH ${uid} (UID BODYSTRUCTURE)`);
  }

  /** FETCH one decoded-in-place section, buffered. Only for parts known to be small. */
  async fetchSection(uid: string, section: string): Promise<ImapResponse> {
    return this.command(`UID FETCH ${uid} (BODY.PEEK[${section}])`);
  }

  /**
   * Stream one part into a sink, checking its size BEFORE any bytes are transferred.
   *
   * The cap is enforced against the literal's declared length, so an oversized attachment costs
   * one round trip rather than a download that is abandoned halfway. When it is refused the
   * bytes are still drained off the socket — skipping that would leave the connection
   * desynchronized and every subsequent command would read the attachment as its response.
   */
  async fetchSectionTo(
    uid: string,
    section: string,
    sink: LiteralSink,
    maxBytes: number,
  ): Promise<FetchStreamResult> {
    const tag = this.nextTag();
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[${section}])\r\n`);

    let declaredSize = 0;
    let written = 0;
    let refused = false;
    let sawLiteral = false;

    for (;;) {
      const line = await this.reader.readLine();
      if (line === null) throw new GnomeError('IMAP connection closed mid-transfer');

      const m = /\{(\d+)\}$/.exec(line);
      if (m && !sawLiteral) {
        sawLiteral = true;
        declaredSize = Number.parseInt(m[1], 10);
        if (declaredSize > maxBytes) {
          refused = true;
          await this.reader.skipBytes(declaredSize);
        } else {
          written = await this.reader.pipeBytes(declaredSize, (chunk) => sink.write(chunk));
        }
        continue;
      }
      if (line.startsWith(`${tag} `)) {
        const ok = /^\S+\s+OK/i.test(line);
        if (!ok) {
          await sink.abort(`IMAP FETCH of uid ${uid} section ${section} failed`);
          throw new GnomeError(`IMAP FETCH of uid ${uid} section ${section} failed`);
        }
        break;
      }
    }

    if (refused) {
      await sink.abort(`part is ${declaredSize} bytes, over the ${maxBytes}-byte limit`);
      return { bytes: 0, refused: true, declaredSize };
    }
    if (!sawLiteral) {
      await sink.abort(`no such part: ${section}`);
      throw new GnomeError(`message uid ${uid} has no part ${section}`);
    }
    if (written < declaredSize) {
      // A short read means EOF mid-literal: the file would be silently truncated.
      await sink.abort(`transfer ended early (${written} of ${declaredSize} bytes)`);
      throw new GnomeError(`IMAP transfer of uid ${uid} section ${section} ended early`);
    }
    await sink.close();
    return { bytes: written, refused: false, declaredSize };
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      // ignore — we are tearing down anyway
    }
    try {
      this.conn.close(null);
    } catch {
      // ignore
    }
  }
}
