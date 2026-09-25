/**
 * The manifest of the WhatsApp backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any WhatsApp code runs — and here that notice matters more than
 * anywhere else in postbote.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';

export const WHATSAPP_MANIFEST: BackendManifest = {
  name: 'whatsapp',
  displayName: 'WhatsApp (unofficial, via Baileys)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do. The frontends read these to show or hide a feature; postbote only
  // reads, so none of this is a promise that postbote can SEND it.
  capabilities: {
    edits: true,
    reactions: true,
    // Replies, but no threads or topics.
    threads: false,
    // Delivered/read/played receipts, per message.
    readReceipts: true,
    groups: true,
    // Every chat is end-to-end encrypted (Signal protocol); this device holds its own keys.
    e2ee: true,
    subject: false,
    folders: false,
    attachments: true,
  },
  // No server archive: a message is gone from WhatsApp's servers once a device acknowledged it.
  // What postbote stores is the only copy (`state`); the auth state is `secret`.
  syncModel: 'delivery-only',
  // Baileys is JavaScript plus a WASM module — no native addon, no per-platform prebuilds.
  native: false,
  addressKinds: ['whatsapp', 'phone'],
  terms: {
    summary:
      "postbote connects to WhatsApp as a linked device through Baileys, an UNOFFICIAL reimplementation of the WhatsApp Web protocol. It is not an official WhatsApp client, and using it violates WhatsApp's Terms of Service: WhatsApp can ban the account — your phone number — temporarily or for good, and does so with accounts it sees using unofficial clients. Enable this only if you accept that risk for this number. postbote only reads: it never sends messages, read receipts or an online presence (it does acknowledge delivery, as every linked device must). WhatsApp keeps no server archive, so what postbote receives exists only in its local index, and WhatsApp unlinks a device that has not connected for about 14 days.",
    url: 'https://www.whatsapp.com/legal/terms-of-service',
  },
};
