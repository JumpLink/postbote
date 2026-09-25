/**
 * The real socket: Baileys' multi-device client (WebSocket + noise handshake + libsignal +
 * the `whatsapp-rust-bridge` WASM), which runs on GJS through gjsify.
 *
 * Everything else in this package talks to `WaSocketHandle`; this file is the only one that
 * constructs Baileys, so the tests never need the network.
 *
 * READ-ONLY, and why that holds (Baileys 7.0.0-rc14, file references into its source):
 *   - No send path is reachable: `WaSocketHandle` exposes events, the pairing-code request and
 *     `end` — not `sendMessage`, `readMessages`, `sendPresenceUpdate` or `chatModify`.
 *   - `markOnlineOnConnect: false`: on open, Baileys announces `unavailable` instead of
 *     `available` (Socket/chats.ts, the `connection.update` handler), so contacts never see
 *     this device online, and the phone keeps getting its notifications.
 *   - Read receipts are sent only by `readMessages` (Socket/messages-send.ts), which nothing
 *     calls. What Baileys does send for every delivered message is the DELIVERY receipt —
 *     type `inactive` while not online (Socket/messages-recv.ts, `handleMessage`) — the grey
 *     double tick every linked device sends, and the signal for the server to forget the
 *     message. Without it the server would re-deliver forever.
 *   - `end()` closes the socket; it never calls `logout()`, which would unlink the device.
 *
 * The logger is silent: Baileys logs protocol objects (keys, message nodes) at info and debug,
 * and nothing of that may reach a terminal scrollback or an MCP transcript.
 */

import { DEFAULT_ORIGIN, makeWASocket } from 'baileys';
import { WebSocketClient } from 'baileys/lib/Socket/Client/websocket.js';
import WebSocket from 'ws';
import type { WaSocketHandle } from './api.ts';
import type { SecretStoreAuthState } from './auth-state.ts';

export interface SocketOptions {
  auth: SecretStoreAuthState;
  /**
   * Ask the phone for the FULL history on linking, instead of the recent months. Only takes
   * effect when a device is linked. Off by default: every message costs executions of a
   * per-process budget (gjsify#1838), and a full history can be a six-digit message count.
   */
  fullHistory?: boolean;
}

export type SocketFactory = (options: SocketOptions) => WaSocketHandle;

// fixed upstream in gjsify: #1809 (@gjsify/ws took `new WebSocket(url, options)` for
// `(url, protocols)`, so Baileys' origin and headers were lost and the handshake failed) —
// remove at the next gjsify bump. The three-argument form is what `ws` documents and is exactly
// what Baileys' own `connect()` does otherwise, so this is correct on Node as well.
let shimmed = false;
function shimWebSocketOptions(): void {
  if (shimmed) return;
  shimmed = true;
  const proto = WebSocketClient.prototype as unknown as {
    connect(this: ShimmedClient): void;
  };
  proto.connect = function connect(this: ShimmedClient): void {
    if (this.socket) return;
    const socket = new WebSocket(this.url, undefined, {
      origin: DEFAULT_ORIGIN,
      headers: this.config.options?.headers as Record<string, string> | undefined,
      handshakeTimeout: this.config.connectTimeoutMs,
      timeout: this.config.connectTimeoutMs,
      agent: this.config.agent,
    } as WebSocket.ClientOptions);
    socket.setMaxListeners(0);
    this.socket = socket;
    for (const event of [
      'close',
      'error',
      'upgrade',
      'message',
      'open',
      'ping',
      'pong',
      'unexpected-response',
    ]) {
      socket.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }
  };
}

interface ShimmedClient {
  socket: WebSocket | null;
  url: URL;
  config: {
    options?: { headers?: unknown };
    connectTimeoutMs?: number;
    agent?: unknown;
  };
  emit(event: string, ...args: unknown[]): boolean;
}

/** A logger that says nothing — see the file comment. */
function silentLogger(): Parameters<typeof makeWASocket>[0]['logger'] {
  const noop = () => {};
  const logger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  return logger as unknown as Parameters<typeof makeWASocket>[0]['logger'];
}

/** The one place Baileys' socket is constructed. */
export const createBaileysSocket: SocketFactory = ({ auth, fullHistory = false }) => {
  shimWebSocketOptions();
  const sock = makeWASocket({
    auth: auth.state,
    logger: silentLogger(),
    markOnlineOnConnect: false,
    syncFullHistory: fullHistory,
    // Keep every history chunk the phone sends: Baileys' default drops the FULL one, and a
    // dropped chunk is gone — the phone does not send it twice.
    shouldSyncHistoryMessage: () => true,
    // Only used to re-send the user's own messages on a retry request; postbote sends none.
    getMessage: async () => undefined,
  });
  sock.ev.on('creds.update', () => auth.saveCreds());
  return {
    ev: sock.ev as unknown as WaSocketHandle['ev'],
    requestPairingCode: (phoneNumber) => sock.requestPairingCode(phoneNumber),
    end: () => {
      // Hand over what Baileys still buffers BEFORE closing: `end()` destroys the buffer, and
      // the messages in it were already acknowledged — the server will not send them again.
      sock.ev.flush();
      void sock.end(undefined).catch(() => {});
    },
  };
};

/**
 * A credential-free network check: open a socket for a fresh, unlinked device and wait for the
 * first QR code — which proves the WebSocket, the noise handshake, protobuf and the WASM bridge
 * work on this runtime — then close. Nothing is linked; the QR code is never shown or returned.
 */
export async function probeQr(
  auth: SecretStoreAuthState,
  timeoutMs = 60_000,
  createSocket: SocketFactory = createBaileysSocket,
): Promise<{ ms: number; qrLength: number }> {
  const started = Date.now();
  const sock = createSocket({ auth });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no QR code within ${timeoutMs} ms`)), timeoutMs);
      sock.ev.on('connection.update', (update) => {
        if (update.qr) {
          clearTimeout(timer);
          resolve({ ms: Date.now() - started, qrLength: update.qr.length });
        } else if (update.connection === 'close') {
          clearTimeout(timer);
          reject(new Error('the connection closed before a QR code arrived'));
        }
      });
    });
  } finally {
    sock.end();
    auth.flush();
  }
}
