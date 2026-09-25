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

export type SqlValue = string | number | null;

/** `?, ?, …` — n positional placeholders. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Bound values per multi-row INSERT. Measured, not guessed: gjsify's libgda wrapper re-parses
 * the statement per execution at a cost that grows roughly with the square of its parameter
 * count, while each execution has a fixed cost of its own. Rebuilding 3 000 conversations on
 * GJS took 23 s one row per statement, 9.4 s at 20 values, 3.7 s at 60, 4.9 s at 150 and
 * 10.3 s at 400. 120 is a little slower than the optimum and spends half the executions,
 * which are the scarcer resource (see `insertMany`).
 */
export const PARAM_BUDGET = 120;

/**
 * `head VALUES (?, …), (?, …), …` in chunks of `budget` bound values. Every row must have the
 * same width. Call inside a transaction.
 *
 * Bulk writes go through here rather than one `run()` per row because of a gjsify gap
 * (unfixed, gjsify#1838): libgda caches every executed statement per connection, each holding
 * a GWeakRef on the SQLite provider, and that provider is shared by the whole PROCESS (GLib
 * caps it at 65 535). A `run()` costs ~4 refs, so past ~16 000 of them in one process every
 * SELECT — on any connection, a fresh one included — returns []. Executions are the budget
 * this package has to spend, and a multi-row statement spends one.
 */
export function insertMany(
  db: DatabaseSync,
  head: string,
  rows: readonly SqlValue[][],
  budget = PARAM_BUDGET,
): void {
  if (rows.length === 0) return;
  const perChunk = Math.max(1, Math.floor(budget / rows[0].length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const tuple = `(${placeholders(chunk[0].length)})`;
    db.prepare(`${head} VALUES ${chunk.map(() => tuple).join(', ')}`).run(...chunk.flat());
  }
}

/**
 * A sequence column as a SELECT expression that survives any size.
 *
 * gjsify gap (unfixed, gjsify#1839): libgda types a declared INTEGER column as a 32-bit int, and
 * one value above 2^31-1 — any millisecond timestamp, which is what XMPP's archive order is —
 * makes the WHOLE result come back empty. As text it reads fine; `num()` converts it back.
 */
export const seqColumn = (column: string): string => `${column} || '' AS ${column.replace(/^.*\./, '')}`;
