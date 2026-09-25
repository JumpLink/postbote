/**
 * Pure IMAP response parsing (RFC 3501) — no `gi://`, no I/O. The GJS mail
 * backend (mail.gjs.ts) does the socket work and feeds raw response text here;
 * keeping the grammar pure makes it unit-testable on Node with synthetic data
 * (no live server, no PII).
 *
 * Literal handling: the reader replaces each `{n}` literal with the placeholder
 * `\0<index>\0` and collects the literal contents in a parallel array, so this
 * tokenizer can stay a plain string parser yet round-trip 8-bit data.
 */

import { decodeRfc2047 } from './rfc2047.ts';
import type { MailAddress } from './types.ts';

/** A parsed IMAP value: a list, a string, or null (NIL). */
export type ImapValue = ImapValue[] | string | null;

/** Literal placeholder marker. NUL never occurs in IMAP response text, so a
 * literal is unambiguously delimited as `\0<index>\0`. */
const PLACEHOLDER = '\u0000';

/**
 * Wrap a literal's index as the inline placeholder the tokenizer resolves back
 * against the `literals` array. The reader (mail.gjs.ts) splices this into the
 * response text in place of a `{n}` literal, keeping the marker defined in one
 * place rather than hard-coded at the call site.
 */
export function imapLiteralPlaceholder(index: number): string {
  return `${PLACEHOLDER}${index}${PLACEHOLDER}`;
}

/**
 * Tokenize a single IMAP value (atom / quoted-string / NIL / parenthesized
 * list) starting at the first non-space char. Returns the value and the index
 * just past it. `literals` resolves `\0k\0` placeholders.
 */
function parseValue(s: string, pos: number, literals: string[]): { value: ImapValue; next: number } {
  let i = pos;
  while (i < s.length && s[i] === ' ') i++;
  const ch = s[i];

  if (ch === '(') {
    i++;
    const list: ImapValue[] = [];
    while (i < s.length) {
      while (i < s.length && s[i] === ' ') i++;
      if (s[i] === ')') {
        i++;
        break;
      }
      const parsed = parseValue(s, i, literals);
      list.push(parsed.value);
      i = parsed.next;
    }
    return { value: list, next: i };
  }

  if (ch === '"') {
    i++;
    let str = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) {
        str += s[i + 1];
        i += 2;
      } else {
        str += s[i];
        i++;
      }
    }
    i++; // closing quote
    return { value: str, next: i };
  }

  if (ch === PLACEHOLDER) {
    i++;
    let digits = '';
    while (i < s.length && s[i] !== PLACEHOLDER) {
      digits += s[i];
      i++;
    }
    i++; // closing marker
    return { value: literals[Number.parseInt(digits, 10)] ?? '', next: i };
  }

  // Atom: run until space or paren. Unquoted "NIL" means null.
  let atom = '';
  while (i < s.length && s[i] !== ' ' && s[i] !== ')' && s[i] !== '(' && s[i] !== PLACEHOLDER) {
    // A FETCH section is part of its key even when it holds spaces and parens:
    // `BODY[HEADER.FIELDS (REFERENCES LIST-ID)]` is ONE atom. Split at the space, it becomes
    // three tokens and every later key/value pair of the response shifts by one.
    if (s[i] === '[' && /^(BODY|BINARY)(\.PEEK)?$/i.test(atom)) {
      const close = s.indexOf(']', i);
      if (close > i) {
        atom += s.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    atom += s[i];
    i++;
  }
  return { value: atom.toUpperCase() === 'NIL' ? null : atom, next: i };
}

/** Tokenize the parenthesized list at/after the first '(' in `text`. */
export function tokenizeImapList(text: string, literals: string[] = []): ImapValue[] {
  const open = text.indexOf('(');
  if (open < 0) return [];
  const parsed = parseValue(text, open, literals);
  return Array.isArray(parsed.value) ? parsed.value : [];
}

/** One address tuple from an ENVELOPE address list: [name, adl, mailbox, host]. */
function toMailAddress(tuple: ImapValue): MailAddress | null {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const name = typeof tuple[0] === 'string' ? decodeRfc2047(tuple[0]) : null;
  const mailbox = typeof tuple[2] === 'string' ? tuple[2] : null;
  const host = typeof tuple[3] === 'string' ? tuple[3] : null;
  if (!mailbox || !host) return null; // group start/end markers → skip
  return { name: name && name.length > 0 ? name : null, email: `${mailbox}@${host}` };
}

function toAddressList(value: ImapValue): MailAddress[] {
  if (!Array.isArray(value)) return [];
  const result: MailAddress[] = [];
  for (const tuple of value) {
    const addr = toMailAddress(tuple);
    if (addr) result.push(addr);
  }
  return result;
}

export interface ParsedEnvelope {
  subject: string | null;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** ISO-8601, or null if the Date header was absent/unparseable. */
  date: string | null;
  messageId: string | null;
  /** The In-Reply-To field, verbatim (usually one `<id>`), or null. */
  inReplyTo: string | null;
}

/**
 * Map an ENVELOPE structure (RFC 3501 §7.4.2):
 * [date, subject, from, sender, reply-to, to, cc, bcc, in-reply-to, message-id]
 */
export function parseEnvelope(env: ImapValue): ParsedEnvelope {
  const a = Array.isArray(env) ? env : [];
  const rawDate = typeof a[0] === 'string' ? a[0] : null;
  const ms = rawDate ? Date.parse(rawDate) : Number.NaN;
  return {
    date: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
    subject: typeof a[1] === 'string' ? decodeRfc2047(a[1]) : null,
    from: toAddressList(a[2]),
    to: toAddressList(a[5]),
    cc: toAddressList(a[6]),
    messageId: typeof a[9] === 'string' ? a[9] : null,
    inReplyTo: typeof a[8] === 'string' && a[8].trim() ? a[8] : null,
  };
}

export interface ParsedFetch {
  uid: string | null;
  flags: string[];
  size: number | null;
  envelope: ImapValue;
  /** INTERNALDATE (arrival) as an ISO-8601 string, or null. */
  internalDate: string | null;
  /** The BODYSTRUCTURE value, for the part walker. */
  bodyStructure: ImapValue;
}

/**
 * Parse the attribute list of a FETCH response item into the fields we use.
 * `items` is the tokenized parenthesized list (key value key value …).
 */
export function parseFetchAttributes(items: ImapValue[]): ParsedFetch {
  const result: ParsedFetch = {
    uid: null,
    flags: [],
    size: null,
    envelope: null,
    internalDate: null,
    bodyStructure: null,
  };
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = String(items[i]).toUpperCase();
    const value = items[i + 1];
    switch (key) {
      case 'UID':
        result.uid = typeof value === 'string' ? value : null;
        break;
      case 'FLAGS':
        result.flags = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
        break;
      case 'RFC822.SIZE':
        result.size = typeof value === 'string' ? Number.parseInt(value, 10) : null;
        break;
      case 'ENVELOPE':
        result.envelope = value;
        break;
      case 'INTERNALDATE': {
        // IMAP's own date-time form, e.g. `17-Jul-2026 09:44:12 +0200`. Date.parse handles it
        // once the day/month separator is a space rather than a hyphen.
        const raw = typeof value === 'string' ? value.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$2 $1 $3') : '';
        const ms = raw ? Date.parse(raw) : Number.NaN;
        result.internalDate = Number.isNaN(ms) ? null : new Date(ms).toISOString();
        break;
      }
      case 'BODYSTRUCTURE':
        result.bodyStructure = value;
        break;
    }
  }
  return result;
}

/** True if a given IMAP flag (e.g. "\\Seen") is present. */
export function hasFlag(flags: string[], flag: string): boolean {
  return flags.some((f) => f.toLowerCase() === flag.toLowerCase());
}

/** Quote a string for use as an IMAP quoted-string argument. */
/**
 * True when every code unit is ASCII.
 *
 * Decides whether a SEARCH argument can go on the command line as a quoted string or has to be
 * sent as a `CHARSET UTF-8` synchronizing literal — so it is protocol logic, and pure enough to
 * test. Written as a loop rather than a character-class regex: the range includes control
 * characters, which is correct here but is exactly what `no-control-regex` exists to flag.
 */
export function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Extract a `BODY[<section>]` literal from a tokenized FETCH attribute list.
 *
 * Matches the BRACKETED form only. An earlier version tested `startsWith('BODY')`, which also
 * matched `BODYSTRUCTURE` — whose value is a list, not a string — so the moment a FETCH asked
 * for both (which fetching a specific part requires) it silently returned an empty body.
 * Pass the section to pick a part: `''` is the whole message, `'2.1'` a nested one.
 */
export function extractBodySection(items: ImapValue[], section = ''): string {
  const want = `BODY[${section}]`;
  for (let i = 0; i + 1 < items.length; i += 2) {
    if (String(items[i]).toUpperCase() === want) {
      return typeof items[i + 1] === 'string' ? (items[i + 1] as string) : '';
    }
  }
  return '';
}

export function quoteImapString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Format a YYYY-MM-DD date as the IMAP SEARCH date form (e.g. 14-Jun-2026). */
export function formatImapDate(isoDate: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) throw new Error(`invalid date: ${isoDate}`);
  return `${Number.parseInt(m[3], 10)}-${months[Number.parseInt(m[2], 10) - 1]}-${m[1]}`;
}

/** Parse the space-separated UID list of a `* SEARCH …` untagged response. */
export function parseSearchUids(text: string): number[] {
  const m = /^\*\s+SEARCH\b(.*)$/im.exec(text);
  if (!m) return [];
  return m[1]
    .trim()
    .split(/\s+/)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}
