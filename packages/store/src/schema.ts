/**
 * Index schema and migration — versioned via SCHEMA_VERSION + the UPGRADES array.
 *
 * Two decisions here are forced by the libgda-backed `node:sqlite` (see AGENTS.md in this
 * directory), and both look odd without that context:
 *
 *   - **No FTS triggers.** `exec()` splits multi-statement strings itself and does not
 *     understand `BEGIN … END`, so a trigger body would be cut into broken fragments. The FTS
 *     table is maintained by application code inside the same transaction as the `messages`
 *     write — which is better anyway: an `AFTER UPDATE` trigger would fire on every flag change
 *     and rewrite the whole FTS row for a `\Seen` toggle.
 *   - **A plain FTS5 table, not `content=''` external content.** External content needs the
 *     `('delete', rowid, …)` command form to remove a row, and a `'rebuild'` after any drift.
 *     A plain table deletes with `DELETE … WHERE rowid = ?`. The searchable text is therefore
 *     stored ONCE — in the FTS table — and `messages` deliberately has no `body` column, so
 *     nothing is duplicated.
 *
 * One statement per array entry, and NO SQL comments inside these strings: the splitter is not
 * a SQL parser. Documentation belongs in JS comments like this one.
 */

import { type IndexDatabase, withTransaction } from './db.ts';

export const SCHEMA_VERSION = 2;

/**
 * The FTS5 DDL. Defined once so the baseline and any future rebuild cannot drift.
 *
 * `remove_diacritics 2` is what makes "marz" find "März" and "Grusse" find "Grüße" — decisive
 * for a German mailbox searched from a keyboard that may not have umlauts to hand.
 */
const FTS_TABLE =
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(` +
  `subject, sender, recipients, body, ` +
  `tokenize="unicode61 remove_diacritics 2")`;

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     identity TEXT,
     provider TEXT,
     last_sync_at TEXT)`,

  // `path` is the WIRE name (modified UTF-7) and is the key, because it is what a server
  // accepts and what stays stable; `name` is the decoded form, for display only.
  // `last_uid` is the sync cursor: everything at or below it has been seen.
  `CREATE TABLE IF NOT EXISTS folders (
     account_id TEXT NOT NULL,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     role TEXT,
     uid_validity INTEGER,
     uid_next INTEGER,
     last_uid INTEGER NOT NULL DEFAULT 0,
     message_count INTEGER,
     sync_enabled INTEGER NOT NULL DEFAULT 1,
     last_sync_at TEXT,
     PRIMARY KEY (account_id, path))`,

  // No `body` column on purpose — the body lives once, in messages_fts.
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id TEXT NOT NULL,
     folder_path TEXT NOT NULL,
     uid INTEGER NOT NULL,
     message_id TEXT,
     subject TEXT,
     sender TEXT,
     recipients TEXT,
     date TEXT,
     internal_date TEXT,
     size INTEGER,
     seen INTEGER NOT NULL DEFAULT 0,
     flagged INTEGER NOT NULL DEFAULT 0,
     has_attachment INTEGER NOT NULL DEFAULT 0,
     indexed_at TEXT NOT NULL)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS messages_uid ON messages (account_id, folder_path, uid)`,
  `CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC)`,
  `CREATE INDEX IF NOT EXISTS messages_folder ON messages (account_id, folder_path)`,

  `CREATE TABLE IF NOT EXISTS attachments (
     message_id INTEGER NOT NULL,
     section TEXT NOT NULL,
     filename TEXT,
     mime_type TEXT,
     size INTEGER,
     PRIMARY KEY (message_id, section))`,

  FTS_TABLE,

  `CREATE TABLE IF NOT EXISTS sync_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     account_id TEXT,
     folder_path TEXT,
     added INTEGER NOT NULL DEFAULT 0,
     updated INTEGER NOT NULL DEFAULT 0,
     removed INTEGER NOT NULL DEFAULT 0,
     error TEXT)`,

  // ── conversations (v2) ─────────────────────────────────────────────
  // Derived tables: `rebuildMailConversations` rewrites them from `messages` after each sync,
  // so they never hold anything the mail rows do not. A delivery-only backend will write its
  // own rows here directly, and at that point they become the only copy (ADR 0001 §2).

  `CREATE TABLE IF NOT EXISTS participants (
     id TEXT PRIMARY KEY,
     display_name TEXT,
     contact_uid TEXT)`,

  // (kind, value) is the key: one address belongs to exactly one participant.
  `CREATE TABLE IF NOT EXISTS participant_addresses (
     participant_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (kind, value))`,

  `CREATE INDEX IF NOT EXISTS participant_addresses_owner ON participant_addresses (participant_id)`,

  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT,
     classification TEXT NOT NULL,
     classification_reason TEXT NOT NULL,
     first_message_at TEXT,
     last_message_at TEXT,
     message_count INTEGER NOT NULL DEFAULT 0,
     unread_count INTEGER NOT NULL DEFAULT 0,
     has_attachments INTEGER NOT NULL DEFAULT 0)`,

  `CREATE INDEX IF NOT EXISTS conversations_last ON conversations (last_message_at DESC)`,

  `CREATE TABLE IF NOT EXISTS conversation_participants (
     conversation_id TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     PRIMARY KEY (conversation_id, participant_id))`,

  // `folder_path` + `uid` locate a mail message for `mail_get_message`; every other backend
  // leaves them null and stores the network's own message id in `remote_id`.
  `CREATE TABLE IF NOT EXISTS conversation_messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     presentation TEXT NOT NULL,
     sender_participant_id TEXT,
     sender_name TEXT,
     sender_kind TEXT,
     sender_address TEXT,
     from_self INTEGER NOT NULL DEFAULT 0,
     sent_at TEXT,
     subject TEXT,
     seen INTEGER NOT NULL DEFAULT 0,
     has_attachments INTEGER NOT NULL DEFAULT 0,
     classification TEXT NOT NULL,
     classification_reason TEXT NOT NULL,
     folder_path TEXT,
     uid INTEGER,
     remote_id TEXT)`,

  `CREATE INDEX IF NOT EXISTS conversation_messages_conv ON conversation_messages (conversation_id, sent_at)`,
];

/**
 * One upgrade step: a plain statement, or a column to add.
 *
 * Columns are declared, not written as `ALTER TABLE … ADD COLUMN`, so the step can check first:
 * a binary from before this check (v1 is released) rewrites `schema_version` back to its own
 * number when it opens a newer index, and the next newer binary then replays the upgrade
 * against columns that already exist. SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
type UpgradeStep = string | { table: string; column: string; type: string };

/**
 * Per-version upgrade steps, applied in order for a database below SCHEMA_VERSION.
 *
 * A fresh database runs them too (it starts at version 0), so a column is added HERE and never
 * in the `CREATE TABLE` above — declared in both places, the ALTER would fail on a new index.
 * Every step must be safe to run twice, for the reason given at `UpgradeStep`.
 */
const UPGRADES: Record<number, readonly UpgradeStep[]> = {
  // v2: what threading and classification read. Stored as fetched; the conversation tables
  // are derived from them.
  2: [
    { table: 'messages', column: 'in_reply_to', type: 'TEXT' },
    { table: 'messages', column: 'thread_refs', type: 'TEXT' },
    { table: 'messages', column: 'from_json', type: 'TEXT' },
    { table: 'messages', column: 'to_json', type: 'TEXT' },
    { table: 'messages', column: 'list_id', type: 'TEXT' },
    { table: 'messages', column: 'list_unsubscribe', type: 'TEXT' },
    { table: 'messages', column: 'auto_submitted', type: 'TEXT' },
    { table: 'messages', column: 'precedence', type: 'TEXT' },
    // Rows indexed under v1 lack all of the above. The index is derived (server archive), so
    // the honest fix is to fetch them again: resetting the cursors makes the next sync re-index
    // every folder, and `upsertMessage` replaces each row in place.
    'UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL',
  ],
};

function columnsOf(db: IndexDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => String(r.name)));
}

function applyStep(db: IndexDatabase, step: UpgradeStep): void {
  if (typeof step === 'string') {
    db.exec(step);
    return;
  }
  if (columnsOf(db, step.table).has(step.column)) return;
  db.exec(`ALTER TABLE ${step.table} ADD COLUMN ${step.column} ${step.type}`);
}

/** Thrown when the index was written by a newer postbote than the one opening it. */
export class IndexTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `the index is schema version ${found}, but this postbote only knows up to ${supported} — ` +
        'update postbote (or point POSTBOTE_DB_PATH at another index); the index was left untouched',
    );
    this.name = 'IndexTooNewError';
    this.found = found;
    this.supported = supported;
  }
}

function readVersion(db: IndexDatabase): number {
  try {
    const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
      | { value?: string }
      | undefined;
    return row?.value ? Number.parseInt(row.value, 10) : 0;
  } catch {
    // A database with no schema_meta at all is version 0. This is the ONE place a swallowed
    // error is the right answer, because "the table does not exist" IS the information wanted.
    return 0;
  }
}

/**
 * Create or upgrade the schema. Safe to call on every open.
 *
 * Refuses an index from a NEWER postbote and leaves it untouched: writing our own, lower
 * version into it would make the newer binary replay its upgrades on the next open.
 */
export function migrate(db: IndexDatabase): void {
  const from = readVersion(db);
  if (from > SCHEMA_VERSION) throw new IndexTooNewError(from, SCHEMA_VERSION);
  withTransaction(db, () => {
    for (const statement of STATEMENTS) db.exec(statement);
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      for (const step of UPGRADES[v] ?? []) applyStep(db, step);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  });
}
