/**
 * The keys a new linked device publishes, and the JSON the server takes them in.
 *
 * Ported from Signal-Desktop `ts/textsecure/AccountManager.preload.ts` (`#generateSignedPreKey`,
 * `#generateLastResortKyberKey`, the one-time pre-key batches) and `ts/textsecure/WebAPI.preload.ts`
 * (`serializeSignedPreKey`, `registerKeys`) — Copyright 2020-2026 Signal Messenger, LLC,
 * AGPL-3.0-only.
 *
 * A device needs, per identity: a signed EC pre-key and a signed last-resort Kyber pre-key (sent
 * with the link request), and batches of one-time EC and Kyber pre-keys (sent right after). A
 * sender uses one of each to start a session; when the one-time keys run out, the last-resort
 * Kyber key and no EC one-time key still work. postbote uploads one batch at link time and does
 * not top it up — refilling is a write it keeps to the minimum (see `guard.ts`).
 */

import { random } from './crypto.ts';
import type { SignalLib } from './lib.ts';
import { type SignalProtocolStore, toBase64 } from './protocol-store.ts';

/** Desktop's batch size for one-time keys. */
export const ONE_TIME_BATCH = 100;

export interface SignedKeyJson {
  keyId: number;
  publicKey: string;
  signature: string;
}

export interface PreKeyJson {
  keyId: number;
  publicKey: string;
}

/** A 14-bit registration id, never 0 (Desktop's `generateRegistrationId`). */
export function generateRegistrationId(): number {
  const bytes = random(2);
  return ((bytes[0] << 8) | bytes[1]) & 0x3fff || 1;
}

/** A device password: 16 random bytes in base64 without its padding (Desktop's shape). */
export function generatePassword(): string {
  return toBase64(random(16)).replace(/=+$/, '');
}

/** A key id: 24 bits, random, so ids do not collide across re-links. */
function keyIdStart(): number {
  const b = random(3);
  return ((b[0] << 16) | (b[1] << 8) | b[2]) % 0xffff00 || 1;
}

export interface LinkKeys {
  signedPreKey: SignedKeyJson;
  pqLastResortPreKey: SignedKeyJson;
}

/** Generate and store the signed pre-key and the last-resort Kyber key; return their JSON. */
export function generateLinkKeys(lib: SignalLib, store: SignalProtocolStore): LinkKeys {
  const identity = store.identityKey();
  const now = Date.now();

  const signedId = keyIdStart();
  const signedKey = lib.core.PrivateKey.generate();
  const signedSig = identity.sign(signedKey.getPublicKey().serialize());
  store.set(
    'signal.signedprekey',
    String(signedId),
    toBase64(
      lib.core.SignedPreKeyRecord.new(
        signedId,
        now,
        signedKey.getPublicKey(),
        signedKey,
        signedSig,
      ).serialize(),
    ),
  );

  const kyberId = keyIdStart();
  const kyber = lib.core.KEMKeyPair.generate();
  const kyberSig = identity.sign(kyber.getPublicKey().serialize());
  store.saveKyberPreKey(kyberId, lib.core.KyberPreKeyRecord.new(kyberId, now, kyber, kyberSig), true);

  return {
    signedPreKey: {
      keyId: signedId,
      publicKey: toBase64(signedKey.getPublicKey().serialize()),
      signature: toBase64(signedSig),
    },
    pqLastResortPreKey: {
      keyId: kyberId,
      publicKey: toBase64(kyber.getPublicKey().serialize()),
      signature: toBase64(kyberSig),
    },
  };
}

export interface OneTimeKeys {
  preKeys: PreKeyJson[];
  pqPreKeys: SignedKeyJson[];
}

/** Generate and store a batch of one-time EC and Kyber pre-keys; return the upload body. */
export function generateOneTimeKeys(
  lib: SignalLib,
  store: SignalProtocolStore,
  count = ONE_TIME_BATCH,
): OneTimeKeys {
  const identity = store.identityKey();
  const now = Date.now();
  const preKeys: PreKeyJson[] = [];
  const pqPreKeys: SignedKeyJson[] = [];
  const ecStart = keyIdStart();
  const pqStart = keyIdStart();
  for (let i = 0; i < count; i++) {
    const ecId = (ecStart + i) % 0xffffff || 1;
    const ec = lib.core.PrivateKey.generate();
    store.set(
      'signal.prekey',
      String(ecId),
      toBase64(lib.core.PreKeyRecord.new(ecId, ec.getPublicKey(), ec).serialize()),
    );
    preKeys.push({ keyId: ecId, publicKey: toBase64(ec.getPublicKey().serialize()) });

    const pqId = (pqStart + i) % 0xffffff || 1;
    const kem = lib.core.KEMKeyPair.generate();
    const sig = identity.sign(kem.getPublicKey().serialize());
    store.saveKyberPreKey(pqId, lib.core.KyberPreKeyRecord.new(pqId, now, kem, sig), false);
    pqPreKeys.push({
      keyId: pqId,
      publicKey: toBase64(kem.getPublicKey().serialize()),
      signature: toBase64(sig),
    });
  }
  return { preKeys, pqPreKeys };
}
