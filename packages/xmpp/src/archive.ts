/**
 * The one precondition of this backend: the server keeps a message archive (MAM, XEP-0313).
 */

import type { XmppApi } from './api.ts';
import { domainOf, NS } from './stanza.ts';

/**
 * Throws the explanation when the account's server has no archive. postbote does NOT fall back
 * to receiving offline messages: that would need an available presence, and the server would
 * then hand the queued messages to postbote instead of to the user's real clients.
 */
export async function requireArchive(api: XmppApi): Promise<void> {
  const features = await api.features(api.jid);
  if (features.has(NS.mam)) return;
  throw new Error(
    `the server ${domainOf(api.jid)} offers no message archive (MAM, XEP-0313, ${NS.mam}) for this ` +
      'account — postbote reads XMPP history only from the server archive and never takes offline ' +
      "messages away from your other clients, so there is nothing to sync. Ask the server's admin " +
      'to enable it (Prosody: mod_mam; ejabberd: mod_mam).',
  );
}
