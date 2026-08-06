/**
 * The `MailBackend` port.
 *
 * This interface is the load-bearing seam of the project. `@postbote/store` drives the sync
 * engine THROUGH it and never imports `@postbote/imap`, which is the only reason the most
 * intricate code here — incremental sync, UIDVALIDITY handling, expunge detection — can be
 * unit-tested on Node against a fake backend and an in-memory database, with no server, no
 * network and no GOA session.
 *
 * If you find yourself wanting to import `imap` from `store`, add a method here instead.
 */

import type { FolderInfo } from './list-parse.ts';

/** Mailbox cursor state, as reported by SELECT/EXAMINE. */
export interface BackendMailboxStatus {
  uidValidity: number | null;
  uidNext: number | null;
  exists: number;
}

/** One message's indexable metadata, as the backend reports it. */
export interface BackendMessage {
  uid: number;
  messageId: string | null;
  subject: string | null;
  /** Formatted senders, e.g. `Name <a@b.c>`, comma-joined. */
  sender: string;
  /** Formatted To + Cc, comma-joined. */
  recipients: string;
  /** Date header as ISO-8601, or null. */
  date: string | null;
  /** INTERNALDATE (arrival) as ISO-8601, or null. */
  internalDate: string | null;
  size: number | null;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  attachments: Array<{ section: string; filename: string | null; mimeType: string; size: number }>;
  /** Plain-text body, already decoded and capped. Null when none could be extracted. */
  bodyText: string | null;
}

/** Just the parts needed to detect a flag change or an expunge. */
export interface BackendFlagState {
  uid: number;
  seen: boolean;
  flagged: boolean;
}

/** One connected account session. Closed by the engine when it is done. */
export interface BackendSession {
  listFolders(): Promise<FolderInfo[]>;
  /** Open a mailbox READ-ONLY and report its cursor state. */
  openFolder(path: string): Promise<BackendMailboxStatus>;
  /**
   * Fetch indexable metadata + body for every UID strictly greater than `afterUid`.
   * Implementations must not return UIDs at or below it — `<n>:*` always yields at least the
   * highest existing UID even when `n` is past the end, which is the classic RFC 3501 trap.
   */
  fetchNewer(path: string, afterUid: number, batchSize: number): Promise<BackendMessage[]>;
  /** Every live UID with its flags — the set IS the live set, so expunges fall out of it. */
  listFlags(path: string): Promise<BackendFlagState[]>;
  close(): Promise<void>;
}

/** One account the engine can sync. */
export interface BackendAccount {
  id: string;
  identity: string;
  provider: string;
}

export interface MailBackend {
  listAccounts(): Promise<BackendAccount[]>;
  connect(accountId: string): Promise<BackendSession>;
}
