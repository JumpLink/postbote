/**
 * Resolve GOA accounts into connectable IMAP targets, credentials included (GJS-only).
 *
 * Extracted from the old mail.gjs.ts so that everything touching `Goa` lives in this package:
 * the IMAP layer receives plain `MailTarget`s with a `getPassword()` thunk and never imports
 * the GOA typelib itself.
 *
 * Privacy: the password is read from GOA per connection and is never cached here, never
 * logged, and never part of a returned DTO.
 */

import type Goa from 'gi://Goa?version=1.0';

import { GnomeError, type MailTarget } from '@postbote/protocol';
import { getClient } from './goa.gjs.ts';

/** Read the IMAP password from GOA. Tries the standard id, then compat fallbacks. */
function getPassword(obj: Goa.Object): string {
  const pb = obj.get_password_based();
  if (!pb) throw new GnomeError('account has no password-based credentials');
  for (const id of ['imap-password', 'password', '']) {
    try {
      const [ok, password] = pb.call_get_password_sync(id, null);
      if (ok && password) return password;
    } catch {
      // try the next id
    }
  }
  throw new GnomeError('could not retrieve IMAP password from GOA');
}

/** Resolve GOA mail accounts (optionally one) into connectable IMAP targets. */
export async function listMailTargets(accountId?: string): Promise<MailTarget[]> {
  const client = await getClient();
  const targets: MailTarget[] = [];
  for (const obj of client.get_accounts()) {
    const mail = obj.get_mail();
    if (!mail || !mail.imap_supported) continue;
    const account = obj.get_account();
    if (accountId && account?.id !== accountId) continue;
    const rawHost = mail.imap_host ?? '';
    if (!rawHost) continue;
    let host = rawHost;
    let port: number;
    if (rawHost.includes(':')) {
      const [h, p] = rawHost.split(':');
      host = h;
      port = Number.parseInt(p, 10);
    } else {
      port = mail.imap_use_ssl ? 993 : 143;
    }
    targets.push({
      accountId: account?.id ?? '',
      host,
      port,
      user: mail.imap_user_name ?? '',
      implicitTls: mail.imap_use_ssl || (!mail.imap_use_tls && port === 993),
      getPassword: () => getPassword(obj),
    });
  }
  return targets;
}
