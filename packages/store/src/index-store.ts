/**
 * Reading and writing the local index.
 *
 * Every FTS query is deliberately NARROW — `rowid` and `rank` only, with a LIMIT — and the rows
 * are hydrated by a second, ordinary SELECT. That is not stylistic: libgda's SQL parser cannot
 * classify an FTS `SELECT`, so it tries `execute_non_select` first, throws, and retries as a
 * select. Every FTS query therefore runs TWICE, and keeping it thin is what makes that cheap.
 *
 * Only `postbote sync` writes here. A search never does — one mental model, and no surprise
 * disk growth from a read.
 */

import type { BackendMessage } from '@postbote/protocol';
import type { IndexDatabase } from './db.ts';
import { withTransaction } from './db.ts';
import { toFts5Match } from './fts.ts';

/** A message as the index knows it. */
export interface IndexedMessage {
  accountId: string;
  folderPath: string;
  uid: number;
  messageId: string | null;
  subject: string | null;
  sender: string;
  recipients: string;
  date: string | null;
  internalDate: string | null;
  size: number | null;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
}

export interface IndexSearchCriteria {
  /** Full-text across subject, sender, recipients and body. */
  query?: string;
  accountId?: string;
  folderPath?: string;
  from?: string;
  subject?: string;
  /** Date header on/after, YYYY-MM-DD. */
  since?: string;
  /** Date header before, YYYY-MM-DD. */
  before?: string;
  unseen?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  limit?: number;
}

export interface FolderCursor {
  accountId: string;
  path: string;
  name: string;
  role: string | null;
  uidValidity: number | null;
  uidNext: number | null;
  lastUid: number;
  messageCount: number | null;
  syncEnabled: boolean;
  lastSyncAt: string | null;
}

export function upsertAccount(
  db: IndexDatabase,
  account: { id: string; identity: string; provider: string },
): void {
  db.prepare(
    `INSERT INTO accounts (id, identity, provider) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET identity = excluded.identity, provider = excluded.provider`,
  ).run(account.id, account.identity, account.provider);
}

export function upsertFolder(
  db: IndexDatabase,
  folder: { accountId: string; path: string; name: string; role: string | null },
): void {
  // Deliberately does NOT touch the cursor columns: a folder re-appearing in a LIST must not
  // reset the sync progress that is already recorded for it.
  db.prepare(
    `INSERT INTO folders (account_id, path, name, role) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, role = excluded.role,
       sync_enabled = 1`,
  ).run(folder.accountId, folder.path, folder.name, folder.role);
}

/**
 * Mark folders the server no longer lists as not-to-be-synced, KEEPING their messages.
 *
 * A transient LIST failure or a server hiccup must not be able to empty the index. Actually
 * removing them is `postbote index prune`, an explicit decision.
 */
export function disableMissingFolders(db: IndexDatabase, accountId: string, livePaths: string[]): number {
  const rows = db
    .prepare('SELECT path FROM folders WHERE account_id = ? AND sync_enabled = 1')
    .all(accountId) as Array<{ path: string }>;
  const live = new Set(livePaths);
  let disabled = 0;
  for (const row of rows) {
    if (live.has(row.path)) continue;
    db.prepare('UPDATE folders SET sync_enabled = 0 WHERE account_id = ? AND path = ?').run(
      accountId,
      row.path,
    );
    disabled++;
  }
  return disabled;
}

export function getFolderCursor(db: IndexDatabase, accountId: string, path: string): FolderCursor | null {
  const row = db
    .prepare(
      `SELECT account_id, path, name, role, uid_validity, uid_next, last_uid, message_count,
              sync_enabled, last_sync_at
         FROM folders WHERE account_id = ? AND path = ?`,
    )
    .get(accountId, path) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    path: String(row.path),
    name: String(row.name),
    role: row.role === null ? null : String(row.role),
    uidValidity: row.uid_validity === null ? null : Number(row.uid_validity),
    uidNext: row.uid_next === null ? null : Number(row.uid_next),
    lastUid: Number(row.last_uid ?? 0),
    messageCount: row.message_count === null ? null : Number(row.message_count),
    syncEnabled: Number(row.sync_enabled) === 1,
    lastSyncAt: row.last_sync_at === null ? null : String(row.last_sync_at),
  };
}

export function setFolderCursor(
  db: IndexDatabase,
  accountId: string,
  path: string,
  cursor: {
    uidValidity: number | null;
    uidNext: number | null;
    lastUid: number;
    messageCount: number | null;
  },
  syncedAt: string,
): void {
  db.prepare(
    `UPDATE folders SET uid_validity = ?, uid_next = ?, last_uid = ?, message_count = ?, last_sync_at = ?
       WHERE account_id = ? AND path = ?`,
  ).run(cursor.uidValidity, cursor.uidNext, cursor.lastUid, cursor.messageCount, syncedAt, accountId, path);
}

/**
 * Drop every message of a folder — used when UIDVALIDITY changes, which means every UID the
 * index holds now refers to a different message, or to none.
 */
export function clearFolder(db: IndexDatabase, accountId: string, folderPath: string): number {
  return withTransaction(db, () => {
    const ids = db
      .prepare('SELECT id FROM messages WHERE account_id = ? AND folder_path = ?')
      .all(accountId, folderPath) as Array<{ id: number }>;
    for (const { id } of ids) {
      db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
      db.prepare('DELETE FROM attachments WHERE message_id = ?').run(id);
    }
    db.prepare('DELETE FROM messages WHERE account_id = ? AND folder_path = ?').run(accountId, folderPath);
    return ids.length;
  });
}

/**
 * Insert or replace one message and its searchable text, in ONE transaction.
 *
 * The FTS row is written here rather than by a trigger because the wrapper's `exec()` cannot
 * carry a `BEGIN … END` trigger body — and because a trigger would rewrite the entire FTS row,
 * body included, on every `\Seen` toggle.
 */
export function upsertMessage(
  db: IndexDatabase,
  accountId: string,
  folderPath: string,
  message: BackendMessage,
  indexedAt: string,
): void {
  withTransaction(db, () => {
    const existing = db
      .prepare('SELECT id FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
      .get(accountId, folderPath, message.uid) as { id?: number } | undefined;
    if (existing?.id !== undefined) {
      db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(existing.id);
      db.prepare('DELETE FROM attachments WHERE message_id = ?').run(existing.id);
      db.prepare('DELETE FROM messages WHERE id = ?').run(existing.id);
    }
    db.prepare(
      `INSERT INTO messages
         (account_id, folder_path, uid, message_id, subject, sender, recipients, date, internal_date,
          size, seen, flagged, has_attachment, indexed_at, in_reply_to, thread_refs, from_json, to_json,
          list_id, list_unsubscribe, auto_submitted, precedence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      folderPath,
      message.uid,
      message.messageId,
      message.subject,
      message.sender,
      message.recipients,
      message.date,
      message.internalDate,
      message.size,
      message.seen ? 1 : 0,
      message.flagged ? 1 : 0,
      message.hasAttachment ? 1 : 0,
      indexedAt,
      message.inReplyTo,
      // Space-joined: a Message-ID never contains whitespace, and one TEXT column keeps the
      // row flat instead of adding a table that only the thread builder would ever read.
      message.references.join(' '),
      JSON.stringify(message.from),
      JSON.stringify([...message.to, ...message.cc]),
      message.automation.listId,
      message.automation.listUnsubscribe,
      message.automation.autoSubmitted,
      message.automation.precedence,
    );
    const { id } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    db.prepare(
      'INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)',
    ).run(id, message.subject ?? '', message.sender, message.recipients, message.bodyText ?? '');
    for (const att of message.attachments) {
      db.prepare(
        'INSERT OR REPLACE INTO attachments (message_id, section, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)',
      ).run(id, att.section, att.filename, att.mimeType, att.size);
    }
  });
}

/** Update only the flags of an already-indexed message. Touches no FTS row. */
export function updateFlags(
  db: IndexDatabase,
  accountId: string,
  folderPath: string,
  uid: number,
  flags: { seen: boolean; flagged: boolean },
): void {
  db.prepare(
    'UPDATE messages SET seen = ?, flagged = ? WHERE account_id = ? AND folder_path = ? AND uid = ?',
  ).run(flags.seen ? 1 : 0, flags.flagged ? 1 : 0, accountId, folderPath, uid);
}

/** Remove messages that no longer exist on the server. */
export function deleteMessages(
  db: IndexDatabase,
  accountId: string,
  folderPath: string,
  uids: number[],
): number {
  if (uids.length === 0) return 0;
  return withTransaction(db, () => {
    let removed = 0;
    for (const uid of uids) {
      const row = db
        .prepare('SELECT id FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
        .get(accountId, folderPath, uid) as { id?: number } | undefined;
      if (row?.id === undefined) continue;
      db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(row.id);
      db.prepare('DELETE FROM attachments WHERE message_id = ?').run(row.id);
      db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
      removed++;
    }
    return removed;
  });
}

/** Every UID currently indexed for a folder, with its flags. */
export function indexedFlags(
  db: IndexDatabase,
  accountId: string,
  folderPath: string,
): Map<number, { seen: boolean; flagged: boolean }> {
  const rows = db
    .prepare('SELECT uid, seen, flagged FROM messages WHERE account_id = ? AND folder_path = ?')
    .all(accountId, folderPath) as Array<{ uid: number; seen: number; flagged: number }>;
  const map = new Map<number, { seen: boolean; flagged: boolean }>();
  for (const row of rows) {
    map.set(Number(row.uid), { seen: Number(row.seen) === 1, flagged: Number(row.flagged) === 1 });
  }
  return map;
}

function rowToMessage(row: Record<string, unknown>): IndexedMessage {
  return {
    accountId: String(row.account_id),
    folderPath: String(row.folder_path),
    uid: Number(row.uid),
    messageId: row.message_id === null ? null : String(row.message_id),
    subject: row.subject === null ? null : String(row.subject),
    sender: String(row.sender ?? ''),
    recipients: String(row.recipients ?? ''),
    date: row.date === null ? null : String(row.date),
    internalDate: row.internal_date === null ? null : String(row.internal_date),
    size: row.size === null ? null : Number(row.size),
    seen: Number(row.seen) === 1,
    flagged: Number(row.flagged) === 1,
    hasAttachment: Number(row.has_attachment) === 1,
  };
}

const DEFAULT_SEARCH_LIMIT = 50;
/** Cap on the narrow FTS pass. Generous, because the structured filters run afterwards. */
const FTS_CANDIDATE_LIMIT = 2000;

/**
 * Search the index.
 *
 * Two passes on purpose: a thin FTS query yields candidate rowids, then one ordinary SELECT
 * hydrates and applies the structured filters. Mixing them into a single statement would put
 * the whole result shape through libgda's double-execution path.
 */
export function searchIndex(db: IndexDatabase, criteria: IndexSearchCriteria): IndexedMessage[] {
  const limit = criteria.limit ?? DEFAULT_SEARCH_LIMIT;
  const where: string[] = [];
  const params: Array<string | number> = [];

  const match = toFts5Match(criteria.query);
  if (match) {
    const hits = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(match, FTS_CANDIDATE_LIMIT) as Array<{ rowid: number }>;
    // No hits means no results — NOT "ignore the full-text filter". Returning early also avoids
    // building an `IN ()` clause, which is a syntax error.
    if (hits.length === 0) return [];
    where.push(`id IN (${hits.map(() => '?').join(',')})`);
    params.push(...hits.map((h) => Number(h.rowid)));
  }

  if (criteria.accountId) {
    where.push('account_id = ?');
    params.push(criteria.accountId);
  }
  if (criteria.folderPath) {
    where.push('folder_path = ?');
    params.push(criteria.folderPath);
  }
  if (criteria.from) {
    where.push('sender LIKE ?');
    params.push(`%${criteria.from}%`);
  }
  if (criteria.subject) {
    where.push('subject LIKE ?');
    params.push(`%${criteria.subject}%`);
  }
  if (criteria.since) {
    where.push('date >= ?');
    params.push(criteria.since);
  }
  if (criteria.before) {
    where.push('date < ?');
    params.push(criteria.before);
  }
  if (criteria.unseen) where.push('seen = 0');
  if (criteria.flagged) where.push('flagged = 1');
  if (criteria.hasAttachment) where.push('has_attachment = 1');

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT account_id, folder_path, uid, message_id, subject, sender, recipients, date,
              internal_date, size, seen, flagged, has_attachment
         FROM messages ${clause} ORDER BY date DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

/** The indexed body of one message, for display. */
export function messageBody(
  db: IndexDatabase,
  accountId: string,
  folderPath: string,
  uid: number,
): string | null {
  const row = db
    .prepare('SELECT id FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
    .get(accountId, folderPath, uid) as { id?: number } | undefined;
  if (row?.id === undefined) return null;
  const body = db.prepare('SELECT body FROM messages_fts WHERE rowid = ?').get(row.id) as
    | { body?: string }
    | undefined;
  return body?.body ?? null;
}

export interface SyncStatus {
  accounts: number;
  folders: number;
  foldersSynced: number;
  messages: number;
  oldestSync: string | null;
  newestSync: string | null;
  staleFolders: Array<{ accountId: string; path: string; name: string; lastSyncAt: string | null }>;
}

/** A folder is stale when it has never synced, or not within `maxAgeHours`. */
export function syncStatus(db: IndexDatabase, maxAgeHours: number, now: Date): SyncStatus {
  const cutoff = new Date(now.getTime() - maxAgeHours * 3600_000).toISOString();
  const count = (sql: string): number => {
    const row = db.prepare(sql).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };
  const stale = db
    .prepare(
      `SELECT account_id, path, name, last_sync_at FROM folders
         WHERE sync_enabled = 1 AND (last_sync_at IS NULL OR last_sync_at < ?)
         ORDER BY account_id, path`,
    )
    .all(cutoff) as Array<Record<string, unknown>>;
  const range = db
    .prepare(
      'SELECT MIN(last_sync_at) AS lo, MAX(last_sync_at) AS hi FROM folders WHERE last_sync_at IS NOT NULL',
    )
    .get() as { lo?: string | null; hi?: string | null } | undefined;

  return {
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    folders: count('SELECT COUNT(*) AS n FROM folders WHERE sync_enabled = 1'),
    foldersSynced: count('SELECT COUNT(*) AS n FROM folders WHERE last_sync_at IS NOT NULL'),
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    oldestSync: range?.lo ?? null,
    newestSync: range?.hi ?? null,
    staleFolders: stale.map((r) => ({
      accountId: String(r.account_id),
      path: String(r.path),
      name: String(r.name),
      lastSyncAt: r.last_sync_at === null ? null : String(r.last_sync_at),
    })),
  };
}
