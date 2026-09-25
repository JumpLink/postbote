/**
 * The manifest of the Telegram backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any Telegram code runs.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';

export const TELEGRAM_MANIFEST: BackendManifest = {
  name: 'telegram',
  displayName: 'Telegram (official API via mtcute)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do, as far as cloud chats go. The frontends read these to show or hide
  // a feature; postbote v1 only reads, so none of this is a promise that postbote can SEND it.
  capabilities: {
    edits: true,
    reactions: true,
    // Forum topics in supergroups, and reply chains everywhere.
    threads: true,
    // Telegram reports how far each side has read (read_inbox / read_outbox markers).
    readReceipts: true,
    groups: true,
    // Cloud chats are encrypted client–server only. Secret chats (end-to-end) are out of scope,
    // so claiming E2EE here would be false.
    e2ee: false,
    subject: false,
    folders: false,
    attachments: true,
  },
  // Telegram keeps the full history of cloud chats: the index is rebuildable (`derived`).
  // The session file with the auth key is not — it is `secret`, and kept apart from the index.
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['telegram', 'phone'],
  terms: {
    summary:
      "postbote talks to Telegram through the official MTProto API as a third-party client (mtcute). Telegram requires every client to use its own API credentials: create an api_id and api_hash for YOURSELF at my.telegram.org; `postbote accounts add telegram` asks for them and keeps them with the session, or they come from the environment — postbote ships none. Use is subject to Telegram's API Terms of Service; an account that misuses the API can be limited or banned by Telegram. postbote only reads: it never sends, edits or deletes, and keeps the session key on this machine only.",
    url: 'https://core.telegram.org/api/terms',
  },
};
