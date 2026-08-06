/**
 * Turning search criteria into an IMAP `SEARCH` command (RFC 3501 §6.4.4).
 *
 * Pure on purpose: the command is BUILT here and only WRITTEN by the client, so every criterion
 * — and every quoting decision — is unit-testable without a server. Quoting that breaks
 * silently is the failure mode this prevents: a mis-quoted argument does not error, it just
 * matches nothing.
 */

import { formatImapDate, isAscii, quoteImapString } from './imap-parse.ts';

/**
 * A piece of the command line. A `literal` must be sent as a synchronizing literal
 * (`{n}` → wait for `+` → bytes) because it contains non-ASCII; a plain string goes on the line
 * as-is.
 */
export type SearchPart = string | { literal: string };

export interface SearchPlan {
  /** `'UTF-8'` when any part is a literal, else null — the CHARSET argument SEARCH needs. */
  charset: string | null;
  parts: SearchPart[];
}

/**
 * What a caller can search for.
 *
 * `since`/`before` filter the **Date header** (`SENTSINCE`/`SENTBEFORE`), not `INTERNALDATE`.
 * That is deliberate: after a mailbox migration every message's INTERNALDATE is the *migration*
 * timestamp, so an arrival-date filter silently returns everything or nothing. Use
 * `receivedSince`/`receivedBefore` when arrival is genuinely what you mean.
 */
export interface MailSearchCriteria {
  /** Free text across headers and body (IMAP `TEXT`). */
  text?: string;
  /** Body only, excluding headers (IMAP `BODY`). */
  body?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  /** Date header ≥ this date, YYYY-MM-DD. */
  since?: string;
  /** Date header < this date, YYYY-MM-DD. */
  before?: string;
  /** Arrival (INTERNALDATE) ≥ this date, YYYY-MM-DD. */
  receivedSince?: string;
  /** Arrival (INTERNALDATE) < this date, YYYY-MM-DD. */
  receivedBefore?: string;
  unseen?: boolean;
  seen?: boolean;
  flagged?: boolean;
  /** Arbitrary header match, e.g. `{ name: 'List-Id', value: 'announce' }`. */
  header?: Array<{ name: string; value: string }>;
}

/** Emit `KEY <value>`, as a literal when the value is not ASCII. */
function textCriterion(key: string, value: string, parts: SearchPart[]): boolean {
  if (isAscii(value)) {
    parts.push(`${key} ${quoteImapString(value)}`);
    return false;
  }
  parts.push(`${key} `, { literal: value });
  return true;
}

/**
 * Build the SEARCH argument list.
 *
 * Order is fixed rather than driven by object key order: it keeps the command reproducible for
 * tests, and puts the cheap flag/date criteria first so a server can narrow before the
 * expensive full-text ones.
 */
export function buildSearchPlan(criteria: MailSearchCriteria = {}): SearchPlan {
  const parts: SearchPart[] = [];
  let needsUtf8 = false;

  if (criteria.unseen) parts.push('UNSEEN');
  if (criteria.seen) parts.push('SEEN');
  if (criteria.flagged) parts.push('FLAGGED');

  if (criteria.since) parts.push(`SENTSINCE ${formatImapDate(criteria.since)}`);
  if (criteria.before) parts.push(`SENTBEFORE ${formatImapDate(criteria.before)}`);
  if (criteria.receivedSince) parts.push(`SINCE ${formatImapDate(criteria.receivedSince)}`);
  if (criteria.receivedBefore) parts.push(`BEFORE ${formatImapDate(criteria.receivedBefore)}`);

  for (const [key, value] of [
    ['FROM', criteria.from],
    ['TO', criteria.to],
    ['CC', criteria.cc],
    ['SUBJECT', criteria.subject],
    ['BODY', criteria.body],
    ['TEXT', criteria.text],
  ] as const) {
    const trimmed = value?.trim();
    if (trimmed) needsUtf8 = textCriterion(key, trimmed, parts) || needsUtf8;
  }

  for (const { name, value } of criteria.header ?? []) {
    const field = name.trim();
    if (!field) continue;
    // The header FIELD is a token and always ASCII; only its value can need a literal.
    if (isAscii(value)) {
      parts.push(`HEADER ${quoteImapString(field)} ${quoteImapString(value)}`);
    } else {
      parts.push(`HEADER ${quoteImapString(field)} `, { literal: value });
      needsUtf8 = true;
    }
  }

  // SEARCH requires at least one key; ALL is the "no filter" one.
  if (parts.length === 0) parts.push('ALL');

  return { charset: needsUtf8 ? 'UTF-8' : null, parts };
}

/** True when the plan needs the literal/continuation protocol rather than one plain line. */
export function planHasLiterals(plan: SearchPlan): boolean {
  return plan.parts.some((p) => typeof p !== 'string');
}

/**
 * Render a plan as a single command line — the fast path for an all-ASCII query.
 *
 * THROWS when the plan contains literals rather than rendering them away. Silently dropping a
 * literal would produce a valid-looking SEARCH that omits the very criterion the caller asked
 * for, and a search that quietly ignores half its query is worse than one that fails.
 */
export function renderSearchPlan(plan: SearchPlan): string {
  if (planHasLiterals(plan)) {
    throw new Error('search plan contains literals — send it with commandWithLiterals()');
  }
  return (plan.parts as string[]).join(' ').replace(/\s+/g, ' ').trim();
}
