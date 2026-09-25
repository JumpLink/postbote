/**
 * The manifest of the Signal backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any Signal code — and the native addon — is loaded.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';

export const SIGNAL_MANIFEST: BackendManifest = {
  name: 'signal',
  displayName: 'Signal (linked device, via libsignal)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do; postbote only reads.
  capabilities: {
    edits: true,
    reactions: true,
    // Quoted replies, no threads.
    threads: false,
    readReceipts: true,
    groups: true,
    // Every chat is end-to-end encrypted; this device holds its own identity and session keys.
    e2ee: true,
    subject: false,
    folders: false,
    attachments: true,
  },
  // Signal keeps no server archive: the queue is emptied once a device acknowledged a message,
  // so what postbote stores is the only copy (`state`); the protocol stores are `secret`.
  syncModel: 'delivery-only',
  // @signalapp/libsignal-client is Rust behind N-API with per-platform prebuilds. On GJS it
  // loads through @gjsify/napi; where no prebuild exists, the backend is unavailable.
  native: true,
  // A Signal account is an ACI (a UUID); the phone number is an optional, often hidden, alias.
  addressKinds: ['signal', 'phone'],
  terms: {
    summary:
      'postbote connects to Signal as a linked device (like Signal Desktop), using libsignal, the Rust library the official apps are built on. Signal does not offer an API and does not license third-party clients: postbote is not an official Signal client, and Signal does not support it. Independent clients of this kind (signal-cli, Flare, Whisperfish) exist and are used without known account bans, but Signal could block them at any time. postbote only reads: it never sends messages, read receipts or typing indicators (it does acknowledge delivery, as every linked device must). Signal keeps no server archive, so what postbote receives exists only in its local index, and Signal unlinks a linked device that stays offline for too long.',
    url: 'https://signal.org/legal/',
  },
};
