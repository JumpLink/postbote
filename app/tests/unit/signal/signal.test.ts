import { describe, expect, it } from '@gjsify/unit';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, DeliveryEvent } from '@postbote/protocol';
import { isDeliveryBackend, validateManifest } from '@postbote/protocol';
import {
  chatConversationId,
  getConversation,
  listConversations,
  rebuildConversations,
  receiveDeliveries,
  SecretStore,
} from '@postbote/store';
import {
  accountIdFor,
  attachmentUrl,
  checkRequest,
  contactEvents,
  decodeContent,
  decodeContactDetails,
  decodeDeviceName,
  decodeEnvelope,
  decodeProvisionEnvelope,
  decryptAttachment,
  decryptDeviceName,
  decryptProvisionEnvelope,
  delimited,
  encodeContactDetails,
  encodeContent,
  encodeDeviceName,
  encodeEnvelope,
  encodeProvisionEnvelope,
  encodeProvisionMessage,
  encryptAttachment,
  encryptDeviceName,
  encryptProvisionBody,
  EnvelopeDecryptor,
  EnvelopeType,
  FileJournal,
  fromBase64,
  journalPath,
  linkDeviceUrl,
  NS,
  padPlaintext,
  parseContactsBlob,
  parseSettings,
  PENDING_STALE_MS,
  readContactsSync,
  ReadOnlyViolation,
  RELINK_HINT,
  serviceIdFromBinary,
  sessionPath,
  SIGNAL_MANIFEST,
  SignalBackend,
  type SignalBackendOptions,
  SignalMapper,
  SignalProtocolStore,
  SignalReceiver,
  unpadPlaintext,
  uuidToBytes,
} from '@postbote/signal';
import * as Signal from '@signalapp/libsignal-client';

import { builtinRegistry } from '../../../src/core/backends/builtin.ts';
import { freshDb } from '../store/fixtures.ts';
import { Party } from './stores.ts';
import {
  ALICE_ACI,
  CAROL_ACI,
  context,
  directEnvelope,
  FakeServer,
  GroupSender,
  groupIdOf,
  introduce,
  LIB,
  OUR_DEVICE,
  OWN_ACI,
  Phone,
  sealedEnvelope,
  TrustRoot,
} from './world.ts';

/**
 * The Signal backend without Signal's servers: the wire schema, the crypto around the protocol,
 * the read-only gate, the link as a phone would perform it, and whole syncs of envelopes that
 * in-process parties ENCRYPTED with libsignal — direct, sealed sender, sender-key groups, the
 * user's own messages from the phone — through a scripted chat server into the index, including
 * crashes between receiving and acknowledging. Also the proof the backend stands on: libsignal's
 * prebuilt N-API addon runs on GJS (through @gjsify/napi) exactly as on Node, async store
 * callbacks included. All identities and data are synthetic.
 *
 */

// gjsify gap (unfixed, gjsify#1842): the Node run needs `POSTBOTE_CLI_PREBUILD`, set by the app's
// `test` script. gjsify's `--app node` target bundles libsignal, whose `node-gyp-build` call then
// searches the bundle's directory for the addon; node-gyp-build honours `<PACKAGE>_PREBUILD` for
// that directory. Drop the variable from the script once gjsify keeps native addons external.

const ACCOUNT = accountIdFor(OWN_ACI);
const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postbote-signal-'));
}

function prompter(): AccountPrompter & { notes: string[] } {
  const notes: string[] = [];
  return {
    notes,
    ask: async () => '',
    notify: (message) => notes.push(message),
  };
}

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

/** Link postbote's device through the scripted phone. */
async function link(dir: string, phone = new Phone()): Promise<Phone> {
  await new SignalBackend(context(dir), { lib: LIB, linkNetwork: () => phone.network() }).addAccount(
    prompter(),
  );
  return phone;
}

function openStore(dir: string): { file: SecretStore; store: SignalProtocolStore } {
  const file = SecretStore.open(sessionPath(context(dir).secretsDir, ACCOUNT));
  return { file, store: SignalProtocolStore.open(LIB, file) };
}

/** Start sessions from each party to postbote's device, from the session file, then close it. */
async function introduceAll(dir: string, ...parties: Party[]): Promise<void> {
  const { file, store } = openStore(dir);
  try {
    for (const [i, p] of parties.entries()) await introduce(p, store, i);
  } finally {
    file.close();
  }
}

function backendFor(
  dir: string,
  server: FakeServer,
  trust: TrustRoot,
  extra: Partial<SignalBackendOptions> = {},
) {
  return new SignalBackend(context(dir), {
    lib: LIB,
    trustRoots: trust.publicKeys,
    connector: () => server.connector(),
    download: async () => {
      throw new Error('no CDN in tests');
    },
    ...extra,
    receiver: { maxMs: 5_000, commitEvery: 3, ...extra.receiver },
  });
}

function bodies(db: ReturnType<typeof freshDb>, chat: string): string {
  const c = getConversation(db, chatConversationId('signal', ACCOUNT, chat), { includeBodies: true });
  return c?.messages.map((m) => m.bodyText).join('|') ?? '(none)';
}

export default async () => {
  await describe('Signal manifest', async () => {
    await it('is a valid delivery-only, native manifest with a plain terms notice', async () => {
      expect(validateManifest(SIGNAL_MANIFEST).length).toBe(0);
      expect(SIGNAL_MANIFEST.syncModel).toBe('delivery-only');
      expect(SIGNAL_MANIFEST.native).toBe(true);
      expect(SIGNAL_MANIFEST.addressKinds.join(',')).toBe('signal,phone');
      expect(SIGNAL_MANIFEST.terms?.summary.includes('not an official Signal client')).toBe(true);
    });

    await it('is registered as a delivery backend and touches no native code until used', async () => {
      const dir = tempDir();
      try {
        const entry = builtinRegistry()
          .status({ backends: {}, senders: {} })
          .find((e) => e.name === 'signal');
        expect(entry?.syncModel).toBe('delivery-only');
        expect(entry?.storeTier).toBe('state');
        expect(entry?.native).toBe(true);
        const backend = new SignalBackend(context(dir));
        expect(isDeliveryBackend(backend)).toBe(true);
        expect((await backend.listAccounts()).length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('reads only a device name from the config', async () => {
      expect(parseSettings({}).deviceName).toBe('postbote');
      expect(parseSettings({ deviceName: 'Laptop' }).deviceName).toBe('Laptop');
      let message = '';
      try {
        parseSettings({ password: 'x' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.includes('unknown setting')).toBe(true);
    });
  });

  await describe('Signal wire schema', async () => {
    await it('round-trips an envelope and reads binary service ids', async () => {
      const bytes = encodeEnvelope({
        type: EnvelopeType.UNIDENTIFIED_SENDER,
        clientTimestamp: 1_700_000_000_123,
        serverTimestamp: 1_700_000_000_456,
        destinationServiceId: OWN_ACI,
        content: new Uint8Array([1, 2, 3]),
        serverGuid: 'g-1',
      });
      const e = decodeEnvelope(bytes);
      expect(e.type).toBe(6);
      expect(e.clientTimestamp).toBe(1_700_000_000_123);
      expect(e.destinationServiceId).toBe(OWN_ACI);
      expect(e.content?.join(',')).toBe('1,2,3');
      expect(serviceIdFromBinary(uuidToBytes(ALICE_ACI))).toBe(ALICE_ACI);
      const pni = new Uint8Array(17);
      pni[0] = 1;
      pni.set(uuidToBytes(ALICE_ACI), 1);
      expect(serviceIdFromBinary(pni)).toBe(`PNI:${ALICE_ACI}`);
    });

    await it('round-trips content: text, quote, group, sent transcript, receipts, deletes', async () => {
      const content = decodeContent(
        encodeContent({
          dataMessage: {
            body: 'Hallo',
            timestamp: 42,
            quote: { id: 41, authorAci: ALICE_ACI },
            groupMasterKey: new Uint8Array(32).fill(7),
            attachments: [{ fileName: 'plan.pdf', contentType: 'application/pdf' }],
          },
        }),
      );
      expect(content.dataMessage?.body).toBe('Hallo');
      expect(content.dataMessage?.quote?.authorAci).toBe(ALICE_ACI);
      expect(content.dataMessage?.groupMasterKey?.length).toBe(32);
      expect(content.dataMessage?.attachments[0].fileName).toBe('plan.pdf');
      const sync = decodeContent(
        encodeContent({
          sent: {
            destinationServiceId: ALICE_ACI,
            timestamp: 50,
            message: { body: 'von mir', timestamp: 50 },
          },
          read: [{ senderAci: ALICE_ACI, timestamp: 42 }],
          deleteForMe: {
            messages: [{ conversation: { serviceId: ALICE_ACI }, authorAci: ALICE_ACI, timestamp: 42 }],
          },
        }),
      ).syncMessage;
      expect(sync?.sent?.message?.body).toBe('von mir');
      expect(sync?.read[0].timestamp).toBe(42);
      expect(sync?.deleteForMe?.messageDeletes[0].messages[0].sentTimestamp).toBe(42);
      const receipt = decodeContent(encodeContent({ receipt: { type: 1, timestamps: [7, 8] } })).receipt;
      expect(receipt?.timestamps.join(',')).toBe('7,8');
      expect(decodeContent(encodeContent({ typing: true })).other).toBe(true);
    });

    await it('pads and unpads plaintext as Signal does, and rejects bad padding', async () => {
      const padded = padPlaintext(encode('abc'));
      expect(padded.length).toBe(160);
      expect(decode(unpadPlaintext(padded))).toBe('abc');
      let message = '';
      try {
        unpadPlaintext(new Uint8Array([1, 2, 3]));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.includes('padding')).toBe(true);
    });
  });

  await describe('Signal read-only gate', async () => {
    await it('lets the two link requests through during a link and nothing else', async () => {
      checkRequest('link', { verb: 'PUT', path: '/v1/devices/link', headers: [] });
      checkRequest('link', { verb: 'PUT', path: '/v2/keys?identity=aci', headers: [] });
      const refused = [
        { verb: 'PUT', path: `/v1/messages/${ALICE_ACI}` },
        { verb: 'GET', path: `/v1/profile/${ALICE_ACI}` },
        { verb: 'PUT', path: '/v2/keys?identity=pni' },
        { verb: 'DELETE', path: '/v1/devices/2' },
        { verb: 'PUT', path: '/v1/devices/link/extra' },
      ];
      for (const r of refused) {
        let error: unknown = null;
        try {
          checkRequest('link', { ...r, headers: [] });
        } catch (err) {
          error = err;
        }
        expect(error instanceof ReadOnlyViolation).toBe(true);
      }
    });

    await it('refuses every request during a sync — the link requests included', async () => {
      let error: unknown = null;
      try {
        checkRequest('sync', { verb: 'PUT', path: '/v1/devices/link', headers: [] });
      } catch (err) {
        error = err;
      }
      expect(error instanceof ReadOnlyViolation).toBe(true);
    });
  });

  await describe('Signal crypto around the protocol', async () => {
    await it("opens the phone's provisioning envelope, and rejects a tampered one", async () => {
      const key = Signal.PrivateKey.generate();
      const identity = Signal.PrivateKey.generate();
      const plain = encodeProvisionMessage({
        aciIdentityKeyPublic: identity.getPublicKey().serialize(),
        aciIdentityKeyPrivate: identity.serialize(),
        aci: OWN_ACI,
        provisioningCode: 'c0de',
      });
      const bytes = encodeProvisionEnvelope(encryptProvisionBody(LIB, plain, key.getPublicKey().serialize()));
      const message = decryptProvisionEnvelope(LIB, decodeProvisionEnvelope(bytes), key);
      expect(message.aci).toBe(OWN_ACI);
      expect(message.provisioningCode).toBe('c0de');
      expect(message.aciIdentityKeyPrivate?.join(',')).toBe(identity.serialize().join(','));
      const tampered = decodeProvisionEnvelope(bytes);
      const body = tampered.body as Uint8Array;
      body[20] ^= 1;
      let error = '';
      try {
        decryptProvisionEnvelope(LIB, tampered, key);
      } catch (err) {
        error = (err as Error).message;
      }
      expect(error.includes('integrity')).toBe(true);
    });

    await it("encrypts the device name so only the account's identity key reads it", async () => {
      const identity = Signal.PrivateKey.generate();
      const encrypted = encryptDeviceName(LIB, 'postbote', identity.getPublicKey());
      const wire = decodeDeviceName(encodeDeviceName(encrypted));
      expect(
        decryptDeviceName(
          LIB,
          {
            ephemeralPublic: wire.ephemeralPublic as Uint8Array,
            syntheticIv: wire.syntheticIv as Uint8Array,
            ciphertext: wire.ciphertext as Uint8Array,
          },
          identity,
        ),
      ).toBe('postbote');
      expect(decode(encrypted.ciphertext) === 'postbote').toBe(false);
    });

    await it('decrypts an attachment, checks MAC and digest, and cuts the padding', async () => {
      const key = new Uint8Array(64).fill(9);
      const padded = new Uint8Array(100);
      padded.set(encode('Inhalt'));
      const { data, digest } = encryptAttachment(padded, key);
      expect(decode(decryptAttachment(data, key, { size: 6, digest }))).toBe('Inhalt');
      const bad = data.slice();
      bad[20] ^= 1;
      let error = '';
      try {
        decryptAttachment(bad, key, { size: 6 });
      } catch (err) {
        error = (err as Error).message;
      }
      expect(error.includes('integrity')).toBe(true);
    });
  });

  await describe('Signal contact sync', async () => {
    await it('reads the contact blob, skipping avatars, and names people with their numbers', async () => {
      const anna = encodeContactDetails({ aci: ALICE_ACI, number: '+49 151 00000001', name: 'Anna' });
      // An entry that announces a 3-byte avatar behind it: the parser must step over it.
      const withAvatar = new Uint8Array([
        ...encodeContactDetails({ aci: CAROL_ACI, name: 'Carol' }),
        0x1a,
        0x02,
        0x10,
        0x03,
      ]);
      const blob = new Uint8Array([...delimited(anna), ...delimited(withAvatar), 0xff, 0xd8, 0xff]);
      const contacts = parseContactsBlob(blob);
      expect(contacts.map((c) => c.name).join(',')).toBe('Anna,Carol');
      expect(decodeContactDetails(withAvatar).avatarLength).toBe(3);
      const first = contactEvents(contacts)[0] as Extract<DeliveryEvent, { type: 'peer' }>;
      expect(first.peer.addresses.map((a) => `${a.kind}:${a.value}`).join(' ')).toBe(
        `signal:${ALICE_ACI} phone:+4915100000001`,
      );
    });

    await it("downloads from the right CDN and decrypts with the pointer's key", async () => {
      const key = new Uint8Array(64).fill(4);
      const plain = delimited(encodeContactDetails({ aci: ALICE_ACI, name: 'Anna' }));
      const { data, digest } = encryptAttachment(plain, key);
      const urls: string[] = [];
      const pointer = decodeContent(
        encodeContent({ contactsBlob: { cdnKey: 'abc/def', cdnNumber: 3, key, size: plain.length, digest } }),
      ).syncMessage?.contacts?.blob;
      if (!pointer) throw new Error('no pointer');
      expect(attachmentUrl(pointer)).toBe('https://cdn3.signal.org/attachments/abc%2Fdef');
      const events = await readContactsSync(pointer, async (url) => {
        urls.push(url);
        return data;
      });
      expect(urls.length).toBe(1);
      expect((events[0] as Extract<DeliveryEvent, { type: 'peer' }>).peer.displayName).toBe('Anna');
    });
  });

  await describe('libsignal on this runtime', async () => {
    await it('loads the native addon and generates keys', async () => {
      const key = Signal.PrivateKey.generate();
      const serialized = key.getPublicKey().serialize();
      expect(serialized.length).toBe(33);
      expect(serialized[0]).toBe(5);
      const signature = key.sign(encode('synthetic'));
      expect(key.getPublicKey().verify(encode('synthetic'), signature)).toBe(true);
    });

    await it('establishes a session from a pre-key bundle and round-trips both ways', async () => {
      const alice = new Party(ALICE_ACI, 1, 1);
      const bob = new Party(CAROL_ACI, 3, 2);
      await Signal.processPreKeyBundle(
        await bob.bundle(),
        bob.address,
        alice.address,
        alice.sessions,
        alice.identity,
      );
      const first = await Signal.signalEncrypt(
        encode('hello bob'),
        bob.address,
        alice.address,
        alice.sessions,
        alice.identity,
      );
      expect(first.type()).toBe(Signal.CiphertextMessageType.PreKey);
      const opened = await Signal.signalDecryptPreKey(
        Signal.PreKeySignalMessage.deserialize(first.serialize()),
        alice.address,
        bob.address,
        bob.sessions,
        bob.identity,
        bob.preKeys,
        bob.signedPreKeys,
        bob.kyberPreKeys,
      );
      expect(decode(opened)).toBe('hello bob');
      expect(bob.preKeys.records.size).toBe(0);
      const reply = await Signal.signalEncrypt(
        encode('hi alice'),
        alice.address,
        bob.address,
        bob.sessions,
        bob.identity,
      );
      expect(reply.type()).toBe(Signal.CiphertextMessageType.Whisper);
      const answer = await Signal.signalDecrypt(
        Signal.SignalMessage.deserialize(reply.serialize()),
        bob.address,
        alice.address,
        alice.sessions,
        alice.identity,
      );
      expect(decode(answer)).toBe('hi alice');
    });
  });

  await describe('Signal link', async () => {
    await it('links as the phone answers: two gated requests, keys stored, a 0600 session under the ACI', async () => {
      const dir = tempDir();
      try {
        const phone = new Phone();
        const p = prompter();
        const backend = new SignalBackend(context(dir, { deviceName: 'Werkbank' }), {
          lib: LIB,
          linkNetwork: () => phone.network(),
        });
        const account = await backend.addAccount(p);
        expect(account.id).toBe(ACCOUNT);
        expect(p.notes[0].includes('Linked devices')).toBe(true);
        expect(phone.requests.map((r) => `${r.verb} ${r.path}`).join(' | ')).toBe(
          'PUT /v1/devices/link | PUT /v2/keys?identity=aci',
        );
        const linkBody = phone.requests[0].body as {
          verificationCode: string;
          accountAttributes: { name: string; fetchesMessages: boolean };
        };
        expect(linkBody.verificationCode).toBe('code-123456');
        expect(linkBody.accountAttributes.fetchesMessages).toBe(true);
        const name = decodeDeviceName(fromBase64(linkBody.accountAttributes.name));
        expect(
          decryptDeviceName(
            LIB,
            {
              ephemeralPublic: name.ephemeralPublic as Uint8Array,
              syntheticIv: name.syntheticIv as Uint8Array,
              ciphertext: name.ciphertext as Uint8Array,
            },
            phone.identity,
          ),
        ).toBe('Werkbank');
        const keys = phone.requests[1].body as { preKeys: unknown[]; pqPreKeys: unknown[] };
        expect(keys.preKeys.length).toBe(100);
        expect(keys.pqPreKeys.length).toBe(100);

        const path = sessionPath(context(dir).secretsDir, ACCOUNT);
        expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
        const { file, store } = openStore(dir);
        try {
          expect(store.account()?.deviceId).toBe(OUR_DEVICE);
          expect(store.identityKey().serialize().join(',')).toBe(phone.identity.serialize().join(','));
          expect(store.count(NS.signedPreKey)).toBe(1);
          expect(store.count(NS.preKey)).toBe(100);
          expect(store.count(NS.kyberPreKey)).toBe(101);
        } finally {
          file.close();
        }
        expect((await backend.listAccounts()).map((a) => a.id).join(',')).toBe(ACCOUNT);
        expect(readdirSync(context(dir).secretsDir).some((f) => f.includes('pending'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('saves nothing when Signal refuses the link', async () => {
      const dir = tempDir();
      try {
        const phone = new Phone();
        phone.linkStatus = 403;
        const message = await rejection(() => link(dir, phone));
        expect(message.includes('refused the link (status 403')).toBe(true);
        expect(readdirSync(context(dir).secretsDir).length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('sweeps a pending file a killed link left behind, but not one still running', async () => {
      const dir = tempDir();
      try {
        const secrets = context(dir).secretsDir;
        mkdirSync(secrets, { recursive: true });
        const old = join(secrets, 'link-1-1.pending.db');
        const fresh = join(secrets, 'link-2-2.pending.db');
        writeFileSync(old, '');
        writeFileSync(fresh, '');
        const past = (Date.now() - PENDING_STALE_MS - 1000) / 1000;
        utimesSync(old, past, past);
        await new SignalBackend(context(dir)).listAccounts();
        expect(existsSync(old)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('Signal protocol store', async () => {
    await it('writes nothing until flushed, then everything in one write; discard drops it', async () => {
      const dir = tempDir();
      try {
        await link(dir);
        const { file, store } = openStore(dir);
        const alice = new Party(ALICE_ACI, 1, 5);
        try {
          await store.identities.saveIdentity(alice.address, alice.identity.identity.getPublicKey());
          await store.preKeys.removePreKey(Number(store.keys(NS.preKey)[0]));
          expect(store.writes).toBe(0);
          store.flush();
          expect(store.writes).toBe(1);
          await store.identities.saveIdentity(
            Signal.ProtocolAddress.new(CAROL_ACI, 1),
            alice.identity.identity.getPublicKey(),
          );
          store.discard();
        } finally {
          file.close();
        }
        const reopened = openStore(dir);
        try {
          expect(reopened.store.get(NS.identity, ALICE_ACI) !== null).toBe(true);
          expect(reopened.store.get(NS.identity, CAROL_ACI)).toBe(null);
          expect(reopened.store.count(NS.preKey)).toBe(99);
        } finally {
          reopened.file.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('Signal mapping', async () => {
    const mapper = new SignalMapper(OWN_ACI, groupIdOf);
    const ctx = { senderAci: ALICE_ACI, timestamp: 1000, groupId: null };

    await it("ignores sync messages from anyone but the user's own account", async () => {
      const sync = decodeContent(
        encodeContent({
          sent: { destinationServiceId: CAROL_ACI, timestamp: 5, message: { body: 'fake', timestamp: 5 } },
        }),
      );
      expect(mapper.map(sync, ctx).events.length).toBe(0);
      expect(mapper.map(sync, { ...ctx, senderAci: OWN_ACI }).events.length).toBe(2);
    });

    await it('drops reactions and housekeeping, keeps a file with its name', async () => {
      const reaction = decodeContent(encodeContent({ dataMessage: { reaction: true, timestamp: 1 } }));
      expect(mapper.map(reaction, ctx).events.length).toBe(0);
      const profileKeyUpdate = decodeContent(encodeContent({ dataMessage: { flags: 4, timestamp: 1 } }));
      expect(mapper.map(profileKeyUpdate, ctx).events.length).toBe(0);
      const file = mapper.map(
        decodeContent(encodeContent({ dataMessage: { attachments: [{ fileName: 'a.pdf' }], timestamp: 1 } })),
        ctx,
      ).events[0] as Extract<DeliveryEvent, { type: 'message' }>;
      expect(file.message.text).toBe('a.pdf');
      expect(file.message.hasAttachments).toBe(true);
    });

    await it('binds an edit and a delete to their author', async () => {
      const edit = mapper.map(
        decodeContent(
          encodeContent({
            editMessage: { targetSentTimestamp: 900, dataMessage: { body: 'neu', timestamp: 1000 } },
          }),
        ),
        ctx,
      ).events[0] as Extract<DeliveryEvent, { type: 'edit' }>;
      expect(edit.remoteId).toBe(`${ALICE_ACI}:900`);
      const del = mapper.map(
        decodeContent(encodeContent({ dataMessage: { deleteTarget: 900, timestamp: 1000 } })),
        ctx,
      ).events[0] as Extract<DeliveryEvent, { type: 'delete' }>;
      expect(del.remoteId).toBe(`${ALICE_ACI}:900`);
    });
  });

  await describe('Signal sync', async () => {
    await it('receives direct, sealed, group and own messages, edits, deletes and receipts into the index', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        const phone = await link(dir);
        const trust = new TrustRoot();
        const alice = new Party(ALICE_ACI, 1, 11);
        const carol = new Party(CAROL_ACI, 1, 12);
        await introduceAll(dir, alice, carol, phone.device);
        const group = new GroupSender(new Uint8Array(32).fill(5));
        const server = new FakeServer();
        server.push(
          await directEnvelope(alice, { dataMessage: { body: 'Hallo', timestamp: 1000 } }, 1000),
          await directEnvelope(alice, { dataMessage: { body: 'Wie geht es?', timestamp: 1001 } }, 1001),
          await sealedEnvelope(carol, trust, { dataMessage: { body: 'Versiegelt', timestamp: 1002 } }, 1002),
          await sealedEnvelope(
            alice,
            trust,
            { senderKeyDistribution: await group.distribution(alice) },
            1003,
          ),
          await group.envelope(
            alice,
            trust,
            { dataMessage: { body: 'An alle', timestamp: 1004, groupMasterKey: group.masterKey } },
            1004,
          ),
          await directEnvelope(
            phone.device,
            {
              sent: {
                destinationServiceId: ALICE_ACI,
                timestamp: 1005,
                message: { body: 'Gut, danke', timestamp: 1005 },
              },
            },
            1005,
          ),
          await sealedEnvelope(alice, trust, { receipt: { type: 1, timestamps: [1005] } }, 1006),
          await sealedEnvelope(
            alice,
            trust,
            {
              editMessage: {
                targetSentTimestamp: 1001,
                dataMessage: { body: 'Wie geht es dir?', timestamp: 1007 },
              },
            },
            1007,
          ),
          await sealedEnvelope(carol, trust, { dataMessage: { body: 'Ups', timestamp: 1008 } }, 1008),
          await sealedEnvelope(carol, trust, { dataMessage: { deleteTarget: 1008, timestamp: 1009 } }, 1009),
          // A stranger's "sync message" claiming the user sent something: ignored.
          await sealedEnvelope(
            carol,
            trust,
            {
              sent: {
                destinationServiceId: ALICE_ACI,
                timestamp: 1010,
                message: { body: 'gefälscht', timestamp: 1010 },
              },
            },
            1010,
          ),
        );
        const result = await receiveDeliveries(db, backendFor(dir, server, trust));
        expect(result.accounts[0].error).toBe(null);
        expect(result.accounts[0].caughtUp).toBe(true);
        expect(server.queue.length).toBe(0);
        expect(server.acked.length).toBe(11);
        expect(server.disconnects).toBe(1);

        rebuildConversations(db);
        expect(bodies(db, ALICE_ACI)).toBe('Hallo|Wie geht es dir?|Gut, danke');
        const direct = getConversation(db, chatConversationId('signal', ACCOUNT, ALICE_ACI), {
          includeBodies: true,
        });
        expect(direct?.messages[2].fromSelf).toBe(true);
        expect(direct?.messages[2].readByPeer).toBe(true);
        expect(direct?.messages[1].editedAt ? 'edited' : 'not').toBe('edited');
        expect(bodies(db, CAROL_ACI)).toBe('Versiegelt');
        const groupChat = `group:${btoa(String.fromCharCode(...groupIdOf(group.masterKey)))}`;
        expect(bodies(db, groupChat)).toBe('An alle');
        expect(listConversations(db).length).toBe(3);
        const journal = journalPath(sessionPath(context(dir).secretsDir, ACCOUNT));
        expect(readFileSync(journal, 'utf8')).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('applies deletions the user made on the phone', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        const phone = await link(dir);
        const trust = new TrustRoot();
        const alice = new Party(ALICE_ACI, 1, 11);
        await introduceAll(dir, alice, phone.device);
        const server = new FakeServer();
        server.push(
          await directEnvelope(alice, { dataMessage: { body: 'eins', timestamp: 2000 } }, 2000),
          await directEnvelope(alice, { dataMessage: { body: 'zwei', timestamp: 2001 } }, 2001),
        );
        await receiveDeliveries(db, backendFor(dir, server, trust));
        server.push(
          await directEnvelope(
            phone.device,
            {
              deleteForMe: {
                messages: [{ conversation: { serviceId: ALICE_ACI }, authorAci: ALICE_ACI, timestamp: 2000 }],
              },
            },
            2002,
          ),
        );
        await receiveDeliveries(db, backendFor(dir, server, trust));
        rebuildConversations(db);
        expect(bodies(db, ALICE_ACI)).toBe('zwei');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('a crash between receiving and acknowledging loses nothing and stores each message once', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const trust = new TrustRoot();
        const alice = new Party(ALICE_ACI, 1, 11);
        await introduceAll(dir, alice);
        const server = new FakeServer();
        server.push(
          await directEnvelope(alice, { dataMessage: { body: 'eins', timestamp: 3000 } }, 3000),
          await sealedEnvelope(alice, trust, { dataMessage: { body: 'zwei', timestamp: 3001 } }, 3001),
        );
        // Run 1 "crashes": the acknowledgements never reach the server, and the index write throws.
        server.dropAcks = true;
        const prepare = db.prepare.bind(db);
        let crash = true;
        (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
          if (crash && sql.includes('INSERT OR REPLACE INTO conversation_messages'))
            throw new Error('simulated crash');
          return prepare(sql);
        }) as typeof db.prepare;
        const first = await receiveDeliveries(db, backendFor(dir, server, trust));
        expect(first.accounts[0].error ?? '').toMatch(/simulated crash/);
        expect(listConversations(db).length).toBe(0);
        const journal = journalPath(sessionPath(context(dir).secretsDir, ACCOUNT));
        expect(readFileSync(journal, 'utf8').includes('zwei')).toBe(true);
        expect(server.queue.length).toBe(2);

        // Run 2: the journal replays; the server redelivers both — already decrypted, so duplicates.
        crash = false;
        server.dropAcks = false;
        const second = await receiveDeliveries(db, backendFor(dir, server, trust));
        expect(second.accounts[0].error).toBe(null);
        expect(server.queue.length).toBe(0);
        rebuildConversations(db);
        expect(bodies(db, ALICE_ACI)).toBe('eins|zwei');
        expect(readFileSync(journal, 'utf8')).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('acknowledges nothing when the session file cannot be written, and the next run reads it all', async () => {
      const dir = tempDir();
      try {
        await link(dir);
        const trust = new TrustRoot();
        const alice = new Party(ALICE_ACI, 1, 11);
        await introduceAll(dir, alice);
        const server = new FakeServer();
        server.push(await directEnvelope(alice, { dataMessage: { body: 'eins', timestamp: 4000 } }, 4000));
        const { file, store } = openStore(dir);
        const journal = FileJournal.open(journalPath(sessionPath(context(dir).secretsDir, ACCOUNT)));
        const receiver = new SignalReceiver(
          server.connector(),
          new EnvelopeDecryptor(LIB, store, { trustRoots: trust.publicKeys }),
          new SignalMapper(OWN_ACI, groupIdOf),
          {
            flush: () => {
              throw new Error('disk full');
            },
          },
          { mode: 'catch-up', journal, maxMs: 5000 },
        );
        await receiver.start();
        while ((await receiver.nextBatch()) !== null) {
          // Nothing is handed out: the commit failed before anything was queued.
        }
        expect(receiver.outcome().error ?? '').toMatch(/nothing was acknowledged/);
        await receiver.close();
        store.discard();
        file.close();
        expect(server.acked.length).toBe(0);
        expect(server.queue.length).toBe(1);

        const db = freshDb();
        const again = await receiveDeliveries(db, backendFor(dir, server, trust));
        expect(again.accounts[0].error).toBe(null);
        rebuildConversations(db);
        expect(bodies(db, ALICE_ACI)).toBe('eins');
        expect(server.queue.length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('acknowledges and reports what cannot be decrypted, and keeps going', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const trust = new TrustRoot();
        const alice = new Party(ALICE_ACI, 1, 11);
        await introduceAll(dir, alice);
        const server = new FakeServer();
        const stranger = new TrustRoot();
        server.push(
          encodeEnvelope({
            type: EnvelopeType.DOUBLE_RATCHET,
            sourceServiceId: ALICE_ACI,
            sourceDevice: 1,
            content: new Uint8Array([3, 1, 2]),
          }),
          // A sender certificate from a root that is not the trusted one: refused.
          await sealedEnvelope(
            alice,
            stranger,
            { dataMessage: { body: 'untrusted', timestamp: 5000 } },
            5000,
          ),
          await directEnvelope(alice, { dataMessage: { body: 'ok', timestamp: 5001 } }, 5001),
        );
        const result = await receiveDeliveries(db, backendFor(dir, server, trust));
        expect(result.accounts[0].error ?? '').toMatch(/2 envelope\(s\) could not be decrypted/);
        expect(server.queue.length).toBe(0);
        rebuildConversations(db);
        expect(bodies(db, ALICE_ACI)).toBe('ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('stops at the time cap when the queue never reports empty, and says it is not caught up', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const trust = new TrustRoot();
        const alice = new Party(ALICE_ACI, 1, 11);
        await introduceAll(dir, alice);
        const server = new FakeServer();
        server.sendQueueEmpty = false;
        server.push(await directEnvelope(alice, { dataMessage: { body: 'eins', timestamp: 6000 } }, 6000));
        const result = await receiveDeliveries(
          db,
          backendFor(dir, server, trust, { receiver: { maxMs: 200 } }),
        );
        expect(result.accounts[0].caughtUp).toBe(false);
        expect(result.accounts[0].error).toBe(null);
        expect(result.accounts[0].added).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('reports an unlinked device with the way back', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const server = new FakeServer();
        server.connectError = new Error('device delinked');
        const result = await receiveDeliveries(
          db,
          backendFor(dir, server, new TrustRoot(), {
            receiver: { maxMs: 1000, isDelinked: (e) => String(e).includes('delinked') },
          }),
        );
        expect(result.accounts[0].error ?? '').toMatch(/unlinked/);
        expect((result.accounts[0].error ?? '').includes(RELINK_HINT)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a session file that was never linked, and a missing one', async () => {
      const dir = tempDir();
      try {
        const backend = new SignalBackend(context(dir), { lib: LIB });
        expect(await rejection(() => backend.connect(ACCOUNT, { mode: 'catch-up' }))).toMatch(
          /no Signal session/,
        );
        mkdirSync(context(dir).secretsDir, { recursive: true });
        SecretStore.open(sessionPath(context(dir).secretsDir, ACCOUNT)).close();
        expect(await rejection(() => backend.connect(ACCOUNT, { mode: 'catch-up' }))).toMatch(/never linked/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('Signal link URL', async () => {
    await it('carries the address, the padded base64 key and the capabilities', async () => {
      const publicKey = new Uint8Array(33).fill(7);
      publicKey[0] = 5;
      const url = new URL(linkDeviceUrl({ address: 'abc+/def==', publicKey }));
      expect(url.protocol).toBe('sgnl:');
      expect(url.searchParams.get('uuid')).toBe('abc+/def==');
      expect(url.searchParams.get('pub_key')).toBe(btoa(String.fromCharCode(...publicKey)));
      expect(url.searchParams.get('capabilities')).toBe('nopni');
    });
  });
};
