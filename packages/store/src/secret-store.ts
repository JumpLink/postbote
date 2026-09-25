/**
 * A small namespaced key-value file for a backend's SECRET state — a chat network's session and
 * auth keys, later a crypto store's metadata.
 *
 * Kept apart from the index on purpose. The index is rebuildable from the servers (`derived` in
 * the state manifest); a session is not, and whoever holds the file can read the account
 * (`secret`). One file per account, mode 0600 in a 0700 directory, never inside the repository.
 *
 * Values are TEXT only — bytes are stored as base64 by the caller. That is forced by the
 * libgda-backed `node:sqlite` (see AGENTS.md in this directory): parameters are interpolated as
 * escaped SQL literals, not bound, so a BLOB would not survive the round trip.
 *
 * Writes are batched: `apply` takes every change since the last save and spends a handful of
 * executions on them, because executions are a per-process budget (gjsify gap, unfixed,
 * gjsify#1838 — see `insertMany`), and this file shares that budget with the index.
 */

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { insertMany, placeholders, withTransaction } from './db.ts';
import { ensurePrivateDir } from './download.ts';

/** One change: a value to write, or null to delete the key. */
export interface SecretChange {
  namespace: string;
  key: string;
  value: string | null;
}

/** Keys per `DELETE … IN (…)`, for the same reason `insertMany` batches. */
const DELETE_CHUNK = 100;

export class SecretStore {
  private readonly db: DatabaseSync;
  readonly path: string;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  /**
   * Open (and create) the file. The path must end in `.db`: libgda appends the suffix itself.
   * No WAL: the `-wal` companion would be a second file holding the same secrets, and this file
   * is written a few times per run, not thousands.
   */
  static open(path: string): SecretStore {
    if (path !== ':memory:') {
      if (!path.endsWith('.db'))
        throw new Error(`secret store path must end in .db (libgda appends it): ${path}`);
      ensurePrivateDir(dirname(path));
    }
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE IF NOT EXISTS secrets (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key))',
    );
    if (path !== ':memory:' && existsSync(path)) chmodSync(path, 0o600);
    return new SecretStore(db, path);
  }

  /** Every key of a namespace. One execution. */
  load(namespace: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM secrets WHERE namespace = ?')
      .all(namespace) as Array<{ key?: unknown; value?: unknown }>;
    return new Map(rows.map((r) => [String(r.key), String(r.value)]));
  }

  /** Every namespace at once, for a caller that loads the whole file on open. One execution. */
  loadAll(): Map<string, Map<string, string>> {
    const rows = this.db.prepare('SELECT namespace, key, value FROM secrets').all() as Array<
      Record<string, unknown>
    >;
    const result = new Map<string, Map<string, string>>();
    for (const r of rows) {
      const ns = String(r.namespace);
      let map = result.get(ns);
      if (!map) {
        map = new Map();
        result.set(ns, map);
      }
      map.set(String(r.key), String(r.value));
    }
    return result;
  }

  get(namespace: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM secrets WHERE namespace = ? AND key = ?')
      .get(namespace, key) as { value?: unknown } | undefined;
    return row?.value === undefined || row.value === null ? null : String(row.value);
  }

  /** Apply a batch of changes in one transaction. Later changes to the same key win. */
  apply(changes: readonly SecretChange[]): void {
    if (changes.length === 0) return;
    const last = new Map<string, SecretChange>();
    for (const change of changes) last.set(`${change.namespace}\u0000${change.key}`, change);
    const puts = [...last.values()].filter((c) => c.value !== null);
    const deletes = new Map<string, string[]>();
    for (const c of last.values()) {
      if (c.value !== null) continue;
      const list = deletes.get(c.namespace) ?? [];
      list.push(c.key);
      deletes.set(c.namespace, list);
    }
    withTransaction(this.db, () => {
      for (const [namespace, keys] of deletes) {
        for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
          const chunk = keys.slice(i, i + DELETE_CHUNK);
          this.db
            .prepare(`DELETE FROM secrets WHERE namespace = ? AND key IN (${placeholders(chunk.length)})`)
            .run(namespace, ...chunk);
        }
      }
      insertMany(
        this.db,
        'INSERT OR REPLACE INTO secrets (namespace, key, value)',
        puts.map((c) => [c.namespace, c.key, c.value]),
      );
    });
  }

  /** Remove a whole namespace. */
  clear(namespace: string): void {
    this.db.prepare('DELETE FROM secrets WHERE namespace = ?').run(namespace);
  }

  close(): void {
    this.db.close();
  }
}
