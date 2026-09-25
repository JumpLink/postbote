/**
 * `postbote accounts add telegram` — the interactive login, as a function the CLI calls with its
 * terminal prompts.
 *
 * The session is created under a temporary name and moved to `<account id>.db` only once the
 * login succeeded, so a cancelled or failed login never leaves a half-authorized session that
 * `sync` would then try to use. Logging in to an account that already has a session replaces it.
 *
 * Nothing secret is returned or printed: not the phone number, not the code, not the password,
 * not the session. The result is the account id and the public identity (`@username` or name).
 */

import type { BackendAccount, BackendContext } from '@postbote/protocol';
import { ensurePrivateDir, SecretStore } from '@postbote/store';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginPrompts, TgUser } from './api.ts';
import { accountIdFor, sessionPath, writeAccountRecord } from './accounts.ts';
import { type ClientFactory, createMtcuteClient } from './client.ts';
import { resolveCredentials } from './credentials.ts';
import { SecretStoreStorage } from './storage.ts';

/** The public name an account is listed under — never the phone number. */
export function identityOf(user: Pick<TgUser, 'username' | 'displayName' | 'id'>): string {
  if (user.username) return `@${user.username}`;
  return user.displayName || `Telegram user ${user.id}`;
}

export async function loginTelegram(
  context: BackendContext,
  prompts: LoginPrompts,
  createClient: ClientFactory = createMtcuteClient,
): Promise<BackendAccount> {
  // Credentials first: a missing api_id should fail before anyone types a phone number.
  const credentials = resolveCredentials(context);
  ensurePrivateDir(context.secretsDir);
  const pending = join(
    context.secretsDir,
    `login-${Date.now()}-${Math.floor(Math.random() * 1e9)}.pending.db`,
  );
  const store = SecretStore.open(pending);
  const client = createClient({ credentials, storage: new SecretStoreStorage(store) });
  let moved = false;
  try {
    const me = await client.login(prompts);
    const account: BackendAccount = {
      id: accountIdFor(me.id),
      identity: identityOf(me),
      provider: 'Telegram',
    };
    writeAccountRecord(store, { identity: account.identity });
    await client.destroy();
    store.close();
    renameSync(pending, sessionPath(context.secretsDir, account.id));
    moved = true;
    return account;
  } finally {
    if (!moved) {
      await client.destroy().catch(() => {});
      try {
        store.close();
      } catch {
        // Already closed after a successful destroy that failed later at the rename.
      }
      if (existsSync(pending)) rmSync(pending, { force: true });
    }
  }
}
