/**
 * Opening the SQLite index through the built-in `node:sqlite`.
 *
 * Under GJS that module is supplied by gjsify's `@gjsify/sqlite`, so the same `DatabaseSync`
 * code runs on both runtimes. It is NOT a sqlite3 binding, though — it is a **libgda** wrapper,
 * and that leaks through in four ways which shape every query in this package. Read
 * `AGENTS.md` in this directory before writing SQL here.
 */

import { DatabaseSync } from 'node:sqlite';

export type IndexDatabase = DatabaseSync;

/**
 * Open (and create) the index database.
 *
 * The path must end in `.db` — libgda appends the suffix itself, so `index.sqlite` becomes
 * `index.sqlite.db` on disk. `indexDbPath()` enforces that; this is the second line.
 */
export function openIndexDb(path: string): DatabaseSync {
  if (path !== ':memory:' && !path.endsWith('.db')) {
    throw new Error(`index path must end in .db (libgda appends it): ${path}`);
  }
  const db = new DatabaseSync(path);
  // One statement per exec(): gjsify's wrapper splits multi-statement strings itself and its
  // splitter is not a SQL parser. WAL is a no-op for in-memory databases.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Run `fn` inside a BEGIN/COMMIT, rolling back on throw. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Verify that FTS5 actually works, by round-tripping a known row through a scratch table.
 *
 * This exists because of the single most dangerous property of the wrapper: `all()` and `get()`
 * SWALLOW exceptions and return `[]`. A missing FTS5 module, a rejected tokenizer, or a
 * malformed MATCH therefore does not raise — the index simply answers "no results" to
 * everything, forever, and looks like an empty mailbox rather than a broken build.
 *
 * Called once at open time so that failure is LOUD and immediate.
 */
export function probeFts5(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS fts_probe');
  try {
    db.exec(`CREATE VIRTUAL TABLE fts_probe USING fts5(body, tokenize="unicode61 remove_diacritics 2")`);
  } catch (err) {
    throw new Error(
      `SQLite has no working FTS5 module, so the index cannot be searched: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    db.prepare('INSERT INTO fts_probe(rowid, body) VALUES (?, ?)').run(1, 'Energieberatung März');
    const hit = db.prepare('SELECT rowid FROM fts_probe WHERE fts_probe MATCH ?').all('"Energieberatung"');
    if (hit.length !== 1) throw new Error('a known row did not match its own text');
    // Diacritic folding is what makes "marz" find "März"; without it the tokenizer silently
    // gives a worse index rather than an error.
    const folded = db.prepare('SELECT rowid FROM fts_probe WHERE fts_probe MATCH ?').all('"marz"');
    if (folded.length !== 1) throw new Error('the unicode61 remove_diacritics tokenizer is not active');
  } finally {
    db.exec('DROP TABLE IF EXISTS fts_probe');
  }
}
