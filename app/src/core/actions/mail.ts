/**
 * Mail actions — IMAP search, message fetch, folders, parts and attachment saving.
 *
 * The privacy split is structural, not a convention: `mailSearch` can only ever return
 * header/metadata summaries because that is all `searchMail` produces. Bodies come from
 * `mailGetMessage`, and attachment BYTES only from `mailSaveAttachment`, one named part at a
 * time. Every read is BODY.PEEK, so none of this marks mail as seen.
 */

import { fetchPart, getMessage, listFolders, listParts, searchMail } from '@postbote/imap';
import type {
  FolderDTO,
  MailMessageDTO,
  MailPartDTO,
  MailSummaryDTO,
  SaveAttachmentResult,
} from '@postbote/protocol';
import { decodingSink, safeFileName } from '@postbote/protocol';
import { attachmentsDir, ensureDownloadDir, FileSink, resolveDownloadPath } from '@postbote/store';
import { ATTACHMENT_BYTES, BODY_CHARS, capLimit, MAIL_LIMIT } from './limits.ts';

/** Mail search params; folder defaults to INBOX, and no account means all of them. */
export interface MailSearchParams {
  accountId?: string;
  folder?: string;
  allFolders?: boolean;
  /** Free text across headers and body (IMAP `TEXT`). */
  query?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  /** Body only, excluding headers. */
  body?: string;
  /** Date header ≥ this date. */
  since?: string;
  /** Date header < this date. */
  before?: string;
  /** Arrival (INTERNALDATE) ≥ this date. */
  receivedSince?: string;
  /** Arrival (INTERNALDATE) < this date. */
  receivedBefore?: string;
  unseen?: boolean;
  flagged?: boolean;
  limit?: number;
}

/** Single-message fetch params; `accountId` is required — it identifies the server. */
export interface MailGetMessageParams {
  accountId: string;
  uid: string;
  folder?: string;
  maxBodyChars?: number;
}

export interface MailListPartsParams {
  accountId: string;
  uid: string;
  folder?: string;
}

export interface MailSaveAttachmentParams {
  accountId: string;
  uid: string;
  folder?: string;
  /** IMAP section from `mailListParts`; omit to take the first attachment. */
  section?: string;
  /** Directory to save into. MCP callers never set this — see the tool. */
  directory?: string;
  /** Refuse a part larger than this, before any bytes are transferred. */
  maxBytes?: number;
}

/** Search mail headers/metadata; caps the count so a caller can't dump a mailbox. */
export async function mailSearch(params: MailSearchParams = {}): Promise<MailSummaryDTO[]> {
  return searchMail({
    accountId: params.accountId,
    folder: params.folder,
    allFolders: params.allFolders,
    text: params.query,
    from: params.from,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    body: params.body,
    since: params.since,
    before: params.before,
    receivedSince: params.receivedSince,
    receivedBefore: params.receivedBefore,
    unseen: params.unseen,
    flagged: params.flagged,
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

/** List the mailboxes of one or every account, with their resolved roles. */
export async function mailListFolders(accountId?: string): Promise<FolderDTO[]> {
  return listFolders(accountId);
}

/** List one message's parts, each with the section needed to save it. */
export async function mailListParts(params: MailListPartsParams): Promise<MailPartDTO[]> {
  return listParts(params);
}

/**
 * Save one attachment to disk and report where it landed.
 *
 * The filename is derived from the part's own metadata but never trusted as a path: it goes
 * through `safeFileName`, then `resolveDownloadPath` verifies the result is still inside the
 * target directory and picks a non-colliding name. The bytes are transfer-decoded on the way
 * through, so what lands on disk is the actual file rather than its base64 text.
 */
export async function mailSaveAttachment(params: MailSaveAttachmentParams): Promise<SaveAttachmentResult> {
  const directory = ensureDownloadDir(params.directory ?? attachmentsDir());
  const maxBytes = capLimit(params.maxBytes, ATTACHMENT_BYTES);

  let file: FileSink | null = null;
  const { info } = await fetchPart(
    {
      accountId: params.accountId,
      uid: params.uid,
      folder: params.folder,
      section: params.section,
      maxBytes,
    },
    (part) => {
      const name = safeFileName(part.filename, `uid-${params.uid}-part-${part.section}.bin`);
      file = new FileSink(resolveDownloadPath(directory, name));
      return decodingSink(part.encoding, file);
    },
  );

  // `file` is assigned by the callback above, which fetchPart always awaits before returning.
  const sink = file as unknown as FileSink;
  return {
    path: sink.path,
    // Read the final name back off the sink: resolveDownloadPath may have appended " (2)" to
    // avoid clobbering a file the user already had.
    filename: sink.path.slice(sink.path.lastIndexOf('/') + 1),
    // The DECODED size — what is on disk — not the larger base64 transfer.
    bytes: sink.bytesWritten,
    mimeType: info.mimeType,
    section: info.section,
  };
}
