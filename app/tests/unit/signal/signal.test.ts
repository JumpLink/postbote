import { describe, expect, it } from '@gjsify/unit';

import { validateManifest } from '@postbote/protocol';
import { linkDeviceUrl, SIGNAL_MANIFEST } from '@postbote/signal';
import * as Signal from '@signalapp/libsignal-client';

import { Party } from './stores.ts';

/**
 * The Signal skeleton: its manifest, the link URL, and the proof the whole backend stands on —
 * @signalapp/libsignal-client's prebuilt N-API addon loads and runs on GJS (through
 * @gjsify/napi) exactly as on Node, async store callbacks included. Synthetic keys only.
 *
 * The Node run needs `POSTBOTE_CLI_PREBUILD` (set by the app's `test` script): gjsify's
 * `--app node` target bundles libsignal, whose `node-gyp-build` call then searches the bundle's
 * directory for the addon. node-gyp-build honours `<PACKAGE_NAME>_PREBUILD` for that directory.
 * Remove it once gjsify keeps native-addon packages external on the node target.
 */

const ALICE = '9d0652a3-dcc3-4d11-975f-74d61598733f';
const BOB = '796abedb-ca4e-4f18-8803-1fde5b921f9f';

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export default async () => {
  await describe('Signal manifest', async () => {
    await it('is a valid delivery-only, native manifest with a terms notice', async () => {
      expect(validateManifest(SIGNAL_MANIFEST).length).toBe(0);
      expect(SIGNAL_MANIFEST.syncModel).toBe('delivery-only');
      expect(SIGNAL_MANIFEST.native).toBe(true);
      expect(SIGNAL_MANIFEST.addressKinds.join(',')).toBe('signal,phone');
      expect(SIGNAL_MANIFEST.terms?.summary.includes('not an official Signal client')).toBe(true);
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

    await it('refuses a key that is not a serialized public key', async () => {
      let message = '';
      try {
        linkDeviceUrl({ address: 'x', publicKey: new Uint8Array(32) });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.includes('expected 33')).toBe(true);
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
      const alice = new Party(ALICE, 1, 1);
      const bob = new Party(BOB, 3, 2);
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
      // The one-time pre-key is consumed, as the protocol requires.
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

    await it('opens a sealed-sender message and names the sender', async () => {
      const alice = new Party(ALICE, 1, 1);
      const bob = new Party(BOB, 3, 2);
      await Signal.processPreKeyBundle(
        await bob.bundle(),
        bob.address,
        alice.address,
        alice.sessions,
        alice.identity,
      );
      const trustRoot = Signal.PrivateKey.generate();
      const server = Signal.PrivateKey.generate();
      const serverCert = Signal.ServerCertificate.new(1, server.getPublicKey(), trustRoot);
      const senderCert = Signal.SenderCertificate.new(
        ALICE,
        null,
        1,
        alice.identity.identity.getPublicKey(),
        Date.now() + 86_400_000,
        serverCert,
        server,
      );
      const sealed = await Signal.sealedSenderEncryptMessage(
        encode('sealed hello'),
        bob.address,
        senderCert,
        alice.sessions,
        alice.identity,
      );
      const opened = await Signal.sealedSenderDecryptMessage(
        sealed,
        trustRoot.getPublicKey(),
        Date.now(),
        null,
        BOB,
        3,
        bob.sessions,
        bob.identity,
        bob.preKeys,
        bob.signedPreKeys,
        bob.kyberPreKeys,
      );
      expect(decode(opened.message())).toBe('sealed hello');
      expect(opened.senderUuid()).toBe(ALICE);
      expect(opened.deviceId()).toBe(1);
    });
  });
};
