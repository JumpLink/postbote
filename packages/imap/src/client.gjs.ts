/**
 * Minimal IMAP client (GJS-only): connect, login, select, search, fetch.
 *
 * Speaks the subset of RFC 3501 this project needs. All response and MIME parsing lives in the
 * pure @postbote/protocol modules — this file is socket plumbing and command sequencing only.
 *
 * Privacy: the password is pulled from the target's `getPassword()` thunk at login and never
 * logged, stored, or returned.
 */

import GLib from 'gi://GLib?version=2.0';
import type Gio from 'gi://Gio?version=2.0';

import {
  bytesToLatin1,
  formatImapDate,
  GnomeError,
  imapLiteralPlaceholder,
  isAscii,
  type MailTarget,
  parseSearchUids,
  quoteImapString,
} from '@postbote/protocol';
import { ByteReader, openTlsStream } from './transport.gjs.ts';

export interface ImapResponse {
  ok: boolean;
  status: string;
  lines: string[];
  literals: string[];
  text: string;
}

export class ImapClient {
  private conn!: Gio.IOStream;
  private reader!: ByteReader;
  private output!: Gio.OutputStream;
  private tag = 0;

  async connect(target: MailTarget): Promise<void> {
    this.conn = await openTlsStream(target);
    this.reader = new ByteReader(this.conn.get_input_stream());
    this.output = this.conn.get_output_stream();
    const greeting = await this.reader.readLine();
    if (!greeting || !/^\*\s+(OK|PREAUTH)/i.test(greeting)) {
      throw new GnomeError(`unexpected IMAP greeting from ${target.host}`);
    }
  }

  private async write(text: string): Promise<void> {
    await this.output.write_all_async(new TextEncoder().encode(text), GLib.PRIORITY_DEFAULT, null);
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
    return { ok: status === 'OK', status, lines, literals, text: lines.join('\n') };
  }

  private async command(cmd: string): Promise<ImapResponse> {
    const tag = `a${++this.tag}`;
    await this.write(`${tag} ${cmd}\r\n`);
    return this.readResponse(tag);
  }

  async login(user: string, password: string): Promise<void> {
    const r = await this.command(`LOGIN ${quoteImapString(user)} ${quoteImapString(password)}`);
    if (!r.ok) throw new GnomeError('IMAP LOGIN failed (check credentials in GNOME Online Accounts)');
  }

  async select(folder: string): Promise<void> {
    const r = await this.command(`SELECT ${quoteImapString(folder)}`);
    if (!r.ok) throw new GnomeError(`IMAP SELECT ${folder} failed`);
  }

  /** Run a UID SEARCH for the given criteria; returns matching UIDs. */
  async searchUids(options: { query?: string; unseenOnly?: boolean; since?: string }): Promise<number[]> {
    const criteria: string[] = [];
    if (options.unseenOnly) criteria.push('UNSEEN');
    if (options.since) criteria.push(`SINCE ${formatImapDate(options.since)}`);
    const query = options.query?.trim();

    let response: ImapResponse;
    if (!query) {
      response = await this.command(`UID SEARCH ${criteria.length ? criteria.join(' ') : 'ALL'}`);
    } else if (isAscii(query)) {
      response = await this.command(
        `UID SEARCH ${[...criteria, `TEXT ${quoteImapString(query)}`].join(' ')}`,
      );
    } else {
      response = await this.searchWithUtf8Literal(criteria, query);
    }
    if (!response.ok) throw new GnomeError('IMAP SEARCH failed');
    return parseSearchUids(response.text);
  }

  /** SEARCH with a non-ASCII query sent as a synchronizing UTF-8 literal. */
  private async searchWithUtf8Literal(criteria: string[], query: string): Promise<ImapResponse> {
    const tag = `a${++this.tag}`;
    const queryBytes = new TextEncoder().encode(query);
    await this.write(
      `${tag} UID SEARCH CHARSET UTF-8 ${[...criteria, 'TEXT'].join(' ')} {${queryBytes.length}}\r\n`,
    );
    const cont = await this.reader.readLine();
    if (!cont || !cont.startsWith('+')) throw new GnomeError('IMAP server refused literal for SEARCH');
    const payload = new Uint8Array(queryBytes.length + 2);
    payload.set(queryBytes);
    payload.set([0x0d, 0x0a], queryBytes.length);
    await this.output.write_all_async(payload, GLib.PRIORITY_DEFAULT, null);
    return this.readResponse(tag);
  }

  /** FETCH header/metadata for a set of UIDs. */
  async fetchSummaries(uids: number[]): Promise<ImapResponse> {
    return this.command(`UID FETCH ${uids.join(',')} (UID FLAGS RFC822.SIZE ENVELOPE)`);
  }

  /** FETCH a single message in full (UID + flags + envelope + raw body). */
  async fetchFull(uid: string): Promise<ImapResponse> {
    return this.command(`UID FETCH ${uid} (UID FLAGS RFC822.SIZE ENVELOPE BODY.PEEK[])`);
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
