/**
 * The backend ports: `MessageBackend` (network-neutral) and `MailBackend` (the mailbox driver).
 *
 * Every backend implements `MessageBackend` — a manifest plus its accounts — and is loaded
 * through the app's registry. HOW its messages are synced is a driver on top, picked by `kind`:
 * `mailbox` (folders, UIDs, UIDVALIDITY — IMAP-shaped, and the reason it is not forced into a
 * chat shape) and `chat` (dialogs with a per-chat monotonic message sequence, for server-archive
 * chat networks: Telegram, Matrix, XMPP with MAM). A delivery-only driver joins here with the
 * first network that needs it.
 *
 * The `MailBackend` interface is the load-bearing seam of the project. `@postbote/store` drives the sync
 * engine THROUGH it and never imports `@postbote/imap`, which is the only reason the most
 * intricate code here — incremental sync, UIDVALIDITY handling, expunge detection — can be
 * unit-tested on Node against a fake backend and an in-memory database, with no server, no
 * network and no GOA session.
 *
 * If you find yourself wanting to import `imap` from `store`, add a method here instead.
 */

import type { FolderInfo } from './list-parse.ts';
import type { AutomationHeaders } from './mail-headers.ts';
import type { BackendManifest, ParticipantAddress } from './messenger.ts';
import type { MailAddress } from './types.ts';

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
  /** Structured From, To and Cc — the participants of the conversation this message joins. */
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** Threading: the parent's Message-ID, and the whole References chain, oldest first. */
  inReplyTo: string | null;
  references: string[];
  /** The headers that mark bulk or machine mail — the classifier's input. */
  automation: AutomationHeaders;
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

/**
 * The network-neutral port every backend implements, built-in mail included.
 *
 * Small on purpose: what is common to every network is who it is (the manifest) and which
 * accounts it has. Everything about fetching belongs to the sync driver, selected by `kind`.
 */
export interface MessageBackend {
  readonly manifest: BackendManifest;
  /** Which sync driver this backend implements. The engine switches on it, never on the name. */
  readonly kind: string;
  listAccounts(): Promise<BackendAccount[]>;
  /**
   * Add an account interactively — for networks whose accounts live in postbote rather than in
   * the desktop (mail accounts are GNOME Online Accounts and do not implement this). The
   * backend asks through `prompter` for whatever its login needs, and stores the resulting
   * session itself. Resolves with the new account; nothing secret is in it.
   */
  addAccount?(prompter: AccountPrompter): Promise<BackendAccount>;
}

/** How a backend asks the user for login input, whatever the frontend is. */
export interface AccountPrompter {
  /** Ask for one value. `secret` input is not echoed and never logged. */
  ask(label: string, options?: { secret?: boolean }): Promise<string>;
  /** Progress to show the user. Never carries a secret. */
  notify(message: string): void;
}

/** The mailbox sync driver: folders, UIDs and flags, driven by `syncIndex` in `@postbote/store`. */
export interface MailBackend extends MessageBackend {
  readonly kind: 'mailbox';
  connect(accountId: string): Promise<BackendSession>;
}

/** Narrow a registry entry to the mailbox driver. */
export function isMailBackend(backend: MessageBackend): backend is MailBackend {
  return backend.kind === 'mailbox';
}

// ── construction ────────────────────────────────────────────────────────

/**
 * What the registry hands a backend when it constructs one. Everything a backend may know about
 * its surroundings comes through here, so a backend never reads the config file or picks a
 * directory on its own — and a test can construct one against a temporary directory.
 */
export interface BackendContext {
  /**
   * The backend's own block from the config (`backends.<name>.settings`), as written. The
   * backend validates what it reads: only it knows what its settings mean.
   */
  settings: Readonly<Record<string, string | number | boolean>>;
  /** The process environment, for values a user keeps out of the config file. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * A private directory (mode 0700) for this backend's secret state — session keys, crypto
   * stores. Separate from the index: the index is rebuildable, this is not, and a backup
   * treats the two differently (`secret` vs `derived`).
   */
  secretsDir: string;
}

// ── the chat driver ─────────────────────────────────────────────────────

/** One person, bot or channel as a chat network reports it. */
export interface ChatPeer {
  /** The network's id for this peer, unique within the account. Opaque to postbote. */
  remoteId: string;
  displayName: string | null;
  /** Every address the network knows for this peer, already normalized (`normalizeAddress`). */
  addresses: ParticipantAddress[];
  /** The network marks this peer as a bot. */
  bot: boolean;
}

/** One chat (a dialog): a direct chat, a group, or a one-way broadcast channel. */
export interface ChatInfo {
  remoteId: string;
  kind: 'direct' | 'group' | 'broadcast';
  title: string | null;
  /** The peers known to be in it, the user excluded — for a direct chat, the other person. */
  members: ChatPeer[];
  /** Sequence number of the newest message, or null for an empty chat. */
  lastSeq: number | null;
  /** Everything at or below this sequence has been read by the user (null: unknown). */
  readInboxSeq: number | null;
  /** Everything the user sent at or below this sequence has been read by the other side. */
  readOutboxSeq: number | null;
}

/** One message in a chat. */
export interface ChatMessage {
  /** The network's message id, opaque to postbote and unique within the account. */
  remoteId: string;
  /** Monotonic within its chat: the sync cursor. */
  seq: number;
  sentAt: string | null;
  editedAt: string | null;
  /** Null when the sender is the user (`fromSelf`) or not disclosed by the network. */
  sender: ChatPeer | null;
  fromSelf: boolean;
  text: string | null;
  hasAttachments: boolean;
  replyToRemoteId: string | null;
  /** The thread or forum topic, when the network has them. */
  threadRemoteId: string | null;
}

/** One page of history. */
export interface ChatHistoryPage {
  /** The messages people wrote, oldest first — service notices (joins, pins) left out. */
  messages: ChatMessage[];
  /**
   * The highest sequence the page covered, service notices included — the next cursor. Null
   * when the page was empty.
   */
  highestSeq: number | null;
  /** The lowest sequence the page covered, service notices included. Null when empty. */
  lowestSeq: number | null;
  /** True when nothing newer exists: the chat is caught up. */
  exhausted: boolean;
  /**
   * True when nothing OLDER exists either: the page reaches back to the chat's first message.
   * Together with `lowestSeq`/`highestSeq` this says which range the page covers completely —
   * the range in which a stored message the page does not contain was deleted on the server.
   */
  reachedStart: boolean;
}

/** One connected chat account. Closed by the engine when it is done. */
export interface ChatSession {
  /** Every chat of the account, most recently active first. */
  listChats(): Promise<ChatInfo[]>;
  /**
   * History of one chat.
   *
   * With `afterSeq` null: the newest `limit` messages — the first sync of a chat takes a window,
   * not its whole past. With a number: the oldest `limit` messages strictly newer than it, so
   * repeated calls walk forward without a gap. Implementations must never return a message at
   * or below `afterSeq`.
   */
  fetchHistory(chatRemoteId: string, afterSeq: number | null, limit: number): Promise<ChatHistoryPage>;
  close(): Promise<void>;
}

/** The chat sync driver: dialogs and per-chat sequences, driven by `syncChats` in `@postbote/store`. */
export interface ChatBackend extends MessageBackend {
  readonly kind: 'chat';
  connect(accountId: string): Promise<ChatSession>;
}

/** Narrow a registry entry to the chat driver. */
export function isChatBackend(backend: MessageBackend): backend is ChatBackend {
  return backend.kind === 'chat';
}
