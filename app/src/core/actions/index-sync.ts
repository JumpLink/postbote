/**
 * Index actions — building the local index and reporting on it.
 *
 * This module is where the two halves are joined: the registry provides the enabled backends,
 * `@postbote/store` owns the database and the algorithms, and neither imports the other. The
 * injection happens here and nowhere else.
 */

import { searchContacts } from '@postbote/gnome';
import { type ContactDTO, isMailBackend } from '@postbote/protocol';
import type {
  IndexSearchCriteria,
  IndexedMessage,
  RebuildResult,
  SyncResult,
  SyncStatus,
} from '@postbote/store';
import {
  configPath,
  ensurePrivateDir,
  indexDbPath,
  migrate,
  openIndexDb,
  probeFts5,
  rebuildConversations,
  searchIndex,
  syncIndex,
  syncStatus,
} from '@postbote/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { loadConfig } from '../config.ts';
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
  configPath?: string;
}

export interface IndexSyncResult extends SyncResult {
  /** The enabled backends this run synced, by name. */
  backends: string[];
  conversations: RebuildResult & {
    /** Contacts the classifier knew about; null when the address book was unreachable. */
    contacts: number | null;
  };
}

/** Far above any real address book: this is a full read for the classifier, not a search. */
const CONTACTS_FOR_CLASSIFIER = 1_000_000;

/**
 * The address book, for `known-contact` and participant linking — or null when EDS cannot be
 * reached (Node, a headless session). Conversations are still built then, just without it; the
 * result says so rather than pretending the address book was empty.
 */
async function addressBook(): Promise<ContactDTO[] | null> {
  try {
    return await searchContacts({ limit: CONTACTS_FOR_CLASSIFIER });
  } catch {
    return null;
  }
}

/**
 * Build or update the local index from every ENABLED backend, then rebuild the conversations.
 * The only operation that writes to the index.
 */
export async function indexSync(params: SyncParams = {}): Promise<IndexSyncResult> {
  const plugins = builtinRegistry().enabled(loadConfig(params.configPath ?? configPath()));
  if (plugins.length === 0) {
    throw new Error(
      'no backend is enabled — `postbote backends list` shows them, `backends enable <name>` turns one on',
    );
  }
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    const results: SyncResult[] = [];
    for (const plugin of plugins) {
      const backend = plugin.create();
      // The engine is chosen by the driver the backend implements, never by its name.
      if (!isMailBackend(backend)) {
        throw new Error(
          `backend ${plugin.manifest.name} uses the ${backend.kind} driver, which this postbote cannot sync yet`,
        );
      }
      results.push(
        await syncIndex(db, backend, {
          accountId: params.accountId,
          folderPath: params.folder,
          fullScan: params.fullScan,
        }),
      );
    }
    const contacts = await addressBook();
    // Sync and rebuild write in multi-row batches: gjsify's sqlite has a per-process budget of
    // executions (gjsify gap, unfixed, gjsify#1838 — see `insertMany`).
    const conversations = rebuildConversations(db, { contacts: contacts ?? [] });
    const folders = results.flatMap((r) => r.folders);
    const errors = results.reduce((n, r) => n + r.errors, 0);
    return {
      folders,
      added: results.reduce((n, r) => n + r.added, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      removed: results.reduce((n, r) => n + r.removed, 0),
      errors,
      failed: folders.length > 0 && errors === folders.length,
      backends: plugins.map((p) => p.manifest.name),
      conversations: { ...conversations, contacts: contacts?.length ?? null },
    };
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
