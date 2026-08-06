/**
 * Index actions — building the local index and reporting on it.
 *
 * This module is where the two halves are joined: `@postbote/imap` provides the backend,
 * `@postbote/store` owns the database and the algorithm, and neither imports the other. The
 * injection happens here and nowhere else.
 */

import { ImapBackend } from '@postbote/imap';
import type { IndexSearchCriteria, IndexedMessage, SyncResult, SyncStatus } from '@postbote/store';
import {
  ensurePrivateDir,
  indexDbPath,
  migrate,
  openIndexDb,
  probeFts5,
  searchIndex,
  syncIndex,
  syncStatus,
} from '@postbote/store';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * How long a folder's data stays usable for an `--auto` search before it is called stale.
 * A day: long enough that routine searches do not trigger a sync, short enough that a stale
 * answer is flagged rather than silently served.
 */
export const MAX_STALENESS_HOURS = 24;

/**
 * Open the index, creating and migrating it if needed.
 *
 * The file is chmod'ed 0600 on every open, not just at creation: it holds mail headers AND
 * plain-text bodies, and a mode that drifted once would otherwise stay wrong forever.
 */
export function openIndex(path = indexDbPath()) {
  if (path !== ':memory:') {
    // Create the directory 0700 BEFORE opening. Two reasons, and the second is the important
    // one: without it a fresh install has nowhere to put the database, and SQLite's `-wal` /
    // `-shm` companions are created 0644 by SQLite itself — they hold recent writes, i.e.
    // message bodies. The file mode below cannot cover them; the directory mode can.
    ensurePrivateDir(dirname(path));
  }
  const db = openIndexDb(path);
  migrate(db);
  // Loud, immediate failure beats an index that silently answers "no results" to everything —
  // which is what a missing FTS5 module would produce, because the wrapper swallows errors.
  probeFts5(db);
  if (path !== ':memory:') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // A path the process cannot chmod (an odd mount, a foreign owner) is not a reason to
      // refuse to work; the data-directory mode is the real protection.
    }
  }
  return db;
}

export interface SyncParams {
  accountId?: string;
  folder?: string;
  fullScan?: boolean;
  dbPath?: string;
}

/** Build or update the local index. The only operation that writes to it. */
export async function indexSync(params: SyncParams = {}): Promise<SyncResult> {
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    return await syncIndex(db, new ImapBackend(), {
      accountId: params.accountId,
      folderPath: params.folder,
      fullScan: params.fullScan,
    });
  } finally {
    db.close();
  }
}

/** Report what the index holds and how fresh it is. */
export function indexStatus(dbPath?: string): SyncStatus & { path: string; maxStalenessHours: number } {
  const path = dbPath ?? indexDbPath();
  const db = openIndex(path);
  try {
    return {
      path,
      maxStalenessHours: MAX_STALENESS_HOURS,
      ...syncStatus(db, MAX_STALENESS_HOURS, new Date()),
    };
  } finally {
    db.close();
  }
}

/** Search the local index. Never writes — only `sync` does. */
export function indexSearch(
  criteria: IndexSearchCriteria,
  dbPath?: string,
): { messages: IndexedMessage[]; staleFolders: number; indexedAt: string | null } {
  const db = openIndex(dbPath ?? indexDbPath());
  try {
    const status = syncStatus(db, MAX_STALENESS_HOURS, new Date());
    return {
      messages: searchIndex(db, criteria),
      staleFolders: status.staleFolders.length,
      indexedAt: status.newestSync,
    };
  } finally {
    db.close();
  }
}
