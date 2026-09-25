/**
 * The delivery sync engine — the `delivery` driver's counterpart of `syncChats`.
 *
 * Model (delivery only, ADR 0001 §2): the network pushes every message once and forgets it as
 * soon as this device acknowledged it. There is no history to walk and nothing to re-fetch, so
 * what this engine writes is the ONLY copy — the rows it owns are `state` in the backup sense,
 * not `derived` like the rest of the index.
 *
 * Driven entirely through the `DeliveryBackend` port, so it runs on Node against a fake backend
 * and `:memory:`. It never names a network. The same function serves `postbote sync` (mode
 * `catch-up`: receive the backlog, then stop) and a later daemon (mode `follow`: keep going).
 *
 * The rows are the chat tables `syncChats` writes (`conversation_messages`, `chat_peers`,
 * `chat_members`, `chat_cursors`), so conversations, participants, the address-book link and
 * every read path treat a delivered chat exactly like an archived one. `last_seq` in the cursor
 * is the newest message's sequence; the read markers stay null — read state arrives as events.
 *
 * Every batch is written in ONE transaction before the next one is asked for: the server has
 * already forgotten those messages. Executions are a per-process budget (gjsify gap, unfixed,
 * gjsify#1838 — see `insertMany`), so a batch costs a fixed handful of statements plus its
 * multi-row inserts, never one statement per message. Edits of stored messages are the one
 * per-item statement: they are rare.
 */

import type {
  ChatMessage,
  ChatPeer,
  DeliveryBackend,
  DeliveryChat,
  DeliveryEvent,
  DeliveryMode,
  DeliverySession,
  ParticipantAddress,
} from '@postbote/protocol';
import { chatConversationId, classifyChatMessage } from './chat-sync.ts';
import type { IndexDatabase } from './db.ts';
import { insertMany, placeholders, type SqlValue, withTransaction } from './db.ts';
import { upsertAccount } from './index-store.ts';
import { stableId } from './threads.ts';

export interface DeliverySyncOptions {
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** `catch-up` (the default) stops once the backlog is in; `follow` runs until the session closes. */
  mode?: DeliveryMode;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
}

export interface DeliveryAccountSyncResult {
  backend: string;
  accountId: string;
  /** Batches received and written. */
  batches: number;
  /** Messages written. */
  added: number;
  /** Stored messages whose text changed. */
  edited: number;
  /** Messages and chats deleted on the network (or on the user's other device) and removed here. */
  removed: number;
  /** True when the session saw the backlog end; false when it stopped waiting for it. */
  caughtUp: boolean;
  /** An error that stopped the account (connect, a dropped session, a failed write). */
  error: string | null;
}

export interface DeliverySyncResult {
  accounts: DeliveryAccountSyncResult[];
  added: number;
  removed: number;
  errors: number;
  /** True when EVERY account failed — the only case that is an error overall. */
  failed: boolean;
}

interface KnownChat {
  kind: DeliveryChat['kind'];
  title: string | null;
  lastSeq: number | null;
}

interface KnownPeer {
  displayName: string | null;
  addresses: ParticipantAddress[];
  bot: boolean;
}

/** The account's chats and peers as stored — loaded once per account, kept current in memory. */
interface AccountState {
  chats: Map<string, KnownChat>;
  peers: Map<string, KnownPeer>;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseAddresses(json: unknown): ParticipantAddress[] {
  try {
    const parsed = JSON.parse(String(json ?? '[]')) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (a): a is ParticipantAddress => typeof a?.kind === 'string' && typeof a?.value === 'string',
        )
      : [];
  } catch {
    // Written with JSON.stringify by this engine or `syncChats`; a damaged row starts empty.
    return [];
  }
}

function loadState(db: IndexDatabase, backend: string, accountId: string): AccountState {
  const chatRows = db
    .prepare(
      `SELECT c.chat_id, c.kind, c.last_seq, v.title FROM chat_cursors c
         LEFT JOIN conversations v ON v.id = c.conversation_id
        WHERE c.backend = ? AND c.account_id = ?`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  const peerRows = db
    .prepare(
      'SELECT peer_id, display_name, addresses_json, is_bot FROM chat_peers WHERE backend = ? AND account_id = ?',
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  return {
    chats: new Map(
      chatRows.map((r) => [
        String(r.chat_id),
        { kind: String(r.kind) as KnownChat['kind'], title: str(r.title), lastSeq: num(r.last_seq) },
      ]),
    ),
    peers: new Map(
      peerRows.map((r) => [
        String(r.peer_id),
        {
          displayName: str(r.display_name),
          addresses: parseAddresses(r.addresses_json),
          bot: Number(r.is_bot) === 1,
        },
      ]),
    ),
  };
}

/** The row id of a delivered message — the same derivation `syncChats` uses. */
export function deliveredMessageId(
  backend: string,
  accountId: string,
  chatRemoteId: string,
  remoteId: string,
): string {
  return stableId('m-', chatConversationId(backend, accountId, chatRemoteId), remoteId);
}

interface PendingMessage {
  chatRemoteId: string;
  chatKind: DeliveryChat['kind'];
  message: ChatMessage;
  seen: boolean;
  peerRead: boolean;
}

/** One batch folded into the statements it needs, in event order. */
class DeliveryBatch {
  readonly messages = new Map<string, PendingMessage>();
  readonly deletedMessages = new Set<string>();
  readonly deletedChats = new Set<string>();
  readonly clearedChats = new Set<string>();
  readonly edits = new Map<
    string,
    { text: string | null; editedAt: string | null; conversationId: string }
  >();
  readonly peerRead = new Set<string>();
  readonly chatRead = new Map<string, number>();
  readonly touchedChats = new Set<string>();
  readonly touchedPeers = new Set<string>();
  readonly members = new Map<string, SqlValue[]>();
  /** Counted as events are folded; a message deleted in the same batch still counts once as removed. */
  added = 0;
  edited = 0;
  removed = 0;

  readonly backend: string;
  readonly accountId: string;
  readonly state: AccountState;

  constructor(backend: string, accountId: string, state: AccountState) {
    this.backend = backend;
    this.accountId = accountId;
    this.state = state;
  }

  private conversationId(chatRemoteId: string): string {
    return chatConversationId(this.backend, this.accountId, chatRemoteId);
  }

  private rowId(chatRemoteId: string, remoteId: string): string {
    return deliveredMessageId(this.backend, this.accountId, chatRemoteId, remoteId);
  }

  /** Merge a peer into what is known: a name or an address is never lost to a report that lacks it. */
  private peer(peer: ChatPeer): void {
    const known = this.state.peers.get(peer.remoteId);
    const addresses = [...(known?.addresses ?? [])];
    for (const a of peer.addresses) {
      if (!addresses.some((b) => b.kind === a.kind && b.value === a.value)) addresses.push(a);
    }
    const merged: KnownPeer = {
      displayName: peer.displayName ?? known?.displayName ?? null,
      addresses,
      bot: peer.bot || (known?.bot ?? false),
    };
    this.state.peers.set(peer.remoteId, merged);
    this.touchedPeers.add(peer.remoteId);
  }

  private member(chatRemoteId: string, peer: ChatPeer): void {
    this.peer(peer);
    const conversationId = this.conversationId(chatRemoteId);
    this.members.set(`${conversationId}\u0000${peer.remoteId}`, [
      conversationId,
      this.backend,
      this.accountId,
      peer.remoteId,
    ]);
  }

  private chat(chatRemoteId: string, kind: DeliveryChat['kind'], title?: string | null): KnownChat {
    const known = this.state.chats.get(chatRemoteId);
    const next: KnownChat = {
      kind,
      // A report without a title keeps the one already known.
      title: title === undefined || title === null ? (known?.title ?? null) : title,
      lastSeq: known?.lastSeq ?? null,
    };
    this.state.chats.set(chatRemoteId, next);
    this.touchedChats.add(chatRemoteId);
    return next;
  }

  apply(event: DeliveryEvent): void {
    switch (event.type) {
      case 'chat': {
        this.chat(event.chat.remoteId, event.chat.kind, event.chat.title);
        for (const m of event.chat.members ?? []) this.member(event.chat.remoteId, m);
        return;
      }
      case 'peer':
        this.peer(event.peer);
        return;
      case 'message': {
        const { chatRemoteId, message } = event;
        const known = this.chat(chatRemoteId, this.state.chats.get(chatRemoteId)?.kind ?? event.chatKind);
        if (message.seq > (known.lastSeq ?? Number.NEGATIVE_INFINITY)) known.lastSeq = message.seq;
        if (!message.fromSelf && message.sender) this.member(chatRemoteId, message.sender);
        const id = this.rowId(chatRemoteId, message.remoteId);
        this.deletedMessages.delete(id);
        if (!this.messages.has(id)) this.added++;
        this.messages.set(id, {
          chatRemoteId,
          chatKind: known.kind,
          message,
          seen: message.fromSelf || event.seen,
          peerRead: false,
        });
        return;
      }
      case 'edit': {
        const id = this.rowId(event.chatRemoteId, event.remoteId);
        const pending = this.messages.get(id);
        if (pending) {
          pending.message = { ...pending.message, text: event.text, editedAt: event.editedAt };
        } else if (!this.deletedMessages.has(id)) {
          this.edits.set(id, {
            text: event.text,
            editedAt: event.editedAt,
            conversationId: this.conversationId(event.chatRemoteId),
          });
          this.touchedChats.add(event.chatRemoteId);
        }
        this.edited++;
        return;
      }
      case 'delete': {
        const id = this.rowId(event.chatRemoteId, event.remoteId);
        if (this.messages.delete(id)) this.added--;
        this.edits.delete(id);
        this.deletedMessages.add(id);
        this.removed++;
        if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        return;
      }
      case 'peer-read': {
        for (const remoteId of event.remoteIds) {
          const id = this.rowId(event.chatRemoteId, remoteId);
          const pending = this.messages.get(id);
          if (pending) pending.peerRead = true;
          else this.peerRead.add(id);
        }
        if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        return;
      }
      case 'chat-read': {
        this.chatRead.set(event.chatRemoteId, Math.max(0, Math.floor(event.unreadCount)));
        if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        return;
      }
      case 'chat-cleared':
      case 'chat-deleted': {
        for (const [id, pending] of this.messages) {
          if (pending.chatRemoteId === event.chatRemoteId) {
            this.messages.delete(id);
            this.added--;
          }
        }
        for (const [id, edit] of this.edits) {
          if (edit.conversationId === this.conversationId(event.chatRemoteId)) this.edits.delete(id);
        }
        if (event.type === 'chat-cleared') {
          this.clearedChats.add(event.chatRemoteId);
          if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        } else {
          this.deletedChats.add(event.chatRemoteId);
          this.state.chats.delete(event.chatRemoteId);
          this.touchedChats.delete(event.chatRemoteId);
          for (const key of this.members.keys()) {
            if (key.startsWith(`${this.conversationId(event.chatRemoteId)}\u0000`)) this.members.delete(key);
          }
        }
        this.removed++;
        return;
      }
    }
  }
}

const IN_CHUNK = 100;

function runIn(
  db: IndexDatabase,
  sql: (placeholders: string) => string,
  ids: readonly string[],
  ...lead: SqlValue[]
): void {
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    db.prepare(sql(placeholders(chunk.length))).run(...lead, ...chunk);
  }
}

function messageRow(batch: DeliveryBatch, id: string, pending: PendingMessage): SqlValue[] {
  const { message: m } = pending;
  const verdict = classifyChatMessage({ kind: pending.chatKind }, m);
  const sender = m.fromSelf ? null : m.sender;
  const address = sender?.addresses[0] ?? null;
  return [
    id,
    chatConversationId(batch.backend, batch.accountId, pending.chatRemoteId),
    batch.backend,
    batch.accountId,
    'bubble',
    sender?.displayName ?? null,
    address?.kind ?? null,
    address?.value ?? null,
    m.fromSelf ? 1 : 0,
    m.sentAt,
    pending.seen ? 1 : 0,
    m.hasAttachments ? 1 : 0,
    verdict.classification,
    verdict.reason,
    m.remoteId,
    m.text,
    m.seq,
    sender?.remoteId ?? null,
    m.editedAt,
    m.replyToRemoteId,
    m.threadRemoteId,
    pending.peerRead ? 1 : 0,
  ];
}

function writeBatch(db: IndexDatabase, batch: DeliveryBatch, syncedAt: string): void {
  const { backend, accountId, state } = batch;
  const conv = (chatRemoteId: string) => chatConversationId(backend, accountId, chatRemoteId);
  withTransaction(db, () => {
    // Deletions first: words the user or the sender took back must not outlive that here.
    runIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, [...batch.deletedMessages]);
    const cleared = [...batch.clearedChats, ...batch.deletedChats].map(conv);
    runIn(db, (p) => `DELETE FROM conversation_messages WHERE conversation_id IN (${p})`, cleared);
    const gone = [...batch.deletedChats].map(conv);
    for (const table of ['chat_members', 'chat_cursors', 'conversation_participants', 'conversations']) {
      const column = table === 'conversations' ? 'id' : 'conversation_id';
      runIn(db, (p) => `DELETE FROM ${table} WHERE ${column} IN (${p})`, gone);
    }

    const touched = [...batch.touchedChats].filter((id) => state.chats.has(id));
    // A replace resets the aggregates; the UPDATE below recomputes them in this transaction.
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversations
         (id, backend, account_id, kind, title, classification, classification_reason)`,
      touched.map((id) => {
        const chat = state.chats.get(id) as KnownChat;
        const broadcast = chat.kind === 'broadcast';
        return [
          conv(id),
          backend,
          accountId,
          chat.kind === 'direct' ? 'direct' : 'group',
          chat.title,
          broadcast ? 'automated' : 'conversational',
          broadcast ? 'broadcast' : 'chat-member',
        ];
      }),
    );
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversation_messages
         (id, conversation_id, backend, account_id, presentation, sender_name, sender_kind,
          sender_address, from_self, sent_at, seen, has_attachments, classification, classification_reason,
          remote_id, body, remote_seq, sender_peer_id, edited_at, reply_to_remote_id, thread_remote_id, peer_read)`,
      [...batch.messages].map(([id, pending]) => messageRow(batch, id, pending)),
    );
    for (const [id, edit] of batch.edits) {
      db.prepare('UPDATE conversation_messages SET body = ?, edited_at = ? WHERE id = ?').run(
        edit.text,
        edit.editedAt,
        id,
      );
    }
    runIn(db, (p) => `UPDATE conversation_messages SET peer_read = 1 WHERE from_self = 1 AND id IN (${p})`, [
      ...batch.peerRead,
    ]);
    // Read on another device: everything but the newest `unread` incoming messages is read.
    for (const [chatRemoteId, unread] of batch.chatRead) {
      const id = conv(chatRemoteId);
      db.prepare(
        `UPDATE conversation_messages SET seen = CASE
           WHEN from_self = 1 THEN 1
           WHEN id IN (SELECT id FROM conversation_messages WHERE conversation_id = ? AND from_self = 0
                        ORDER BY remote_seq DESC, sent_at DESC LIMIT ?) THEN 0
           ELSE 1 END
         WHERE conversation_id = ?`,
      ).run(id, unread, id);
    }

    insertMany(
      db,
      'INSERT OR REPLACE INTO chat_peers (backend, account_id, peer_id, display_name, addresses_json, is_bot)',
      [...batch.touchedPeers].map((peerId) => {
        const peer = state.peers.get(peerId) as KnownPeer;
        return [
          backend,
          accountId,
          peerId,
          peer.displayName,
          JSON.stringify(peer.addresses),
          peer.bot ? 1 : 0,
        ];
      }),
    );
    // REPLACE, not IGNORE: libgda warns for every ignored insert (see chat-sync.ts).
    insertMany(db, 'INSERT OR REPLACE INTO chat_members (conversation_id, backend, account_id, peer_id)', [
      ...batch.members.values(),
    ]);
    insertMany(
      db,
      `INSERT OR REPLACE INTO chat_cursors
         (conversation_id, backend, account_id, chat_id, kind, last_seq, read_inbox_seq, read_outbox_seq, last_sync_at)`,
      touched.map((id) => {
        const chat = state.chats.get(id) as KnownChat;
        return [conv(id), backend, accountId, id, chat.kind, chat.lastSeq, null, null, syncedAt];
      }),
    );
    runIn(
      db,
      (p) => `UPDATE conversations SET
         message_count = (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         unread_count = (SELECT COUNT(*) FROM conversation_messages m
                          WHERE m.conversation_id = conversations.id AND m.from_self = 0 AND m.seen = 0),
         first_message_at = (SELECT MIN(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         last_message_at = (SELECT MAX(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         has_attachments = (SELECT COUNT(*) > 0 FROM conversation_messages m
                             WHERE m.conversation_id = conversations.id AND m.has_attachments = 1)
       WHERE id IN (${p})`,
      touched.map(conv),
    );
  });
}

async function receiveAccount(
  db: IndexDatabase,
  backend: DeliveryBackend,
  account: { id: string; identity: string; provider: string },
  mode: DeliveryMode,
  now: () => Date,
): Promise<DeliveryAccountSyncResult> {
  const name = backend.manifest.name;
  const result: DeliveryAccountSyncResult = {
    backend: name,
    accountId: account.id,
    batches: 0,
    added: 0,
    edited: 0,
    removed: 0,
    caughtUp: false,
    error: null,
  };
  upsertAccount(db, account);

  let session: DeliverySession;
  try {
    session = await backend.connect(account.id, { mode });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  const state = loadState(db, name, account.id);
  try {
    for (;;) {
      const events = await session.nextBatch();
      if (events === null) break;
      if (events.length === 0) continue;
      const batch = new DeliveryBatch(name, account.id, state);
      for (const event of events) batch.apply(event);
      // A failed write stops the account: asking for more would acknowledge messages that
      // then exist nowhere.
      writeBatch(db, batch, now().toISOString());
      result.batches++;
      result.added += batch.added;
      result.edited += batch.edited;
      result.removed += batch.removed;
    }
    const outcome = session.outcome();
    result.caughtUp = outcome.caughtUp;
    result.error = outcome.error;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      await session.close();
    } catch {
      // A failed goodbye does not undo what was written.
    }
  }
  return result;
}

/** Receive what every account of one delivery backend has queued, and write it to the index. */
export async function receiveDeliveries(
  db: IndexDatabase,
  backend: DeliveryBackend,
  options: DeliverySyncOptions = {},
): Promise<DeliverySyncResult> {
  const mode = options.mode ?? 'catch-up';
  const now = options.now ?? (() => new Date());
  const accounts = (await backend.listAccounts()).filter(
    (a) => !options.accountId || a.id === options.accountId,
  );
  const results: DeliveryAccountSyncResult[] = [];
  for (const account of accounts) results.push(await receiveAccount(db, backend, account, mode, now));
  const errors = results.filter((r) => r.error !== null).length;
  return {
    accounts: results,
    added: results.reduce((n, r) => n + r.added, 0),
    removed: results.reduce((n, r) => n + r.removed, 0),
    errors,
    failed: results.length > 0 && errors === results.length,
  };
}
