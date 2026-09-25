/**
 * Signal accounts are session files: one `signal-<ACI>.db` per linked device in the backend's
 * secrets directory, holding the protocol stores (`protocol-store.ts`). There is no other
 * registry — an account exists exactly as long as its session does. `postbote accounts add signal`
 * creates one; unlinking the device on the phone ends it (the next sync reports it).
 *
 * The account id carries the ACI — the account's UUID, not its phone number — so ids in CLI and
 * MCP output carry no number, and a re-linked device continues the same conversations.
 *
 * Same shape as the WhatsApp backend's accounts (a pending file during a link, swept when stale),
 * written again rather than shared: that package is kept self-contained (ADR 0001 §5).
 */

import type { BackendAccount } from '@postbote/protocol';
import { SecretStore } from '@postbote/store';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_NAMESPACE } from './protocol-store.ts';

const ACCOUNT_ID = /^signal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

export function accountIdFor(aci: string): string {
  const id = `signal-${aci.toLowerCase()}`;
  if (!ACCOUNT_ID.test(id)) throw new Error('not an ACI');
  return id;
}

export function sessionPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not a Signal account id: ${accountId}`);
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
 * Remove what a hard-killed link left behind: a pending file may hold the identity key of the
 * account, so it must not linger — but one younger than `PENDING_STALE_MS` may belong to a link
 * running right now in another terminal, and stays.
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
      accounts.push({ id, identity: store.get(ACCOUNT_NAMESPACE, 'identity') ?? id, provider: 'Signal' });
    } finally {
      store.close();
    }
  }
  return accounts;
}
