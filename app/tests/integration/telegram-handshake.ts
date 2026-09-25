/**
 * Real network, no credentials: connect to Telegram through `@postbote/telegram`'s own client
 * construction (mtcute web build + postbote's platform), run the MTProto auth-key exchange, and
 * make one unauthenticated call. Proves WebSocket, WebCrypto, the WASM crypto and the TL layer
 * work on GJS — the whole stack a real login stands on — without an account or an api_id.
 *
 * Twice, against postbote's own session storage in a temporary directory: the first run must
 * persist the auth key it negotiated (through libgda-backed SQLite, as TEXT), the second must
 * load and reuse that key instead of negotiating a new one.
 *
 * Not part of CI (it needs the network). Run: `gjsify workspace postbote-cli test:telegram-network`
 */

import { SecretStore } from '@postbote/store';
import { SecretStoreStorage, probeHandshake } from '@postbote/telegram';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'postbote-tg-probe-'));
const path = join(dir, 'probe.db');

async function once(label: string): Promise<Map<string, string>> {
  const store = SecretStore.open(path);
  const started = Date.now();
  try {
    const dc = await probeHandshake(new SecretStoreStorage(store));
    console.log(
      `${label}: handshake ok in ${Date.now() - started} ms (this DC ${dc.thisDc}, nearest DC ${dc.nearestDc})`,
    );
  } finally {
    store.close();
  }
  const reopened = SecretStore.open(path);
  try {
    return reopened.load('mtcute.auth_keys');
  } finally {
    reopened.close();
  }
}

let ok = false;
try {
  const first = await once('first connect');
  if (first.size === 0) throw new Error('no auth key was persisted after the first connect');
  const mode = (statSync(path).mode & 0o777).toString(8);
  if (mode !== '600') throw new Error(`session file mode is ${mode}, expected 600`);
  const second = await once('second connect');
  const reused = [...first].every(([dc, key]) => second.get(dc) === key);
  if (!reused)
    throw new Error('the second connect negotiated a new auth key instead of reusing the stored one');
  console.log(`auth key persisted (mode ${mode}) for ${first.size} DC(s) and reused on reconnect`);
  ok = true;
} catch (err) {
  console.error('telegram handshake FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
