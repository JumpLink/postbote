/**
 * Telegram accounts are session files: one `<account id>.db` per logged-in account in the
 * backend's secrets directory. There is no other registry — an account exists exactly as long as
 * its session does, so `postbote accounts add telegram` creates one and deleting the file (or
 * logging the session out from another Telegram client) ends it.
 */

import type { BackendAccount } from '@postbote/protocol';
import { SecretStore } from '@postbote/store';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_NAMESPACE } from './storage.ts';

const ACCOUNT_ID = /^telegram-\d+$/;

/** The account id for a Telegram user id. */
export function accountIdFor(userId: number): string {
  return `telegram-${userId}`;
}

export function sessionPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not a Telegram account id: ${accountId}`);
  return join(secretsDir, `${accountId}.db`);
}

/** What the session file says about its own account — never the phone number. */
export interface AccountRecord {
  identity: string;
}

export function writeAccountRecord(store: SecretStore, record: AccountRecord): void {
  store.apply([{ namespace: ACCOUNT_NAMESPACE, key: 'identity', value: record.identity }]);
}

/** Every account with a session file, in id order. */
export function listSessionAccounts(secretsDir: string): BackendAccount[] {
  if (!existsSync(secretsDir)) return [];
  const accounts: BackendAccount[] = [];
  for (const file of readdirSync(secretsDir).sort()) {
    const id = file.endsWith('.db') ? file.slice(0, -3) : null;
    if (!id || !ACCOUNT_ID.test(id)) continue;
    const store = SecretStore.open(join(secretsDir, file));
    try {
      accounts.push({ id, identity: store.get(ACCOUNT_NAMESPACE, 'identity') ?? id, provider: 'Telegram' });
    } finally {
      store.close();
    }
  }
  return accounts;
}
