/**
 * `postbote accounts add telegram` — the interactive login, as a function the CLI calls with its
 * terminal prompts.
 *
 * The session is created under a temporary name and moved to `<account id>.db` only once the
 * login succeeded, so a cancelled or failed login never leaves a half-authorized session that
 * `sync` would then try to use. Logging in to an account that already has a session replaces it.
 *
 * The api_id/api_hash come from the environment or are asked for first, and are stored in the
 * session file — never in the config. A login that is killed outright leaves its pending file;
 * the next `accounts add` or account listing sweeps it once it is stale.
 *
 * Nothing secret is returned or printed: not the phone number, not the code, not the password,
 * not the api_hash, not the session. The result is the account id and the public identity (`@username` or name).
 */

import type { BackendAccount, BackendContext } from '@postbote/protocol';
import { ensurePrivateDir, SecretStore } from '@postbote/store';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { LoginPrompts, TgUser } from './api.ts';
import {
  accountIdFor,
  pendingSessionPath,
  sessionPath,
  sweepPendingSessions,
  writeAccountRecord,
} from './accounts.ts';
import { type ClientFactory, createMtcuteClient } from './client.ts';
import {
  credentialsFromEnv,
  parseCredentials,
  refuseConfigCredentials,
  type TelegramCredentials,
  writeStoredCredentials,
} from './credentials.ts';
import { SecretStoreStorage } from './storage.ts';

/** The public name an account is listed under — never the phone number. */
export function identityOf(user: Pick<TgUser, 'username' | 'displayName' | 'id'>): string {
  if (user.username) return `@${user.username}`;
  return user.displayName || `Telegram user ${user.id}`;
}

/** The environment's pair, else asked for — before anyone types a phone number. */
async function loginCredentials(
  context: BackendContext,
  prompts: LoginPrompts,
): Promise<TelegramCredentials> {
  refuseConfigCredentials(context.settings);
  const fromEnv = credentialsFromEnv(context.env);
  if (fromEnv) return fromEnv;
  const apiId = await prompts.apiId();
  const apiHash = await prompts.apiHash();
  return parseCredentials(apiId, apiHash);
}

export async function loginTelegram(
  context: BackendContext,
  prompts: LoginPrompts,
  createClient: ClientFactory = createMtcuteClient,
): Promise<BackendAccount> {
  const credentials = await loginCredentials(context, prompts);
  ensurePrivateDir(context.secretsDir);
  // What a killed earlier login left behind goes first: it may hold a live auth key.
  sweepPendingSessions(context.secretsDir);
  const pending = pendingSessionPath(context.secretsDir);
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
    // Kept with the session they belong to (Telegram ties a session to its app), in the same
    // 0600 file — so `sync` needs no environment and the config holds no secret.
    writeStoredCredentials(store, credentials);
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
      for (const path of [pending, `${pending}-journal`]) if (existsSync(path)) rmSync(path, { force: true });
    }
  }
}
