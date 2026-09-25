/**
 * The manifest of the built-in mail backend.
 *
 * Pure data in its own file so both entry points export it: the registry reads a manifest
 * BEFORE it constructs a backend (a terms notice must be shown before any code of the backend
 * runs), and on Node the backend itself is only a stub.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';

export const MAIL_MANIFEST: BackendManifest = {
  name: 'mail',
  displayName: 'Mail (IMAP via GNOME Online Accounts)',
  pluginApi: PLUGIN_API_VERSION,
  capabilities: {
    edits: false,
    reactions: false,
    threads: true,
    readReceipts: false,
    groups: true,
    e2ee: false,
    subject: true,
    folders: true,
    attachments: true,
  },
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['email'],
  // Your own mailbox, through accounts you configured in GNOME Settings — nothing to warn about.
  terms: null,
};
