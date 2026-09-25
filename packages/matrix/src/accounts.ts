/**
 * Matrix accounts are secret files: one `<account id>.db` per logged-in device in the backend's
 * secrets directory, holding the access token, the device's crypto store and what the account
 * list shows. There is no other registry — an account exists exactly as long as its file does.
 *
 * The account id is derived from the user id (`matrix-` + a hash), because a user id carries
 * `@` and `:` and a server name of any length — nothing to put in a file name as it is.
 */

import type { BackendAccount } from '@postbote/protocol';
import { SecretStore, stableId } from '@postbote/store';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT_ID = /^matrix-[0-9a-f]{14}$/;

/** postbote's namespace in the account file: who this is and where. Public data only. */
export const ACCOUNT_NAMESPACE = 'postbote.account';
/** The session: the access token. SECRET. */
export const SESSION_NAMESPACE = 'postbote.matrix';

export function accountIdFor(userId: string): string {
  return stableId('matrix-', userId);
}

export function accountPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not a Matrix account id: ${accountId}`);
  return join(secretsDir, `${accountId}.db`);
}

/** What the account file says about itself — none of it secret. */
export interface AccountRecord {
  userId: string;
  homeserver: string;
  deviceId: string;
}

export function writeAccountRecord(store: SecretStore, record: AccountRecord): void {
  store.apply([
    { namespace: ACCOUNT_NAMESPACE, key: 'userId', value: record.userId },
    { namespace: ACCOUNT_NAMESPACE, key: 'homeserver', value: record.homeserver },
    { namespace: ACCOUNT_NAMESPACE, key: 'deviceId', value: record.deviceId },
  ]);
}

export function readAccountRecord(store: SecretStore): AccountRecord | null {
  const record = store.load(ACCOUNT_NAMESPACE);
  const userId = record.get('userId');
  const homeserver = record.get('homeserver');
  const deviceId = record.get('deviceId');
  return userId && homeserver && deviceId ? { userId, homeserver, deviceId } : null;
}

export function writeAccessToken(store: SecretStore, token: string): void {
  store.apply([{ namespace: SESSION_NAMESPACE, key: 'accessToken', value: token }]);
}

export function readAccessToken(store: SecretStore): string | null {
  return store.get(SESSION_NAMESPACE, 'accessToken');
}

/** A login in progress: `login-<time>-<random>.pending.db` (plus SQLite's journal). */
const PENDING = /^login-\d+-\d+\.pending\.db(-journal)?$/;

/** A pending file this old is from a login that was killed, not one still running. */
export const PENDING_STALE_MS = 15 * 60 * 1000;

export function pendingAccountPath(secretsDir: string, now = Date.now()): string {
  return join(secretsDir, `login-${now}-${Math.floor(Math.random() * 1e9)}.pending.db`);
}

/** Remove what a hard-killed login left behind (it may hold a live access token). */
export function sweepPendingAccounts(secretsDir: string, now = Date.now()): number {
  if (!existsSync(secretsDir)) return 0;
  let removed = 0;
  for (const file of readdirSync(secretsDir)) {
    if (!PENDING.test(file)) continue;
    const path = join(secretsDir, file);
    if (now - statSync(path).mtimeMs < PENDING_STALE_MS) continue;
    rmSync(path, { force: true });
    removed++;
  }
  return removed;
}

/** Every account with a file, in id order. Sweeps stale pending logins on the way. */
export function listAccounts(secretsDir: string): BackendAccount[] {
  if (!existsSync(secretsDir)) return [];
  sweepPendingAccounts(secretsDir);
  const accounts: BackendAccount[] = [];
  for (const file of readdirSync(secretsDir).sort()) {
    const id = file.endsWith('.db') ? file.slice(0, -3) : null;
    if (!id || !ACCOUNT_ID.test(id)) continue;
    const store = SecretStore.open(join(secretsDir, file));
    try {
      const record = readAccountRecord(store);
      accounts.push({ id, identity: record?.userId ?? id, provider: 'Matrix' });
    } finally {
      store.close();
    }
  }
  return accounts;
}
