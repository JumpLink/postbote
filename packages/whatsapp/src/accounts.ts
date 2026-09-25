/**
 * WhatsApp accounts are session files: one `<account id>.db` per linked device in the backend's
 * secrets directory, holding Baileys' auth state. There is no other registry — an account
 * exists exactly as long as its session does. `postbote accounts add whatsapp` creates one;
 * unlinking the device on the phone ends it (the next sync reports the logout).
 *
 * The account id is the account's LID — WhatsApp's privacy id, stable across re-linking and
 * not the phone number — so the ids that appear in CLI and MCP output carry no number, and a
 * re-linked device continues the same conversations.
 */

import type { BackendAccount } from '@postbote/protocol';
import { SecretStore } from '@postbote/store';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_NAMESPACE } from './auth-state.ts';

const ACCOUNT_ID = /^whatsapp-\d+$/;

export function isAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

export function sessionPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not a WhatsApp account id: ${accountId}`);
  return join(secretsDir, `${accountId}.db`);
}

export function writeAccountRecord(store: SecretStore, record: { identity: string }): void {
  store.apply([{ namespace: ACCOUNT_NAMESPACE, key: 'identity', value: record.identity }]);
}

/** A link in progress: `link-<time>-<random>.pending.db` (plus SQLite's journal). */
const PENDING = /^link-\d+-\d+\.pending\.db(-journal)?$/;

/** A pending file this old is from a link that was killed, not one still running. */
export const PENDING_STALE_MS = 15 * 60 * 1000;

export function pendingSessionPath(secretsDir: string, now = Date.now()): string {
  return join(secretsDir, `link-${now}-${Math.floor(Math.random() * 1e9)}.pending.db`);
}

/**
 * Remove what a hard-killed link left behind. A pending file may hold the keys of a device the
 * phone already linked, so it must not linger — but one younger than `PENDING_STALE_MS` may
 * belong to a link running right now in another terminal, and stays.
 */
export function sweepPendingSessions(secretsDir: string, now = Date.now()): number {
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

/** Every account with a session file, in id order. Sweeps stale pending links on the way. */
export function listSessionAccounts(secretsDir: string): BackendAccount[] {
  if (!existsSync(secretsDir)) return [];
  sweepPendingSessions(secretsDir);
  const accounts: BackendAccount[] = [];
  for (const file of readdirSync(secretsDir).sort()) {
    const id = file.endsWith('.db') ? file.slice(0, -3) : null;
    if (!id || !ACCOUNT_ID.test(id)) continue;
    const store = SecretStore.open(join(secretsDir, file));
    try {
      accounts.push({ id, identity: store.get(ACCOUNT_NAMESPACE, 'identity') ?? id, provider: 'WhatsApp' });
    } finally {
      store.close();
    }
  }
  return accounts;
}
