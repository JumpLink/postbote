/**
 * `postbote accounts add matrix` — the password login, as a function the CLI calls with its
 * terminal prompts.
 *
 * Homeserver (a URL, or a server name whose `.well-known` names it), user and password are
 * exchanged for an access token and a NEW device. The device then runs one sync, which uploads
 * its identity and one-time keys: from that moment on, people in encrypted rooms encrypt for it.
 * History encrypted BEFORE that is not readable by this device (see AGENTS.md: no key backup,
 * no verification yet).
 *
 * Only `m.login.password`. A homeserver that offers only single sign-on (SSO/OIDC — matrix.org
 * since its move to the Matrix Authentication Service is one) is refused with that reason: a
 * browser-redirect login is out of scope for this version.
 *
 * The account file is written under a temporary name and moved to `<account id>.db` only once
 * the first sync succeeded, so a failed login never leaves a half-set-up account. A login that
 * fails after the server issued the token logs that device out again. The password is never
 * stored, returned or printed; the token and the crypto store go only into the 0600 file.
 */

import type { BackendAccount, BackendContext } from '@postbote/protocol';
import { ensurePrivateDir, SecretStore } from '@postbote/store';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { MatrixLoginPrompts } from './api.ts';
import {
  accountIdFor,
  accountPath,
  pendingAccountPath,
  sweepPendingAccounts,
  writeAccessToken,
  writeAccountRecord,
} from './accounts.ts';
import { readOnlyFetch } from './guard.ts';
import { connectMatrixClient, loadMatrixSdk, type MatrixConnector } from './client.ts';

/** `https://matrix.example.org/` → `https://matrix.example.org`; a server name is discovered. */
export async function resolveHomeserver(input: string): Promise<string> {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(value)) throw new Error('the homeserver must be a URL or a server name');
  const { AutoDiscovery, AutoDiscoveryAction } = await loadMatrixSdk();
  const found = await AutoDiscovery.findClientConfig(value);
  const hs = found['m.homeserver'];
  if (hs?.state === AutoDiscoveryAction.SUCCESS && hs.base_url) return hs.base_url.replace(/\/+$/, '');
  // No (valid) .well-known: the server name itself is the usual fallback.
  return `https://${value}`;
}

export async function loginMatrix(
  context: BackendContext,
  prompts: MatrixLoginPrompts,
  connect: MatrixConnector = connectMatrixClient,
): Promise<BackendAccount> {
  const homeserver = await resolveHomeserver(await prompts.homeserver());
  const { createClient } = await loadMatrixSdk();
  const fetchFn = readOnlyFetch(globalThis.fetch.bind(globalThis));
  const probe = createClient({ baseUrl: homeserver, fetchFn });
  const { flows } = await probe.loginFlows();
  if (!flows.some((f) => f.type === 'm.login.password')) {
    throw new Error(
      `${homeserver} offers no password login (only ${flows.map((f) => f.type).join(', ') || 'nothing'}) — single sign-on is not supported yet`,
    );
  }
  // `@anna:example.org` or just `anna`: the server resolves either.
  const user = (await prompts.user()).trim();
  if (!user) throw new Error('the Matrix user is empty');
  const password = await prompts.password();
  const login = await probe.loginRequest({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user },
    password,
    // What the user sees in their list of sessions, in Element and everywhere else.
    initial_device_display_name: 'postbote',
  });

  ensurePrivateDir(context.secretsDir);
  sweepPendingAccounts(context.secretsDir);
  const pending = pendingAccountPath(context.secretsDir);
  const store = SecretStore.open(pending);
  const accountId = accountIdFor(login.user_id);
  let moved = false;
  try {
    writeAccountRecord(store, { userId: login.user_id, homeserver, deviceId: login.device_id });
    writeAccessToken(store, login.access_token);
    prompts.notify('Logged in; setting up this device’s encryption keys…');
    const api = await connect({
      homeserver,
      userId: login.user_id,
      deviceId: login.device_id,
      accessToken: login.access_token,
      store,
      accountId,
    });
    await api.close();
    store.close();
    renameSync(pending, accountPath(context.secretsDir, accountId));
    moved = true;
    return { id: accountId, identity: login.user_id, provider: 'Matrix' };
  } finally {
    if (!moved) {
      try {
        store.close();
      } catch {
        // Already closed before a failed rename.
      }
      for (const path of [pending, `${pending}-journal`]) if (existsSync(path)) rmSync(path, { force: true });
      // The server issued a device; without its file it is an orphan in the user's session list.
      const orphan = createClient({ baseUrl: homeserver, accessToken: login.access_token, fetchFn });
      await orphan.logout(true).catch(() => {});
    }
  }
}
