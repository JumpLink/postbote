/**
 * The incremental sync engine.
 *
 * Driven entirely through the `MailBackend` port, so this file — the most intricate in the
 * project — is unit-testable on Node against a fake backend and an in-memory database.
 *
 * Resumable by construction: every cursor is derivable from the data already stored, and each
 * phase commits per message, so an interrupted run continues rather than restarting.
 */

import type { BackendSession, MailBackend, FolderInfo } from '@postbote/protocol';
import { searchableFolders } from '@postbote/protocol';
import type { IndexDatabase } from './db.ts';
import {
  clearFolder,
  deleteMessages,
  disableMissingFolders,
  getFolderCursor,
  indexedFlags,
  setFolderCursor,
  updateFlags,
  upsertAccount,
  upsertFolder,
  upsertMessage,
} from './index-store.ts';

export interface SyncOptions {
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** Restrict to one mailbox path (wire name); omit for all searchable ones. */
  folderPath?: string;
  /** Force the full flag/expunge pass even when it is not yet due. */
  fullScan?: boolean;
  /** How often the full pass runs when not forced. */
  fullScanIntervalHours?: number;
  /** UIDs fetched per round trip. */
  batchSize?: number;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
}

export interface FolderSyncResult {
  accountId: string;
  folderPath: string;
  folderName: string;
  added: number;
  updated: number;
  removed: number;
  /** True when UIDVALIDITY changed and the folder was rebuilt from scratch. */
  rebuilt: boolean;
  /** True when nothing had changed and the folder was skipped cheaply. */
  skipped: boolean;
  error: string | null;
}

export interface SyncResult {
  folders: FolderSyncResult[];
  added: number;
  updated: number;
  removed: number;
  errors: number;
  /** True when EVERY folder failed — the only case that is an error overall. */
  failed: boolean;
}

const DEFAULT_BATCH = 200;
const DEFAULT_FULL_SCAN_HOURS = 6;

function hoursSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 3600_000;
}

/** Sync one folder. Errors are returned, not thrown — one bad mailbox must not stop the rest. */
async function syncFolder(
  db: IndexDatabase,
  session: BackendSession,
  accountId: string,
  folder: FolderInfo,
  options: Required<Pick<SyncOptions, 'batchSize' | 'fullScanIntervalHours'>> & {
    fullScan: boolean;
    now: Date;
  },
): Promise<FolderSyncResult> {
  const result: FolderSyncResult = {
    accountId,
    folderPath: folder.path,
    folderName: folder.name,
    added: 0,
    updated: 0,
    removed: 0,
    rebuilt: false,
    skipped: false,
    error: null,
  };

  try {
    const status = await session.openFolder(folder.path);
    const cursor = getFolderCursor(db, accountId, folder.path);

    // A changed UIDVALIDITY means every stored UID now names a different message, or none.
    // Nothing can be reused, so the folder starts over.
    if (
      cursor?.uidValidity != null &&
      status.uidValidity != null &&
      cursor.uidValidity !== status.uidValidity
    ) {
      clearFolder(db, accountId, folder.path);
      result.rebuilt = true;
    }

    const lastUid = result.rebuilt ? 0 : (cursor?.lastUid ?? 0);
    const unchanged =
      !result.rebuilt &&
      cursor != null &&
      cursor.uidNext != null &&
      status.uidNext != null &&
      cursor.uidNext === status.uidNext &&
      cursor.messageCount === status.exists;

    // Same uidNext AND same message count ⇒ nothing appended and nothing expunged. The cheap
    // no-op that makes syncing a hundred quiet folders fast.
    const dueFullScan =
      options.fullScan ||
      hoursSince(cursor?.lastSyncAt ?? null, options.now) >= options.fullScanIntervalHours;
    // A drop in `exists` is proof of an expunge, so the full pass is forced regardless of age.
    const shrank = cursor?.messageCount != null && status.exists < cursor.messageCount;

    if (unchanged && !dueFullScan && !shrank) {
      result.skipped = true;
      setFolderCursor(
        db,
        accountId,
        folder.path,
        {
          uidValidity: status.uidValidity,
          uidNext: status.uidNext,
          lastUid,
          messageCount: status.exists,
        },
        options.now.toISOString(),
      );
      return result;
    }

    // ── new messages ────────────────────────────────────────────────
    let highest = lastUid;
    for (;;) {
      const batch = await session.fetchNewer(folder.path, highest, options.batchSize);
      if (batch.length === 0) break;
      for (const message of batch) {
        // `<n>:*` always returns at least the highest existing UID even when n is past the end,
        // so anything at or below the cursor is a duplicate of what is already indexed.
        if (message.uid <= highest) continue;
        upsertMessage(db, accountId, folder.path, message, options.now.toISOString());
        result.added++;
        if (message.uid > highest) highest = message.uid;
      }
      // A batch that advanced nothing would loop forever.
      if (batch.every((m) => m.uid <= lastUid)) break;
      if (batch.length < options.batchSize) break;
    }

    // ── flags and expunges, in one pass ─────────────────────────────
    // The returned UID set IS the live set, so drift and deletions fall out together and a
    // separate `UID SEARCH ALL` is unnecessary.
    if (dueFullScan || shrank || result.rebuilt) {
      const live = await session.listFlags(folder.path);
      const liveUids = new Set(live.map((f) => f.uid));
      const known = indexedFlags(db, accountId, folder.path);

      for (const state of live) {
        const current = known.get(state.uid);
        if (!current) continue; // not indexed yet — the next append pass will pick it up
        if (current.seen === state.seen && current.flagged === state.flagged) continue;
        updateFlags(db, accountId, folder.path, state.uid, state);
        result.updated++;
      }

      const gone = [...known.keys()].filter((uid) => !liveUids.has(uid));
      result.removed = deleteMessages(db, accountId, folder.path, gone);
    }

    setFolderCursor(
      db,
      accountId,
      folder.path,
      {
        uidValidity: status.uidValidity,
        uidNext: status.uidNext,
        lastUid: highest,
        messageCount: status.exists,
      },
      options.now.toISOString(),
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Sync accounts into the index.
 *
 * Errors are per folder and per account. Only a run in which EVERY folder failed is a failure
 * overall — one unreachable mailbox must not make the whole sync look broken, and must not stop
 * the others from being indexed.
 */
export async function syncIndex(
  db: IndexDatabase,
  backend: MailBackend,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const fullScanIntervalHours = options.fullScanIntervalHours ?? DEFAULT_FULL_SCAN_HOURS;
  const folders: FolderSyncResult[] = [];

  const accounts = (await backend.listAccounts()).filter(
    (a) => !options.accountId || a.id === options.accountId,
  );

  for (const account of accounts) {
    upsertAccount(db, account);
    let session: BackendSession;
    try {
      session = await backend.connect(account.id);
    } catch (err) {
      folders.push({
        accountId: account.id,
        folderPath: '',
        folderName: '',
        added: 0,
        updated: 0,
        removed: 0,
        rebuilt: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    try {
      const listed = await session.listFolders();
      for (const folder of listed) {
        upsertFolder(db, { accountId: account.id, path: folder.path, name: folder.name, role: folder.role });
      }
      disableMissingFolders(
        db,
        account.id,
        listed.map((f) => f.path),
      );

      const wanted = options.folderPath
        ? listed.filter((f) => f.path === options.folderPath || f.name === options.folderPath)
        : searchableFolders(listed);

      for (const folder of wanted) {
        folders.push(
          await syncFolder(db, session, account.id, folder, {
            batchSize,
            fullScanIntervalHours,
            fullScan: options.fullScan ?? false,
            now: now(),
          }),
        );
      }
    } catch (err) {
      folders.push({
        accountId: account.id,
        folderPath: '',
        folderName: '',
        added: 0,
        updated: 0,
        removed: 0,
        rebuilt: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await session.close();
    }
  }

  const errors = folders.filter((f) => f.error !== null).length;
  return {
    folders,
    added: folders.reduce((n, f) => n + f.added, 0),
    updated: folders.reduce((n, f) => n + f.updated, 0),
    removed: folders.reduce((n, f) => n + f.removed, 0),
    errors,
    failed: folders.length > 0 && errors === folders.length,
  };
}
