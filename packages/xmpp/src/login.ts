/**
 * `postbote accounts add xmpp` — the interactive login, as a function the CLI calls with its
 * terminal prompts.
 *
 * Asks for the JID, the password and (optionally) the server address, logs in once to prove all
 * three work and that the server keeps an archive, and only then writes the account file. A
 * failed login leaves nothing behind. Adding an account that exists replaces its password.
 *
 * Nothing secret is returned or printed: the result is the account id and the JID.
 */

import type { BackendAccount, BackendContext } from '@postbote/protocol';
import { caFileSetting, normalizeJid, refuseConfigSecrets, writeLogin } from './accounts.ts';
import type { LoginPrompts } from './api.ts';
import { requireArchive } from './archive.ts';
import { type ClientFactory, createXmppClient, type XmppLogin } from './client.ts';

export async function loginXmpp(
  context: BackendContext,
  prompts: LoginPrompts,
  createClient: ClientFactory = createXmppClient,
): Promise<BackendAccount> {
  refuseConfigSecrets(context.settings);
  const caFile = caFileSetting(context.settings);
  const jid = normalizeJid(await prompts.jid());
  const password = await prompts.password();
  if (!password) throw new Error('an empty password cannot log in');
  const service = (await prompts.service()).trim() || null;
  const login: XmppLogin = { jid, password, service };

  const api = await createClient({ login, caFile });
  try {
    await requireArchive(api);
  } finally {
    await api.close();
  }
  prompts.notify(`Logged in as ${jid}; the server keeps a message archive (MAM).`);
  return writeLogin(context.secretsDir, login);
}
