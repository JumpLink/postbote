/**
 * `postbote accounts add signal` — linking postbote as a device of the user's Signal account, as a
 * function the CLI calls with its terminal prompts.
 *
 * Ported from Signal-Desktop's linked-device flow: `ts/textsecure/Provisioner.preload.ts` (the
 * provisioning socket and URL), `ProvisioningCipher.node.ts` (opening the phone's envelope),
 * `AccountManager.preload.ts` (`#createAccount` for a linked device) and `WebAPI.preload.ts`
 * (`linkDevice`, `registerKeys`) — Copyright 2020-2026 Signal Messenger, LLC, AGPL-3.0-only.
 *
 * On the phone: Signal → Settings → Linked devices → Link new device, and scan the QR code printed
 * in the terminal. The phone then sends the account's identity key and a one-time provisioning
 * code through the provisioning socket; postbote registers itself with the code
 * (`PUT /v1/devices/link`), then publishes one-time pre-keys (`PUT /v2/keys`). Those two requests
 * are the only ones postbote ever sends to Signal (`guard.ts`).
 *
 * The session is created under a temporary name and moved to `signal-<ACI>.db` only once linked,
 * so a cancelled or failed link never leaves keys that `sync` would try to use. Nothing secret is
 * printed apart from the QR code itself.
 */

import type { AccountPrompter, BackendAccount, BackendContext } from '@postbote/protocol';
import { ensurePrivateDir, SecretStore } from '@postbote/store';
import type * as Core from '@signalapp/libsignal-client';
import { existsSync, renameSync, rmSync } from 'node:fs';
import {
  accountIdFor,
  pendingSessionPath,
  sessionPath,
  sweepPendingSessions,
  writeAccountRecord,
} from './accounts.ts';
import { decryptProvisionEnvelope, encryptDeviceName } from './crypto.ts';
import type { ChatFetch } from './guard.ts';
import { generateLinkKeys, generateOneTimeKeys, generatePassword, generateRegistrationId } from './keys.ts';
import type { SignalLib } from './lib.ts';
import type { ProvisioningListener } from './provisioning.ts';
import { SignalProtocolStore, toBase64 } from './protocol-store.ts';
import { renderQr } from './qr.ts';
import { decodeProvisionEnvelope, encodeDeviceName } from './schema.ts';

export const LINK_TIMEOUT_MS = 3 * 60_000;

/** The two network pieces a link needs — live ones in `backend.ts`, scripted ones in tests. */
export interface LinkNetwork {
  provisioning(key: Core.PrivateKey, listener: ProvisioningListener): Promise<{ close(): Promise<void> }>;
  /** A channel for the link requests; its `fetch` is behind the `link` gate. */
  channel(): Promise<{ fetch: ChatFetch; close(): Promise<void> }>;
}

export interface LinkOptions {
  /** The name the phone lists this device under. */
  deviceName?: string;
  timeoutMs?: number;
}

function basicAuth(user: string, password: string): [string, string] {
  return ['Authorization', `Basic ${btoa(`${user}:${password}`)}`];
}

const JSON_TYPE: [string, string] = ['Content-Type', 'application/json'];

function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Wait for the phone's envelope, opening a new provisioning socket whenever one closes. */
async function receiveProvisioning(
  lib: SignalLib,
  network: LinkNetwork,
  prompter: AccountPrompter,
  timeoutMs: number,
): Promise<{ envelope: Uint8Array; key: Core.PrivateKey }> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt++) {
    const key = lib.core.PrivateKey.generate();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: Promise<{ close(): Promise<void> }> | null = null;
    type Outcome = { envelope: Uint8Array } | { closed: true } | { timeout: true } | { error: Error };
    const outcome = await new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now()));
      socket = network.provisioning(key, {
        onUrl: (url) =>
          prompter.notify(
            `${renderQr(url)}\nScan this with the phone: Signal → Settings → Linked devices → Link new device.`,
          ),
        onEnvelope: (envelope) => resolve({ envelope }),
        onClosed: () => resolve({ closed: true }),
      });
      socket.catch((err: unknown) => resolve({ error: err instanceof Error ? err : new Error(String(err)) }));
    });
    if (timer) clearTimeout(timer);
    const open = await (socket as Promise<{ close(): Promise<void> }> | null)?.catch(() => null);
    await open?.close().catch(() => undefined);
    if ('envelope' in outcome) return { envelope: outcome.envelope, key };
    if ('error' in outcome)
      throw new Error(`the provisioning connection failed (${outcome.error.message}) — nothing was saved`);
    if ('timeout' in outcome) break;
    // The socket closed before the phone answered (Signal rotates them): show a fresh code.
  }
  throw new Error('no phone linked this device in time — nothing was saved');
}

export async function linkSignal(
  lib: SignalLib,
  context: BackendContext,
  prompter: AccountPrompter,
  network: LinkNetwork,
  options: LinkOptions = {},
): Promise<BackendAccount> {
  ensurePrivateDir(context.secretsDir);
  // What a killed earlier link left behind goes first: it may hold an identity key.
  sweepPendingSessions(context.secretsDir);
  const pending = pendingSessionPath(context.secretsDir);
  const file = SecretStore.open(pending);
  const store = SignalProtocolStore.open(lib, file);
  let moved = false;
  let channel: { fetch: ChatFetch; close(): Promise<void> } | null = null;
  try {
    const { envelope, key } = await receiveProvisioning(
      lib,
      network,
      prompter,
      options.timeoutMs ?? LINK_TIMEOUT_MS,
    );
    const message = decryptProvisionEnvelope(lib, decodeProvisionEnvelope(envelope), key);
    if (!message.aci || !message.aciIdentityKeyPrivate || !message.provisioningCode) {
      throw new Error('the phone sent an incomplete link message — nothing was saved');
    }
    prompter.notify('The phone answered. Registering this device…');

    const identity = lib.core.PrivateKey.deserialize(
      message.aciIdentityKeyPrivate as Uint8Array<ArrayBuffer>,
    );
    const registrationId = generateRegistrationId();
    const password = generatePassword();
    store.setIdentityKey(identity);
    store.setRegistrationId(registrationId);
    const linkKeys = generateLinkKeys(lib, store);
    const deviceName = toBase64(
      encodeDeviceName(
        encryptDeviceName(lib, options.deviceName?.trim() || 'postbote', identity.getPublicKey()),
      ),
    );

    channel = await network.channel();
    const linked = await channel.fetch({
      verb: 'PUT',
      path: '/v1/devices/link',
      headers: [basicAuth(message.aci, password), JSON_TYPE],
      body: jsonBody({
        verificationCode: message.provisioningCode,
        accountAttributes: {
          fetchesMessages: true,
          name: deviceName,
          registrationId,
          capabilities: {
            attachmentBackfill: false,
            spqr: true,
            usernameChangeSyncMessage: true,
            optionalPhoneNumber: true,
          },
        },
        aciSignedPreKey: linkKeys.signedPreKey,
        aciPqLastResortPreKey: linkKeys.pqLastResortPreKey,
      }),
    });
    if (linked.status < 200 || linked.status >= 300) {
      throw new Error(
        `Signal refused the link (status ${linked.status}${linked.message ? `: ${linked.message}` : ''}) — nothing was saved`,
      );
    }
    const answer = JSON.parse(new TextDecoder().decode(linked.body ?? new Uint8Array())) as {
      uuid?: string;
      deviceId?: number;
    };
    if (answer.uuid?.toLowerCase() !== message.aci || typeof answer.deviceId !== 'number') {
      throw new Error('Signal answered the link for a different account — nothing was saved');
    }
    store.setAccount({ aci: message.aci, deviceId: answer.deviceId, password, registrationId });

    // One batch of one-time pre-keys. The device already works without them (senders fall back to
    // the last-resort Kyber key), so a failure here is reported, not fatal.
    const oneTime = generateOneTimeKeys(lib, store);
    try {
      const keys = await channel.fetch({
        verb: 'PUT',
        path: '/v2/keys?identity=aci',
        headers: [basicAuth(`${message.aci}.${answer.deviceId}`, password), JSON_TYPE],
        body: jsonBody(oneTime),
      });
      if (keys.status < 200 || keys.status >= 300) throw new Error(`status ${keys.status}`);
    } catch (err) {
      prompter.notify(
        `Linked, but the one-time keys were not published (${err instanceof Error ? err.message : String(err)}); new contacts fall back to the last-resort key.`,
      );
    }

    const accountId = accountIdFor(message.aci);
    const account: BackendAccount = {
      id: accountId,
      identity: `Signal ${message.aci.slice(0, 8)}`,
      provider: 'Signal',
    };
    store.flush();
    writeAccountRecord(file, { identity: account.identity });
    file.close();
    renameSync(pending, sessionPath(context.secretsDir, accountId));
    moved = true;
    prompter.notify(
      'Linked. Run `postbote sync` now: Signal keeps what arrived for this device only until it is received, and the phone sends the contact list on its own.',
    );
    return account;
  } finally {
    if (channel) await channel.close().catch(() => undefined);
    if (!moved) {
      store.discard();
      try {
        file.close();
      } catch {
        // Already closed after a successful link that failed later at the rename.
      }
      for (const path of [pending, `${pending}-journal`]) if (existsSync(path)) rmSync(path, { force: true });
    }
  }
}
