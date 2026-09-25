/**
 * The first step of linking a device: open Signal's provisioning socket and receive the
 * provisioning address the phone would be shown as a QR code.
 *
 * The socket is libsignal's own (`Net.connectProvisioning`, the path Signal-Desktop takes in
 * `ts/textsecure/Provisioner.preload.ts`): TLS pinned to Signal's private root, the WebSocket and
 * the protobuf framing all run inside the Rust addon. A W3C WebSocket cannot take that pinned
 * root, which is why this does not go through gjsify's WebSocket.
 *
 * `probeProvisioning` stops after the address: it builds the link URL to prove the shape, then
 * drops it and closes. Nothing is linked, nothing is kept. Used by the opt-in network test.
 */

import { Net, PrivateKey } from '@signalapp/libsignal-client';

import { linkDeviceUrl } from './link-url.ts';

export interface ProvisioningProbeResult {
  /** Milliseconds until the provisioning address arrived. */
  ms: number;
  addressLength: number;
  /** Length of the `sgnl://linkdevice` URL that was built and discarded — never the URL. */
  urlLength: number;
}

export async function probeProvisioning(
  options: { userAgent?: string; timeoutMs?: number } = {},
): Promise<ProvisioningProbeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const net = new Net.Net({ env: Net.Environment.Production, userAgent: options.userAgent ?? 'postbote' });
  const key = PrivateKey.generate();

  let onAddress!: (address: string) => void;
  let onFailure!: (error: Error) => void;
  const address = new Promise<string>((resolve, reject) => {
    onAddress = resolve;
    onFailure = reject;
  });

  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
    onFailure(new Error(`no provisioning address within ${timeoutMs} ms`));
  }, timeoutMs);

  try {
    const connection = await net.connectProvisioning(
      {
        onReceivedAddress(value, ack) {
          ack.send(200);
          onAddress(value);
        },
        // The probe never shows the address, so no phone can answer — refuse anything anyway.
        onReceivedEnvelope(_envelope, ack) {
          ack.send(400);
        },
        onConnectionInterrupted(cause) {
          if (cause) onFailure(cause);
        },
      },
      { abortSignal: abort.signal },
    );
    try {
      const value = await address;
      const ms = Date.now() - started;
      const urlLength = linkDeviceUrl({ address: value, publicKey: key.getPublicKey().serialize() }).length;
      return { ms, addressLength: value.length, urlLength };
    } finally {
      await connection.disconnect();
    }
  } finally {
    clearTimeout(timer);
  }
}
