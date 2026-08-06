/**
 * Mail actions — IMAP search and single-message fetch.
 *
 * The privacy split is structural, not a convention: `mailSearch` can only ever return
 * header/metadata summaries because that is all `searchMail` produces. Bodies and attachment
 * metadata come solely from `mailGetMessage`, one explicitly named message at a time.
 */

import { getMessage, searchMail } from '@postbote/imap';
import type { MailMessageDTO, MailSummaryDTO } from '@postbote/protocol';
import { BODY_CHARS, capLimit, MAIL_LIMIT } from './limits.ts';

/** Mail search params; folder defaults to INBOX, and no account means all of them. */
export interface MailSearchParams {
  accountId?: string;
  folder?: string;
  query?: string;
  unseenOnly?: boolean;
  since?: string;
  limit?: number;
}

/** Single-message fetch params; `accountId` is required — it identifies the server. */
export interface MailGetMessageParams {
  accountId: string;
  uid: string;
  folder?: string;
  maxBodyChars?: number;
}

/** Search mail headers/metadata; caps the count so a caller can't dump a mailbox. */
export async function mailSearch(params: MailSearchParams = {}): Promise<MailSummaryDTO[]> {
  return searchMail({
    accountId: params.accountId,
    folder: params.folder,
    query: params.query,
    unseenOnly: params.unseenOnly,
    since: params.since,
    limit: capLimit(params.limit, MAIL_LIMIT),
  });
}

/** Fetch one full message (body + attachment metadata); caps the body length. */
export async function mailGetMessage(params: MailGetMessageParams): Promise<MailMessageDTO> {
  return getMessage({
    accountId: params.accountId,
    uid: params.uid,
    folder: params.folder,
    maxBodyChars: capLimit(params.maxBodyChars, BODY_CHARS),
  });
}
