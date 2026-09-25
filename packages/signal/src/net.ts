/**
 * The live connections to Signal, all through libsignal-net: TLS pinned to Signal's own root, the
 * WebSocket and its framing inside the Rust addon (a W3C WebSocket cannot pin that root — see the
 * spike in `docs/adr/0001-multi-protocol-messenger.md`).
 *
 * Three kinds, each handed out with the least it needs:
 * - the provisioning socket (link time): receives the address and the phone's envelope;
 * - an unauthenticated chat connection (link time): only a `guardedFetch('link', …)` leaves here;
 * - the authenticated chat connection (sync): a `ChatHandle` — receive and disconnect, no fetch.
 */

import type * as Core from '@signalapp/libsignal-client';
import type { ChatFetch } from './guard.ts';
import { guardedFetch } from './guard.ts';
import type { SignalLib } from './lib.ts';
import type { DeviceAccount } from './protocol-store.ts';
import type { ChatConnector } from './receiver.ts';

export const USER_AGENT = 'postbote';

export function createNet(lib: SignalLib): Core.Net.Net {
  return new lib.core.Net.Net({ env: lib.core.Net.Environment.Production, userAgent: USER_AGENT });
}

/** True for the errors that mean the server no longer knows this device. */
export function isDelinked(lib: SignalLib, err: unknown): boolean {
  if (!(err instanceof lib.core.LibSignalErrorBase)) return false;
  return (
    err.code === lib.core.ErrorCode.DeviceDelinked || err.code === lib.core.ErrorCode.RequestUnauthorized
  );
}

/** The authenticated receive connection of a linked device. */
export function liveConnector(net: Core.Net.Net, account: DeviceAccount): ChatConnector {
  return async (listener) => {
    const connection = await net.connectAuthenticatedChat(
      `${account.aci}.${account.deviceId}`,
      account.password,
      // Stories are not read: the server filters them out.
      false,
      {
        onIncomingMessage: (envelope, timestamp, ack) => listener.onIncomingMessage(envelope, timestamp, ack),
        onQueueEmpty: () => listener.onQueueEmpty(),
        onConnectionInterrupted: (cause) => listener.onConnectionInterrupted(cause),
        onReceivedAlerts: () => undefined,
      },
    );
    return { disconnect: () => connection.disconnect() };
  };
}

/** An unauthenticated connection for the two link requests, behind the read-only gate. */
export async function linkChannel(net: Core.Net.Net): Promise<{ fetch: ChatFetch; close(): Promise<void> }> {
  const connection = await net.connectUnauthenticatedChat({ onConnectionInterrupted: () => undefined });
  const fetch = guardedFetch('link', async (request) => {
    const response = await connection.fetch({
      verb: request.verb,
      path: request.path,
      headers: request.headers,
      body: request.body as Uint8Array<ArrayBuffer> | undefined,
    });
    return { status: response.status, message: response.message, body: response.body };
  });
  return { fetch, close: () => connection.disconnect() };
}
