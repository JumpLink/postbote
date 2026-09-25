/**
 * The manifest of the Matrix backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';

export const MATRIX_MANIFEST: BackendManifest = {
  name: 'matrix',
  displayName: 'Matrix (matrix-js-sdk, Rust crypto as WebAssembly)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do. postbote v1 only reads, so none of this is a promise that postbote
  // can SEND it.
  capabilities: {
    // `m.replace` relations.
    edits: true,
    // `m.annotation` relations.
    reactions: true,
    // `m.thread` relations (and reply chains everywhere).
    threads: true,
    // `m.read` receipts, for both sides.
    readReceipts: true,
    groups: true,
    // Megolm rooms are end-to-end encrypted, and this backend decrypts them where it holds the
    // room key (see the package's README section in AGENTS.md for which history that is).
    e2ee: true,
    subject: false,
    folders: false,
    attachments: true,
  },
  // The homeserver keeps the room history: the index is rebuildable (`derived`). The crypto
  // store (the device's Olm account and the room keys it received) is not — it is `secret`,
  // and kept apart from the index in the account's secret file.
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['matrix'],
  // Matrix is an open protocol with a client-server API meant for third-party clients; the only
  // terms are the ones of the homeserver the user already has an account on.
  terms: null,
};
