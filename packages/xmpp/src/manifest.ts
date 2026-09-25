/**
 * The manifest of the XMPP backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';

export const XMPP_MANIFEST: BackendManifest = {
  name: 'xmpp',
  displayName: 'XMPP / Jabber (server archive via MAM)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do. The frontends read these to show or hide a feature; postbote only
  // reads, so none of this is a promise that postbote can SEND it.
  capabilities: {
    // Last message correction (XEP-0308): applied to the stored message.
    edits: true,
    // Message reactions (XEP-0444) exist on the network; postbote does not store them yet.
    reactions: true,
    // XMPP has `<thread/>`, but no client shows threads; claiming them would promise a view
    // nobody fills.
    threads: false,
    // Chat markers (XEP-0333) are readable where the server archives them.
    readReceipts: true,
    // Multi-user chats (XEP-0045), their history through the room's own archive.
    groups: true,
    // OMEMO (XEP-0384) is not implemented: an encrypted message is indexed without its text.
    e2ee: false,
    subject: false,
    folders: false,
    // Out-of-band links (XEP-0066), which HTTP File Upload (XEP-0363) produces.
    attachments: true,
  },
  // With MAM (XEP-0313) the server keeps the history: the index is rebuildable (`derived`).
  // A server WITHOUT MAM leaves nothing to read — postbote says so at connect and does not
  // fall back to offline messages, which would take them away from the user's other clients.
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['jid'],
  // An open federated protocol spoken with the user's own account: nothing beyond the terms of
  // the server they chose.
  terms: null,
};
