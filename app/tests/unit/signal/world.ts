/**
 * A synthetic Signal world for the tests: the user's phone (the primary device of the account),
 * contacts with their own devices, a sealed-sender trust root, and a scripted chat server that
 * delivers envelopes to postbote and records what postbote acknowledged.
 *
 * Every envelope is ENCRYPTED with libsignal by an in-process party, so what postbote decrypts is
 * real Signal protocol traffic — only the transport is scripted. All identities are synthetic.
 */

import * as Signal from '@signalapp/libsignal-client';
import * as Zk from '@signalapp/libsignal-client/dist/zkgroup/index.js';

import type { BackendContext } from '@postbote/protocol';
import {
  type ChatConnector,
  type ChatFetch,
  type ChatListenerLike,
  type ContentInput,
  encodeContent,
  encodeEnvelope,
  encodeProvisionEnvelope,
  encodeProvisionMessage,
  encryptProvisionBody,
  EnvelopeType,
  guardedFetch,
  type LinkNetwork,
  NS,
  padPlaintext,
  type SignalLib,
  type SignalProtocolStore,
} from '@postbote/signal';
import { join } from 'node:path';

import { Party } from './stores.ts';

export const LIB: SignalLib = { core: Signal, zk: Zk };

export const OWN_ACI = '5b5a4c62-2f39-4e59-9d0e-1f4d7c3a0b11';
export const ALICE_ACI = '9d0652a3-dcc3-4d11-975f-74d61598733f';
export const CAROL_ACI = '796abedb-ca4e-4f18-8803-1fde5b921f9f';
export const OUR_DEVICE = 2;

export function context(dir: string, settings: BackendContext['settings'] = {}): BackendContext {
  return { settings, env: {}, secretsDir: join(dir, 'secrets', 'signal') };
}

/** Sealed-sender trust root and server key, as Signal's servers hold them. */
export class TrustRoot {
  readonly root = Signal.PrivateKey.generate();
  readonly server = Signal.PrivateKey.generate();
  readonly serverCert = Signal.ServerCertificate.new(1, this.server.getPublicKey(), this.root);

  get publicKeys(): Uint8Array[] {
    return [this.root.getPublicKey().serialize()];
  }

  certificate(party: Party): Signal.SenderCertificate {
    return Signal.SenderCertificate.new(
      party.address.name(),
      null,
      party.address.deviceId(),
      party.identity.identity.getPublicKey(),
      Date.now() + 86_400_000,
      this.serverCert,
      this.server,
    );
  }
}

/** The phone: the account's identity key, and the link it performs. */
export class Phone {
  readonly identity = Signal.PrivateKey.generate();
  readonly profileKey = new Uint8Array(32).fill(3);
  /** Requests the fake chat channel received, after the gate. */
  readonly requests: Array<{ verb: string; path: string; body: unknown }> = [];
  linkStatus = 200;
  /** The phone's own device, for sync messages to postbote's device. */
  readonly device: Party;

  constructor() {
    this.device = new Party(OWN_ACI, 1, 21, this.identity);
  }

  network(): LinkNetwork {
    return {
      provisioning: async (key, listener) => {
        setTimeout(() => {
          listener.onUrl('sgnl://linkdevice?uuid=synthetic&pub_key=synthetic');
          const message = encodeProvisionMessage({
            aciIdentityKeyPublic: this.identity.getPublicKey().serialize(),
            aciIdentityKeyPrivate: this.identity.serialize(),
            aci: OWN_ACI,
            provisioningCode: 'code-123456',
            profileKey: this.profileKey,
          });
          listener.onEnvelope(
            encodeProvisionEnvelope(encryptProvisionBody(LIB, message, key.getPublicKey().serialize())),
          );
        }, 1);
        return { close: async () => undefined };
      },
      channel: async () => {
        const fetch: ChatFetch = guardedFetch('link', async (request) => {
          const body = request.body ? JSON.parse(new TextDecoder().decode(request.body)) : null;
          this.requests.push({ verb: request.verb, path: request.path, body });
          if (request.path === '/v1/devices/link') {
            if (this.linkStatus !== 200) return { status: this.linkStatus, message: 'refused' };
            return {
              status: 200,
              body: new TextEncoder().encode(JSON.stringify({ uuid: OWN_ACI, deviceId: OUR_DEVICE })),
            };
          }
          return { status: 200 };
        });
        return { fetch, close: async () => undefined };
      },
    };
  }
}

/**
 * A bundle for postbote's device, as the server would hand it out, from its session file. The
 * server hands each one-time pre-key out once: `index` picks which.
 */
export async function bundleFor(store: SignalProtocolStore, index = 0): Promise<Signal.PreKeyBundle> {
  const identity = store.identityKey();
  const account = store.account();
  if (!account) throw new Error('not linked');
  const signedId = Number(store.keys(NS.signedPreKey)[0]);
  const signed = await store.signedPreKeys.getSignedPreKey(signedId);
  const kyberId = Number(
    store.keys(NS.kyberPreKey).find((id) => JSON.parse(store.get(NS.kyberPreKey, id) as string).lastResort),
  );
  const kyber = await store.kyberPreKeys.getKyberPreKey(kyberId);
  const preKeyId = Number(store.keys(NS.preKey)[index]);
  const preKey = await store.preKeys.getPreKey(preKeyId);
  return Signal.PreKeyBundle.new(
    account.registrationId,
    account.deviceId,
    preKeyId,
    preKey.publicKey(),
    signedId,
    signed.publicKey(),
    signed.signature(),
    identity.getPublicKey(),
    kyberId,
    kyber.publicKey(),
    kyber.signature(),
  );
}

export const ourAddress = (): Signal.ProtocolAddress => Signal.ProtocolAddress.new(OWN_ACI, OUR_DEVICE);

let guid = 0;

/** Start a session from `party` to postbote's device, with the `index`-th one-time pre-key. */
export async function introduce(party: Party, store: SignalProtocolStore, index = 0): Promise<void> {
  await Signal.processPreKeyBundle(
    await bundleFor(store, index),
    ourAddress(),
    party.address,
    party.sessions,
    party.identity,
  );
}

/** A plain (not sealed) envelope from `party`. */
export async function directEnvelope(
  party: Party,
  content: ContentInput,
  timestamp: number,
): Promise<Uint8Array> {
  const cipher = await Signal.signalEncrypt(
    padPlaintext(encodeContent(content)),
    ourAddress(),
    party.address,
    party.sessions,
    party.identity,
  );
  return encodeEnvelope({
    type:
      cipher.type() === Signal.CiphertextMessageType.PreKey
        ? EnvelopeType.PREKEY_MESSAGE
        : EnvelopeType.DOUBLE_RATCHET,
    sourceServiceId: party.address.name(),
    sourceDevice: party.address.deviceId(),
    destinationServiceId: OWN_ACI,
    clientTimestamp: timestamp,
    serverTimestamp: Date.now(),
    serverGuid: `guid-${++guid}`,
    content: cipher.serialize(),
  });
}

/** A sealed-sender envelope from `party`. */
export async function sealedEnvelope(
  party: Party,
  trust: TrustRoot,
  content: ContentInput,
  timestamp: number,
): Promise<Uint8Array> {
  const sealed = await Signal.sealedSenderEncryptMessage(
    padPlaintext(encodeContent(content)),
    ourAddress(),
    trust.certificate(party),
    party.sessions,
    party.identity,
  );
  return encodeEnvelope({
    type: EnvelopeType.UNIDENTIFIED_SENDER,
    destinationServiceId: OWN_ACI,
    clientTimestamp: timestamp,
    serverTimestamp: Date.now(),
    serverGuid: `guid-${++guid}`,
    content: sealed,
  });
}

export function groupIdOf(masterKey: Uint8Array): Uint8Array<ArrayBuffer> {
  return Zk.GroupSecretParams.deriveFromMasterKey(new Zk.GroupMasterKey(masterKey as Uint8Array<ArrayBuffer>))
    .getPublicParams()
    .getGroupIdentifier()
    .serialize();
}

/** Group messages with a sender key: the distribution message first, then the group message. */
export class GroupSender {
  readonly distributionId = 'd1b2c3d4-0000-4000-8000-00000000abcd';
  readonly masterKey: Uint8Array<ArrayBuffer>;
  constructor(masterKey: Uint8Array<ArrayBuffer>) {
    this.masterKey = masterKey;
  }

  async distribution(party: Party): Promise<Uint8Array<ArrayBuffer>> {
    const skdm = await Signal.SenderKeyDistributionMessage.create(
      party.address,
      this.distributionId,
      party.senderKeys,
    );
    return skdm.serialize();
  }

  async envelope(
    party: Party,
    trust: TrustRoot,
    content: ContentInput,
    timestamp: number,
  ): Promise<Uint8Array> {
    const cipher = await Signal.groupEncrypt(
      party.address,
      this.distributionId,
      party.senderKeys,
      padPlaintext(encodeContent(content)),
    );
    const usmc = Signal.UnidentifiedSenderMessageContent.new(
      cipher,
      trust.certificate(party),
      0,
      groupIdOf(this.masterKey),
    );
    const sealed = await Signal.sealedSenderEncrypt(usmc, ourAddress(), party.identity);
    return encodeEnvelope({
      type: EnvelopeType.UNIDENTIFIED_SENDER,
      destinationServiceId: OWN_ACI,
      clientTimestamp: timestamp,
      serverTimestamp: Date.now(),
      serverGuid: `guid-${++guid}`,
      content: sealed,
    });
  }
}

/**
 * The chat server's side of the receive connection: a queue of envelopes, delivered in order
 * on connect, then "queue empty". An envelope stays queued until postbote acknowledges it — the
 * next connection delivers it again — unless `dropAcks` simulates a crash before the ack arrived.
 */
export class FakeServer {
  queue: Array<{ id: number; bytes: Uint8Array }> = [];
  acked: number[] = [];
  connects = 0;
  disconnects = 0;
  dropAcks = false;
  /** Deliver "queue empty" after the envelopes (false: never — the time cap has to end the run). */
  sendQueueEmpty = true;
  /** Fail the connection attempt with this error. */
  connectError: Error | null = null;
  private next = 0;

  push(...envelopes: Uint8Array[]): void {
    for (const bytes of envelopes) this.queue.push({ id: ++this.next, bytes });
  }

  connector(): ChatConnector {
    return async (listener: ChatListenerLike) => {
      this.connects++;
      if (this.connectError) throw this.connectError;
      const delivered = [...this.queue];
      setTimeout(() => {
        for (const item of delivered) {
          listener.onIncomingMessage(item.bytes, Date.now(), {
            send: (status) => {
              if (this.dropAcks || status !== 200) return;
              this.acked.push(item.id);
              this.queue = this.queue.filter((q) => q.id !== item.id);
            },
          });
        }
        if (this.sendQueueEmpty) listener.onQueueEmpty();
      }, 1);
      return {
        disconnect: async () => {
          this.disconnects++;
        },
      };
    };
  }
}
