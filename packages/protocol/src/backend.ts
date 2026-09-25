/**
 * The backend ports: `MessageBackend` (network-neutral) and `MailBackend` (the mailbox driver).
 *
 * Every backend implements `MessageBackend` — a manifest plus its accounts — and is loaded
 * through the app's registry. HOW its messages are synced is a driver on top, picked by `kind`:
 * `mailbox` (folders, UIDs, UIDVALIDITY — IMAP-shaped, and the reason it is not forced into a
 * chat shape) and `chat` (dialogs with a per-chat monotonic message sequence, for server-archive
 * chat networks: Telegram, Matrix, XMPP with MAM) and `delivery` (events pushed once by a
 * network with no server archive: WhatsApp, later Signal).
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
  /**
   * The archive's opaque id of the newest entry, for networks that page their archive by id
   * rather than by a number (XMPP MAM). When present — null for an empty chat — the engine
   * decides "caught up" by comparing it with the cursor it stored, not by `lastSeq`.
   */
  lastCursor?: string | null;
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
  /**
   * The archive's opaque id of the newest entry the page covered (the one `highestSeq` names),
   * for networks that page by id. Stored with the cursor and handed back as `afterCursor`.
   */
  highestCursor?: string | null;
  /** Earlier messages this page corrects (the network's edit message), by their remote id. */
  edits?: ChatEdit[];
  /**
   * Earlier messages this page retracts or a moderator removed, by remote id: they leave the
   * index. A message retracted inside the same page is simply not in `messages`.
   */
  retracted?: string[];
}

/** A correction of a message synced earlier: its new text replaces the stored one. */
export interface ChatEdit {
  remoteId: string;
  text: string | null;
  editedAt: string | null;
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
   *
   * `afterCursor` is the `highestCursor` of the page that ended at `afterSeq`, for networks that
   * page their archive by id; the others ignore it.
   */
  fetchHistory(
    chatRemoteId: string,
    afterSeq: number | null,
    limit: number,
    afterCursor?: string | null,
  ): Promise<ChatHistoryPage>;
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

// ── the delivery driver ─────────────────────────────────────────────────

/**
 * One chat as a delivery-only network describes it. There is no sequence to walk: what the
 * network reports is the chat's identity, and — when it knows them — its members.
 */
export interface DeliveryChat {
  remoteId: string;
  kind: ChatInfo['kind'];
  title: string | null;
  /** The peers known to be in it, the user excluded. Null: this report says nothing about members. */
  members: ChatPeer[] | null;
}

/**
 * One thing that happened, as a delivery-only network pushes it. A delivery session turns the
 * network's own events into these, so the store engine applies them without naming a network.
 *
 * Every event names its chat by `chatRemoteId`; a message may arrive before any `chat` event
 * for its chat (a new chat), which is why it carries the chat's kind itself.
 */
export type DeliveryEvent =
  /** A chat appeared or changed (title, members). */
  | { type: 'chat'; chat: DeliveryChat }
  /** The user read the chat on another device: all but the newest `unreadCount` incoming messages are read. */
  | { type: 'chat-read'; chatRemoteId: string; unreadCount: number }
  /**
   * Two chat ids turned out to be one chat (a network that addresses a person two ways, and
   * told which ids belong together only later): everything stored under `from` moves to
   * `into`. Message remote ids stay as they are. A no-op when nothing is stored under `from`.
   */
  | { type: 'chat-merged'; from: string; into: string }
  /** The user deleted the chat on another device: it goes here too, with its messages. */
  | { type: 'chat-deleted'; chatRemoteId: string }
  /** The user cleared the chat's messages on another device; the chat itself stays. */
  | { type: 'chat-cleared'; chatRemoteId: string }
  /** What the network knows about a person changed (a name, a newly known address). */
  | { type: 'peer'; peer: ChatPeer }
  /**
   * One message. `seq` orders it within its chat (a delivery network has no server sequence,
   * so it is usually the send time). `seen` is whether the user has read it already.
   */
  | {
      type: 'message';
      chatRemoteId: string;
      chatKind: ChatInfo['kind'];
      message: ChatMessage;
      seen: boolean;
    }
  /** A message was edited. Applies to a stored message only; an edit of one never stored is dropped. */
  | { type: 'edit'; chatRemoteId: string; remoteId: string; text: string | null; editedAt: string | null }
  /** A message was deleted (revoked for everyone, or deleted for the user on another device). */
  | { type: 'delete'; chatRemoteId: string; remoteId: string }
  /** The other side read these messages of the user. */
  | { type: 'peer-read'; chatRemoteId: string; remoteIds: string[] };

/**
 * How long a delivery session runs.
 *
 * `catch-up` is `postbote sync`: connect, receive what was queued while nobody listened (and, on
 * a freshly linked device, the history the network hands over once), and end when that is done.
 * `follow` is a daemon: keep receiving until closed. Both go through the same receive path, so a
 * daemon is `catch-up` that does not stop.
 */
export type DeliveryMode = 'catch-up' | 'follow';

export interface DeliveryConnectOptions {
  mode: DeliveryMode;
}

/** How a delivery session ended — reported, never hidden. */
export interface DeliveryOutcome {
  /** True when the session saw the network say its backlog was delivered; false when it gave up waiting. */
  caughtUp: boolean;
  /** A reason the session ended early (the network logged the device out, the connection dropped). */
  error: string | null;
}

/** One connected delivery-only account. */
export interface DeliverySession {
  /**
   * The next batch of events, in arrival order. Resolves null when the session is over: in
   * `catch-up` mode once the backlog is delivered, in `follow` mode only after `close`.
   *
   * Delivery is at most once on these networks — the server forgets a message once this device
   * acknowledged it — so the engine writes every batch before asking for the next one, and
   * asking IS the acknowledgement: a session that journals what it received may drop the
   * previous batch from its journal then, and must keep it when the session is closed without
   * another call (the write failed).
   */
  nextBatch(): Promise<DeliveryEvent[] | null>;
  /** How the session ended; meaningful once `nextBatch` resolved null. */
  outcome(): DeliveryOutcome;
  close(): Promise<void>;
}

/**
 * The delivery sync driver: for networks without a server archive (WhatsApp, Signal), driven by
 * `receiveDeliveries` in `@postbote/store`. What it writes is the only copy (`state`).
 */
export interface DeliveryBackend extends MessageBackend {
  readonly kind: 'delivery';
  connect(accountId: string, options: DeliveryConnectOptions): Promise<DeliverySession>;
}

/** Narrow a registry entry to the delivery driver. */
export function isDeliveryBackend(backend: MessageBackend): backend is DeliveryBackend {
  return backend.kind === 'delivery';
}
