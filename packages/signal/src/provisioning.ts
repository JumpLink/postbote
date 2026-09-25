/**
 * The provisioning socket — the first step of linking a device: Signal hands out an address, the
 * phone scans it (with this device's provisioning public key) as a QR code, and sends its
 * encrypted `ProvisionEnvelope` through the same socket.
 *
 * Follows Signal-Desktop `ts/textsecure/Provisioner.preload.ts` (Copyright 2020-2026 Signal
 * Messenger, LLC, AGPL-3.0-only), which also takes libsignal's `Net.connectProvisioning`.
 */

import type * as Core from '@signalapp/libsignal-client';
import type { SignalLib } from './lib.ts';
import { linkDeviceUrl } from './link-url.ts';

export interface ProvisioningListener {
  /** The link URL to show as a QR code. Called once per socket. */
  onUrl(url: string): void;
  /** The phone's encrypted envelope. */
  onEnvelope(envelope: Uint8Array): void;
  onClosed(cause: Error | null): void;
}

/** One provisioning socket with its key pair. `close()` ends it. */
export async function openProvisioning(
  lib: SignalLib,
  net: Core.Net.Net,
  key: Core.PrivateKey,
  listener: ProvisioningListener,
  abortSignal?: AbortSignal,
): Promise<{ close(): Promise<void> }> {
  const connection = await net.connectProvisioning(
    {
      onReceivedAddress(address, ack) {
        ack.send(200);
        listener.onUrl(linkDeviceUrl({ address, publicKey: key.getPublicKey().serialize() }));
      },
      onReceivedEnvelope(envelope, ack) {
        ack.send(200);
        listener.onEnvelope(envelope);
      },
      onConnectionInterrupted(cause) {
        listener.onClosed(cause);
      },
    },
    { abortSignal },
  );
  return { close: () => connection.disconnect() };
}

export interface ProvisioningProbeResult {
  /** Milliseconds until the provisioning address arrived. */
  ms: number;
  /** Length of the `sgnl://linkdevice` URL that was built and discarded — never the URL. */
  urlLength: number;
}

/**
 * Open a provisioning socket, wait for the address, build the link URL, drop it, close. Nothing
 * is linked, nothing is kept. For the opt-in network test.
 */
export async function probeProvisioning(
  lib: SignalLib,
  net: Core.Net.Net,
  timeoutMs = 15_000,
): Promise<ProvisioningProbeResult> {
  const started = Date.now();
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
    rejectUrl(new Error(`no provisioning address within ${timeoutMs} ms`));
  }, timeoutMs);
  try {
    const socket = await openProvisioning(
      lib,
      net,
      lib.core.PrivateKey.generate(),
      {
        onUrl: resolveUrl,
        onEnvelope: () => undefined,
        onClosed: (cause) => {
          if (cause) rejectUrl(cause);
        },
      },
      abort.signal,
    );
    try {
      const link = await url;
      return { ms: Date.now() - started, urlLength: link.length };
    } finally {
      await socket.close();
    }
  } finally {
    clearTimeout(timer);
  }
}
