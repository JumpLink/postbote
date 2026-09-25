/**
 * Real network, no account: open Signal's provisioning socket through `@postbote/signal`
 * (libsignal's own TLS + WebSocket, pinned to Signal's root) and wait for the provisioning
 * address a phone would scan. Proves libsignal's networking — its Tokio runtime and the N-API
 * thread-safe callbacks into JS — works on GJS. The link URL is built and discarded, never
 * printed; nothing is linked.
 *
 * Not part of CI (it needs the network). Run: `gjsify workspace postbote-cli test:signal-network`
 */

import { probeProvisioning } from '@postbote/signal';

let ok = false;
try {
  const { ms, addressLength, urlLength } = await probeProvisioning();
  console.log(
    `signal: provisioning address received after ${ms} ms (${addressLength} chars, link URL ${urlLength} chars, not shown); connection closed`,
  );
  ok = true;
} catch (err) {
  console.error('signal provisioning FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
}
process.exit(ok ? 0 : 1);
