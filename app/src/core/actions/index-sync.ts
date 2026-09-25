/**
 * Index actions — building the local index and reporting on it.
 *
 * This module is where the two halves are joined: the registry provides the enabled backends,
 * `@postbote/store` owns the database and the algorithms, and neither imports the other. The
 * injection happens here and nowhere else.
 */

import { searchContacts } from '@postbote/gnome';
import { type ContactDTO, isChatBackend, isDeliveryBackend, isMailBackend } from '@postbote/protocol';
import type {
  ChatSyncResult,
  DeliverySyncResult,
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
  receiveDeliveries,
  searchIndex,
  syncChats,
  syncIndex,
  syncStatus,
} from '@postbote/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
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
  /** One entry per chat backend: its accounts, the messages written, whether the budget ran out. */
  chats: Array<{ backend: string } & ChatSyncResult>;
  /**
   * One entry per delivery-only backend (WhatsApp): what it received this run. Those messages
   * exist nowhere else — the network forgot them on delivery.
   */
  deliveries: Array<{ backend: string } & DeliverySyncResult>;
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
  const config = loadConfig(params.configPath ?? configPath());
  const registry = builtinRegistry();
  const plugins = registry.enabled(config);
  if (plugins.length === 0) {
    throw new Error(
      'no backend is enabled — `postbote backends list` shows them, `backends enable <name>` turns one on',
    );
  }
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    const results: SyncResult[] = [];
    const chats: IndexSyncResult['chats'] = [];
    const deliveries: IndexSyncResult['deliveries'] = [];
    for (const plugin of plugins) {
      const name = plugin.manifest.name;
      const backend = registry.create(config, name, backendContext(name, config));
      // The engine is chosen by the driver the backend implements, never by its name.
      if (isMailBackend(backend)) {
        results.push(
          await syncIndex(db, backend, {
            accountId: params.accountId,
            folderPath: params.folder,
            fullScan: params.fullScan,
          }),
        );
      } else if (isChatBackend(backend)) {
        // `--folder` names a mailbox; a chat backend has none, so a folder-scoped run skips it.
        if (params.folder) continue;
        chats.push({
          backend: name,
          ...(await syncChats(db, backend, { accountId: params.accountId, fullScan: params.fullScan })),
        });
      } else if (isDeliveryBackend(backend)) {
        if (params.folder) continue;
        // `--full-scan` has nothing to re-take here: a delivery-only network keeps no history.
        deliveries.push({
          backend: name,
          ...(await receiveDeliveries(db, backend, { accountId: params.accountId, mode: 'catch-up' })),
        });
      } else {
        throw new Error(
          `backend ${name} uses the ${backend.kind} driver, which this postbote cannot sync yet`,
        );
      }
    }
    const contacts = await addressBook();
    // Sync and rebuild write in multi-row batches: gjsify's sqlite has a per-process budget of
    // executions (gjsify gap, unfixed, gjsify#1838 — see `insertMany`).
    const conversations = rebuildConversations(db, { contacts: contacts ?? [] });
    const folders = results.flatMap((r) => r.folders);
    const chatAccounts = chats.flatMap((c) => c.accounts);
    const deliveryAccounts = deliveries.flatMap((d) => d.accounts);
    const errors =
      results.reduce((n, r) => n + r.errors, 0) +
      chats.reduce((n, c) => n + c.errors, 0) +
      deliveries.reduce((n, d) => n + d.errors, 0);
    const sources = folders.length + chatAccounts.length + deliveryAccounts.length;
    return {
      folders,
      added:
        results.reduce((n, r) => n + r.added, 0) +
        chats.reduce((n, c) => n + c.added, 0) +
        deliveries.reduce((n, d) => n + d.added, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      removed:
        results.reduce((n, r) => n + r.removed, 0) +
        chats.reduce((n, c) => n + c.removed, 0) +
        deliveries.reduce((n, d) => n + d.removed, 0),
      errors,
      // An error overall only when every folder AND every chat account failed.
      failed: sources > 0 && errors === sources,
      backends: plugins.map((p) => p.manifest.name),
      chats,
      deliveries,
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
