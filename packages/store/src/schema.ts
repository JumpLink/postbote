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

export const SCHEMA_VERSION = 1;

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
];

/**
 * Per-version upgrade steps, applied in order for a database below SCHEMA_VERSION.
 * Empty at v1; the array exists so the first migration has an obvious home.
 */
const UPGRADES: Record<number, readonly string[]> = {};

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

/** Create or upgrade the schema. Safe to call on every open. */
export function migrate(db: IndexDatabase): void {
  const from = readVersion(db);
  withTransaction(db, () => {
    for (const statement of STATEMENTS) db.exec(statement);
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      for (const statement of UPGRADES[v] ?? []) db.exec(statement);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  });
}
