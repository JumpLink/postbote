/**
 * XMPP accounts are secret files: one `<account id>.db` per account in the backend's secrets
 * directory (`SecretStore`: 0600 in 0700, backup tier `secret`), holding the JID, the password
 * and the server address the user gave. An account exists exactly as long as its file does.
 *
 * The password is kept because a reader that syncs without a daemon logs in on every run and
 * XMPP has no session token postbote could keep instead (FAST, XEP-0484, would be one; few
 * servers offer it). It never leaves this file: not into the config (plain `state` in every
 * backup — a password there is refused), a log, an error message, a DTO or MCP output.
 */

import type { BackendAccount, BackendContext } from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import { SecretStore, stableId } from '@postbote/store';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { XmppLogin } from './client.ts';

const ACCOUNT_ID = /^xmpp-[0-9a-z]+$/;
const ACCOUNT_NAMESPACE = 'postbote.account';
const LOGIN_NAMESPACE = 'xmpp.login';

/** The account id for a bare JID: stable, and without the address in a file name. */
export function accountIdFor(jid: string): string {
  return stableId('xmpp-', normalizeJid(jid));
}

/** A bare JID as typed by the user, or an error that says what is wrong with it. */
export function normalizeJid(raw: string): string {
  const jid = normalizeAddress('jid', raw);
  if (!jid) throw new Error('not an XMPP address — expected name@example.org');
  return jid;
}

export function accountPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not an XMPP account id: ${accountId}`);
  return join(secretsDir, `${accountId}.db`);
}

export function writeLogin(secretsDir: string, login: XmppLogin): BackendAccount {
  const jid = normalizeJid(login.jid);
  const id = accountIdFor(jid);
  const store = SecretStore.open(accountPath(secretsDir, id));
  try {
    store.apply([
      { namespace: ACCOUNT_NAMESPACE, key: 'identity', value: jid },
      { namespace: LOGIN_NAMESPACE, key: 'jid', value: jid },
      { namespace: LOGIN_NAMESPACE, key: 'password', value: login.password },
      { namespace: LOGIN_NAMESPACE, key: 'service', value: login.service },
    ]);
  } finally {
    store.close();
  }
  return { id, identity: jid, provider: 'XMPP' };
}

export function readLogin(secretsDir: string, accountId: string): XmppLogin {
  const path = accountPath(secretsDir, accountId);
  if (!existsSync(path))
    throw new Error(`no XMPP account ${accountId} — add it with \`postbote accounts add xmpp\``);
  const store = SecretStore.open(path);
  try {
    const jid = store.get(LOGIN_NAMESPACE, 'jid');
    const password = store.get(LOGIN_NAMESPACE, 'password');
    if (!jid || password === null) {
      throw new Error(
        `the XMPP account ${accountId} is incomplete — add it again with \`postbote accounts add xmpp\``,
      );
    }
    return { jid, password, service: store.get(LOGIN_NAMESPACE, 'service') };
  } finally {
    store.close();
  }
}

export function listAccounts(secretsDir: string): BackendAccount[] {
  if (!existsSync(secretsDir)) return [];
  const accounts: BackendAccount[] = [];
  for (const file of readdirSync(secretsDir).sort()) {
    const id = file.endsWith('.db') ? file.slice(0, -3) : null;
    if (!id || !ACCOUNT_ID.test(id)) continue;
    const store = SecretStore.open(join(secretsDir, file));
    try {
      accounts.push({ id, identity: store.get(ACCOUNT_NAMESPACE, 'identity') ?? id, provider: 'XMPP' });
    } finally {
      store.close();
    }
  }
  return accounts;
}

/** Settings are backed up in the clear: a password there is refused, never silently used. */
export function refuseConfigSecrets(settings: BackendContext['settings']): void {
  if ('password' in settings) {
    throw new Error(
      'an XMPP password does not belong in the config file (it is backed up in the clear) — remove ' +
        'backends.xmpp.settings.password; `postbote accounts add xmpp` keeps it in a 0600 file',
    );
  }
}

/** The one non-secret setting: a PEM file with an extra CA, for a server with its own CA. */
export function caFileSetting(settings: BackendContext['settings']): string | null {
  const value = settings.tlsCaFile;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('backends.xmpp.settings.tlsCaFile must be the path of a PEM file');
  }
  return value;
}
