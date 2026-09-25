/**
 * Real network, no account: open a WhatsApp socket through `@postbote/whatsapp`'s own client
 * construction (Baileys + the gjsify WebSocket shim + postbote's silent logger) for a fresh,
 * unlinked device, and wait for the first QR code. Proves the WebSocket, the noise handshake,
 * protobuf, libsignal's key generation and the WASM bridge work on GJS — the whole stack a real
 * link stands on — without a phone. The QR code is never printed; nothing is linked.
 *
 * The device keys go to postbote's own session storage in a temporary directory, which checks
 * the auth state's first write (creds as TEXT, file 0600) on the way, and is deleted after.
 *
 * Not part of CI (it needs the network). Run: `gjsify workspace postbote-cli test:whatsapp-network`
 */

import { SecretStore } from '@postbote/store';
import { probeQr, SecretStoreAuthState } from '@postbote/whatsapp';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'postbote-wa-probe-'));
const path = join(dir, 'probe.db');

let ok = false;
try {
  const store = SecretStore.open(path);
  try {
    const auth = SecretStoreAuthState.open(store);
    const { ms, qrLength } = await probeQr(auth);
    console.log(
      `whatsapp: QR code received after ${ms} ms (${qrLength} chars, not shown); connection closed`,
    );
  } finally {
    store.close();
  }
  const mode = (statSync(path).mode & 0o777).toString(8);
  if (mode !== '600') throw new Error(`session file mode is ${mode}, expected 600`);
  const reopened = SecretStore.open(path);
  try {
    if (!reopened.get('baileys.creds', 'creds')) throw new Error('the device keys were not persisted');
  } finally {
    reopened.close();
  }
  console.log(`device keys persisted as TEXT (mode ${mode})`);
  ok = true;
} catch (err) {
  console.error('whatsapp probe FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
