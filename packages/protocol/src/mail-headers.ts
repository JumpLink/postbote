/**
 * The mail headers that threading and classification need, and nothing else.
 *
 * ENVELOPE carries In-Reply-To but not References, and none of the bulk-mail markers, so the
 * sync fetch asks for exactly these fields with `BODY.PEEK[HEADER.FIELDS (…)]` — a few hundred
 * bytes per message instead of the whole header block, and PEEK so `\Seen` is never set.
 */

import type { ImapValue } from './imap-parse.ts';
import { parseHeaders } from './mime-parse.ts';
import { decodeRfc2047 } from './rfc2047.ts';

/** Raw values of the headers the conversational/automated classifier reads. Null when absent. */
export interface AutomationHeaders {
  listId: string | null;
  listUnsubscribe: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
}

/** The header fields fetched per message during sync. */
export const THREAD_HEADER_FIELDS: readonly string[] = [
  'REFERENCES',
  'IN-REPLY-TO',
  'LIST-ID',
  'LIST-UNSUBSCRIBE',
  'AUTO-SUBMITTED',
  'PRECEDENCE',
];

/** The FETCH item that asks for them without setting `\Seen`. */
export function threadHeaderFetchItem(): string {
  return `BODY.PEEK[HEADER.FIELDS (${THREAD_HEADER_FIELDS.join(' ')})]`;
}

/**
 * Pull the `BODY[HEADER.FIELDS (…)]` literal out of a tokenized FETCH response.
 *
 * Matched by prefix, because the server echoes the field list in its own spelling and order —
 * comparing it against what was sent would miss a server that normalises the case.
 */
export function extractHeaderFields(items: ImapValue[]): string {
  for (let i = 0; i + 1 < items.length; i += 2) {
    if (/^BODY\[HEADER\.FIELDS[ \]]/i.test(String(items[i]))) {
      const value = items[i + 1];
      return typeof value === 'string' ? value : '';
    }
  }
  return '';
}

/**
 * Every `<message-id>` in a References or In-Reply-To value, in order, duplicates dropped.
 *
 * Only the bracketed form counts. In-Reply-To in the wild also carries prose (`<id> (Anna's
 * message of Monday)`) and some clients write bare ids; a bare token that is not bracketed is
 * too ambiguous to thread on, so it is ignored rather than guessed at.
 */
export function parseMessageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
    const id = `<${match[1]}>`;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface ThreadHeaders {
  references: string[];
  inReplyTo: string | null;
  automation: AutomationHeaders;
}

/** Parse the fetched header block into threading and classification input. */
export function parseThreadHeaders(block: string): ThreadHeaders {
  const headers = parseHeaders(block);
  const get = (name: string): string | null => {
    const value = headers.get(name)?.trim();
    return value ? decodeRfc2047(value) : null;
  };
  const inReplyTo = parseMessageIdList(headers.get('in-reply-to'));
  return {
    references: parseMessageIdList(headers.get('references')),
    inReplyTo: inReplyTo[0] ?? null,
    automation: {
      listId: get('list-id'),
      listUnsubscribe: get('list-unsubscribe'),
      autoSubmitted: get('auto-submitted'),
      precedence: get('precedence'),
    },
  };
}
