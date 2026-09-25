/**
 * The chat sync engine — the `chat` driver's counterpart of `syncIndex`.
 *
 * Driven entirely through the `ChatBackend` port, so it runs on Node against a fake backend and
 * `:memory:`, exactly like the mail engine. It never names a network.
 *
 * Model (server archive, ADR 0001 §2): the network keeps the history, so the index holds a
 * window of it and can be rebuilt. The first sync of a chat takes its newest `historyDepth`
 * messages; every later sync walks FORWARD from the stored cursor, page by page, so nothing
 * between two syncs is skipped. Older history than the first window is not fetched.
 *
 * Deletions: an incremental run only walks forward, so it cannot see a message deleted on the
 * server — Telegram reports those only as live updates (per channel, through
 * `getChannelDifference`), which a sync without a daemon does not receive. A FULL SCAN
 * (`sync --full-scan`) re-takes each chat's newest window and removes every stored message in
 * the range that window covers but no longer contains, and every chat that left the list —
 * the chat counterpart of the mailbox engine's expunge pass.
 *
 * Budget: every message costs a share of a multi-row INSERT, and executions are a per-process
 * resource on gjsify's libgda-backed sqlite (gjsify gap, unfixed, gjsify#1838 — see
 * `insertMany`). `maxMessages` caps one run; a chat that did not fit keeps its cursor and
 * continues on the next run. Resumable by construction: the cursor is written in the same
 * transaction as the messages it covers.
 *
 * What happens after this: `rebuildConversations` links the chat peers written here to the
 * participant directory (address book first), set-based.
 */

import type {
  ChatBackend,
  ChatHistoryPage,
  ChatInfo,
  ChatMessage,
  ChatPeer,
  ChatSession,
  Classification,
  ClassificationReason,
} from '@postbote/protocol';
import type { IndexDatabase } from './db.ts';
import { insertMany, placeholders, seqColumn, type SqlValue, withTransaction } from './db.ts';
import { upsertAccount } from './index-store.ts';
import { stableId } from './threads.ts';

export interface ChatSyncOptions {
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** Messages taken on the FIRST sync of a chat. Older history stays on the server. */
  historyDepth?: number;
  /** Messages written in one run, across all chats; the rest continues next run. */
  maxMessages?: number;
  /** Messages per round trip when walking forward. */
  pageSize?: number;
  /** Re-fetch the newest window of every chat, picking up edits made since. */
  fullScan?: boolean;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
}

export interface ChatAccountSyncResult {
  backend: string;
  accountId: string;
  /** Chats the account has. */
  chats: number;
  /** Chats that had something new and were fetched. */
  chatsFetched: number;
  /** Messages written. */
  added: number;
  /** Messages and chats found deleted on the server by a full scan, and removed here. */
  removed: number;
  /** Chats whose fetch failed; their cursor stays where it was. */
  chatErrors: number;
  /** An error that stopped the whole account (connect, listing the chats). */
  error: string | null;
}

export interface ChatSyncResult {
  accounts: ChatAccountSyncResult[];
  added: number;
  removed: number;
  errors: number;
  /** True when EVERY account failed — the only case that is an error overall. */
  failed: boolean;
  /** True when `maxMessages` stopped the run before every chat was caught up. */
  budgetExhausted: boolean;
}

export const CHAT_HISTORY_DEPTH = 200;
export const CHAT_MAX_MESSAGES = 5_000;
const DEFAULT_PAGE = 100;

interface Cursor {
  lastSeq: number | null;
  /** The archive's own id at `lastSeq`, for networks that page by id (null for the others). */
  lastCursor: string | null;
  readInboxSeq: number | null;
  readOutboxSeq: number | null;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function loadCursors(db: IndexDatabase, backend: string, accountId: string): Map<string, Cursor> {
  const rows = db
    .prepare(
      `SELECT chat_id, ${seqColumn('last_seq')}, last_cursor, ${seqColumn('read_inbox_seq')}, ${seqColumn('read_outbox_seq')}
         FROM chat_cursors WHERE backend = ? AND account_id = ?`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  return new Map(
    rows.map((r) => [
      String(r.chat_id),
      {
        lastSeq: num(r.last_seq),
        lastCursor: r.last_cursor === null || r.last_cursor === undefined ? null : String(r.last_cursor),
        readInboxSeq: num(r.read_inbox_seq),
        readOutboxSeq: num(r.read_outbox_seq),
      },
    ]),
  );
}

/** The conversation id of a chat. Stable across syncs, so a copied id keeps resolving. */
export function chatConversationId(backend: string, accountId: string, chatRemoteId: string): string {
  return stableId('c-', backend, accountId, chatRemoteId);
}

/**
 * How one chat message is classified when it is written. `known-contact` is not decided here:
 * the address book can change without a new message, so `rebuildConversations` sets it.
 */
export function classifyChatMessage(
  chat: Pick<ChatInfo, 'kind'>,
  message: Pick<ChatMessage, 'fromSelf' | 'sender'>,
): { classification: Classification; reason: ClassificationReason } {
  if (message.fromSelf) return { classification: 'conversational', reason: 'self' };
  if (chat.kind === 'broadcast') return { classification: 'automated', reason: 'broadcast' };
  if (message.sender?.bot) return { classification: 'automated', reason: 'bot' };
  return { classification: 'conversational', reason: 'chat-member' };
}

/** Rows collected for one account, written in one transaction. */
class ChatBatch {
  readonly messages: SqlValue[][] = [];
  readonly peers = new Map<string, SqlValue[]>();
  readonly members = new Map<string, SqlValue[]>();
  readonly cursors: SqlValue[][] = [];
  readonly conversations: SqlValue[][] = [];
  /** Message rows whose message is gone from the server. */
  readonly deletedMessages: string[] = [];
  /** Chat conversations whose chat is gone from the account. */
  readonly deletedConversations: string[] = [];
  /** Corrections of messages stored by an earlier run: conversation, remote id, text, time. */
  readonly edits: SqlValue[][] = [];
  /** Messages stored by an earlier run that the network reports retracted: row ids. */
  readonly retracted: string[] = [];

  readonly backend: string;
  readonly accountId: string;

  constructor(backend: string, accountId: string) {
    this.backend = backend;
    this.accountId = accountId;
  }

  peer(peer: ChatPeer): void {
    this.peers.set(peer.remoteId, [
      this.backend,
      this.accountId,
      peer.remoteId,
      peer.displayName,
      JSON.stringify(peer.addresses),
      peer.bot ? 1 : 0,
    ]);
  }

  member(conversationId: string, peer: ChatPeer): void {
    this.peer(peer);
    this.members.set(`${conversationId}\u0000${peer.remoteId}`, [
      conversationId,
      this.backend,
      this.accountId,
      peer.remoteId,
    ]);
  }
}

function chatSummary(chat: ChatInfo): { classification: Classification; reason: ClassificationReason } {
  return chat.kind === 'broadcast'
    ? { classification: 'automated', reason: 'broadcast' }
    : { classification: 'conversational', reason: 'chat-member' };
}

const DELETE_CHUNK = 100;

function deleteIn(db: IndexDatabase, sql: (placeholders: string) => string, ids: readonly string[]): void {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    db.prepare(sql(placeholders(chunk.length))).run(...chunk);
  }
}

/**
 * The stored messages of one account, by conversation — only loaded for a full scan, which is
 * the one run that can tell a deleted message from one that was never fetched.
 */
function loadStoredSeqs(
  db: IndexDatabase,
  backend: string,
  accountId: string,
): Map<string, Array<{ id: string; seq: number }>> {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, ${seqColumn('remote_seq')} FROM conversation_messages
         WHERE backend = ? AND account_id = ? AND remote_seq IS NOT NULL`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  const result = new Map<string, Array<{ id: string; seq: number }>>();
  for (const r of rows) {
    const list = result.get(String(r.conversation_id)) ?? [];
    list.push({ id: String(r.id), seq: Number(r.remote_seq) });
    result.set(String(r.conversation_id), list);
  }
  return result;
}

/**
 * The stored messages a complete page proves deleted: inside the range the page covered —
 * from its lowest sequence (or the chat's start, when it reached it) up to its highest (or
 * everything, since the window is the newest and nothing newer exists) — but not in it.
 */
export function deletedBy(
  page: Pick<ChatHistoryPage, 'messages' | 'lowestSeq' | 'highestSeq' | 'exhausted' | 'reachedStart'>,
  stored: ReadonlyArray<{ id: string; seq: number }>,
): string[] {
  // An empty page that did not reach the start proves nothing.
  if (page.lowestSeq === null && !page.reachedStart) return [];
  const low = page.reachedStart ? Number.NEGATIVE_INFINITY : (page.lowestSeq ?? Number.NEGATIVE_INFINITY);
  const high = page.exhausted ? Number.POSITIVE_INFINITY : (page.highestSeq ?? Number.NEGATIVE_INFINITY);
  const live = new Set(page.messages.map((m) => m.seq));
  return stored.filter((m) => m.seq >= low && m.seq <= high && !live.has(m.seq)).map((m) => m.id);
}

function writeBatch(db: IndexDatabase, batch: ChatBatch): void {
  withTransaction(db, () => {
    // Deletions first: other people's words the server no longer has must not outlive it here.
    deleteIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, batch.deletedMessages);
    for (const table of [
      'conversation_messages',
      'chat_members',
      'chat_cursors',
      'conversation_participants',
    ]) {
      deleteIn(db, (p) => `DELETE FROM ${table} WHERE conversation_id IN (${p})`, batch.deletedConversations);
    }
    deleteIn(db, (p) => `DELETE FROM conversations WHERE id IN (${p})`, batch.deletedConversations);

    // A replace resets the aggregates to their defaults; the UPDATE below recomputes them in
    // the same transaction.
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversations
         (id, backend, account_id, kind, title, classification, classification_reason)`,
      batch.conversations,
    );
    // INSERT OR REPLACE: a re-fetched message (a full scan) replaces its row with the edited text.
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversation_messages
         (id, conversation_id, backend, account_id, presentation, sender_name, sender_kind,
          sender_address, from_self, sent_at, has_attachments, classification, classification_reason,
          remote_id, body, remote_seq, sender_peer_id, edited_at, reply_to_remote_id, thread_remote_id)`,
      batch.messages,
    );
    insertMany(
      db,
      'INSERT OR REPLACE INTO chat_peers (backend, account_id, peer_id, display_name, addresses_json, is_bot)',
      [...batch.peers.values()],
    );
    // REPLACE, not IGNORE, although the row is identical: libgda logs a warning for every
    // ignored insert, when it looks for the "last inserted row" that was never inserted.
    insertMany(db, 'INSERT OR REPLACE INTO chat_members (conversation_id, backend, account_id, peer_id)', [
      ...batch.members.values(),
    ]);
    insertMany(
      db,
      `INSERT OR REPLACE INTO chat_cursors
         (conversation_id, backend, account_id, chat_id, kind, last_seq, read_inbox_seq, read_outbox_seq, last_sync_at,
          last_cursor)`,
      batch.cursors,
    );
    // After the inserts, so a correction or retraction of a message written in this very batch
    // lands on it. Both are rare (one statement per edit is fine for the execution budget).
    for (const edit of batch.edits) {
      db.prepare(
        'UPDATE conversation_messages SET body = ?, edited_at = ? WHERE conversation_id = ? AND remote_id = ?',
      ).run(...edit);
    }
    deleteIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, batch.retracted);
    // Read state and the conversation aggregates, set-based: two executions per account however
    // many chats changed. `seen` for the user's own messages is always 1; for the others it is
    // the network's read marker, which moves without any new message arriving.
    db.prepare(
      `UPDATE conversation_messages SET
         seen = CASE WHEN from_self = 1 THEN 1
                     WHEN remote_seq <= COALESCE((SELECT c.read_inbox_seq FROM chat_cursors c
                            WHERE c.conversation_id = conversation_messages.conversation_id), 0) THEN 1
                     ELSE 0 END,
         peer_read = CASE WHEN from_self = 1 AND remote_seq <= COALESCE((SELECT c.read_outbox_seq FROM chat_cursors c
                            WHERE c.conversation_id = conversation_messages.conversation_id), 0) THEN 1
                     ELSE 0 END
       WHERE backend = ? AND account_id = ? AND remote_seq IS NOT NULL`,
    ).run(batch.backend, batch.accountId);
    db.prepare(
      `UPDATE conversations SET
         message_count = (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         unread_count = (SELECT COUNT(*) FROM conversation_messages m
                          WHERE m.conversation_id = conversations.id AND m.from_self = 0 AND m.seen = 0),
         first_message_at = (SELECT MIN(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         last_message_at = (SELECT MAX(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         has_attachments = (SELECT COUNT(*) > 0 FROM conversation_messages m
                             WHERE m.conversation_id = conversations.id AND m.has_attachments = 1)
       WHERE backend = ? AND account_id = ?
         AND id IN (SELECT conversation_id FROM chat_cursors WHERE backend = ? AND account_id = ?)`,
    ).run(batch.backend, batch.accountId, batch.backend, batch.accountId);
  });
}

function messageRow(batch: ChatBatch, conversationId: string, chat: ChatInfo, m: ChatMessage): SqlValue[] {
  const verdict = classifyChatMessage(chat, m);
  const sender = m.fromSelf ? null : m.sender;
  const address = sender?.addresses[0] ?? null;
  return [
    stableId('m-', conversationId, m.remoteId),
    conversationId,
    batch.backend,
    batch.accountId,
    // Chat stays chat in presentation (ADR 0001 §1).
    'bubble',
    sender?.displayName ?? null,
    address?.kind ?? null,
    address?.value ?? null,
    m.fromSelf ? 1 : 0,
    m.sentAt,
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
  ];
}

async function syncAccount(
  db: IndexDatabase,
  backend: ChatBackend,
  account: { id: string; identity: string; provider: string },
  options: Required<Omit<ChatSyncOptions, 'accountId'>>,
  budget: { total: number; remaining: number; exhausted: boolean },
): Promise<ChatAccountSyncResult> {
  const name = backend.manifest.name;
  const result: ChatAccountSyncResult = {
    backend: name,
    accountId: account.id,
    chats: 0,
    chatsFetched: 0,
    added: 0,
    removed: 0,
    chatErrors: 0,
    error: null,
  };
  upsertAccount(db, account);

  let session: ChatSession;
  try {
    session = await backend.connect(account.id);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  const batch = new ChatBatch(name, account.id);
  const syncedAt = options.now().toISOString();
  try {
    const chats = await session.listChats();
    result.chats = chats.length;
    const cursors = loadCursors(db, name, account.id);
    const stored = options.fullScan ? loadStoredSeqs(db, name, account.id) : null;
    if (options.fullScan) {
      // A chat that left the list (deleted, or the user left it) goes with its messages.
      const live = new Set(chats.map((c) => c.remoteId));
      for (const chatId of cursors.keys()) {
        if (!live.has(chatId)) batch.deletedConversations.push(chatConversationId(name, account.id, chatId));
      }
    }

    for (const chat of chats) {
      const conversationId = chatConversationId(name, account.id, chat.remoteId);
      const cursor = cursors.get(chat.remoteId);
      // A network that pages by archive id reports its newest id: caught up means we stored it.
      const caughtUp =
        cursor !== undefined &&
        (chat.lastCursor !== undefined
          ? chat.lastCursor === null || cursor.lastCursor === chat.lastCursor
          : chat.lastSeq === null || (cursor.lastSeq ?? -1) >= chat.lastSeq);
      let lastSeq = cursor?.lastSeq ?? null;
      let lastCursor = cursor?.lastCursor ?? null;
      const collect = (page: ChatHistoryPage): void => {
        for (const edit of page.edits ?? []) {
          batch.edits.push([edit.text, edit.editedAt, conversationId, edit.remoteId]);
        }
        for (const remoteId of page.retracted ?? []) {
          batch.retracted.push(stableId('m-', conversationId, remoteId));
        }
      };
      // A full scan re-takes the window only of a chat that is caught up; one with new messages
      // walks forward first, or everything between its cursor and the window would be skipped.
      const windowed = lastSeq === null || (options.fullScan && caughtUp);
      // A window is taken whole or not at all: a window cut short by the budget would never be
      // back-filled (later runs only walk forward). The first fetch of a run always goes ahead,
      // so a `historyDepth` above `maxMessages` still makes progress.
      const windowFits = budget.remaining >= options.historyDepth || budget.remaining === budget.total;
      if (windowed && !caughtUp && !windowFits) {
        budget.exhausted = true;
        // Never seen: leave it out entirely, so the next run starts it fresh.
        if (!cursor) continue;
      }

      const fetched: ChatMessage[] = [];
      let failed = false;
      if ((!caughtUp || options.fullScan) && (!windowed || windowFits)) {
        try {
          if (windowed) {
            const limit = Math.min(options.historyDepth, Math.max(budget.remaining, 0));
            if (limit > 0) {
              const page = await session.fetchHistory(chat.remoteId, null, limit);
              fetched.push(...page.messages);
              collect(page);
              if (page.highestSeq !== null && page.highestSeq >= (lastSeq ?? -1)) {
                lastSeq = page.highestSeq;
                lastCursor = page.highestCursor ?? null;
              }
              if (stored && cursor) {
                const gone = deletedBy(page, stored.get(conversationId) ?? []);
                batch.deletedMessages.push(...gone);
                result.removed += gone.length;
              }
            }
          } else {
            for (;;) {
              const limit = Math.min(options.pageSize, budget.remaining - fetched.length);
              if (limit <= 0) {
                budget.exhausted = true;
                break;
              }
              const page = await session.fetchHistory(chat.remoteId, lastSeq, limit, lastCursor);
              fetched.push(...page.messages.filter((m) => lastSeq === null || m.seq > lastSeq));
              collect(page);
              if (page.highestSeq !== null && page.highestSeq > (lastSeq ?? -1)) {
                lastSeq = page.highestSeq;
                lastCursor = page.highestCursor ?? null;
              } else break;
              if (page.exhausted) break;
            }
          }
        } catch {
          // Keep what arrived and the cursor that covers it; the rest is retried next run. The
          // network's message is not recorded: it may quote the chat.
          result.chatErrors++;
          failed = true;
        }
        budget.remaining -= fetched.length;
        result.chatsFetched++;
      }
      // A first fetch that failed outright leaves no trace, so the next run starts it fresh.
      if (failed && !cursor && fetched.length === 0) continue;

      const summary = chatSummary(chat);
      batch.conversations.push([
        conversationId,
        name,
        account.id,
        chat.kind === 'direct' ? 'direct' : 'group',
        chat.title,
        summary.classification,
        summary.reason,
      ]);
      for (const member of chat.members) batch.member(conversationId, member);
      for (const m of fetched) {
        if (!m.fromSelf && m.sender) batch.member(conversationId, m.sender);
        batch.messages.push(messageRow(batch, conversationId, chat, m));
      }
      result.added += fetched.length;
      batch.cursors.push([
        conversationId,
        name,
        account.id,
        chat.remoteId,
        chat.kind,
        lastSeq,
        chat.readInboxSeq,
        chat.readOutboxSeq,
        syncedAt,
        lastCursor,
      ]);
    }
    result.removed += batch.deletedConversations.length;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Whatever was fetched before a failure is written: its cursors cover exactly it.
    writeBatch(db, batch);
    try {
      await session.close();
    } catch {
      // A failed goodbye does not undo a finished sync.
    }
  }
  return result;
}

/** Sync every account of one chat backend into the index. */
export async function syncChats(
  db: IndexDatabase,
  backend: ChatBackend,
  options: ChatSyncOptions = {},
): Promise<ChatSyncResult> {
  const resolved = {
    historyDepth: options.historyDepth ?? CHAT_HISTORY_DEPTH,
    maxMessages: options.maxMessages ?? CHAT_MAX_MESSAGES,
    pageSize: options.pageSize ?? DEFAULT_PAGE,
    fullScan: options.fullScan ?? false,
    now: options.now ?? (() => new Date()),
  };
  const budget = { total: resolved.maxMessages, remaining: resolved.maxMessages, exhausted: false };
  const accounts = (await backend.listAccounts()).filter(
    (a) => !options.accountId || a.id === options.accountId,
  );
  const results: ChatAccountSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncAccount(db, backend, account, resolved, budget));
  }
  const errors = results.filter((r) => r.error !== null).length;
  return {
    accounts: results,
    added: results.reduce((n, r) => n + r.added, 0),
    removed: results.reduce((n, r) => n + r.removed, 0),
    errors,
    failed: results.length > 0 && errors === results.length,
    budgetExhausted: budget.exhausted,
  };
}
