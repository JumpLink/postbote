/**
 * The symmetric cryptography around the Signal protocol that libsignal does not do itself:
 * decrypting the provisioning message, encrypting the device name, decrypting an attachment.
 *
 * Ported from Signal-Desktop `ts/textsecure/ProvisioningCipher.node.ts` and `ts/Crypto.node.ts`
 * (Copyright 2020-2026 Signal Messenger, LLC, AGPL-3.0-only). HKDF and the curve agreement come
 * from libsignal; AES and HMAC from `node:crypto`.
 */

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type * as Core from '@signalapp/libsignal-client';
import type { SignalLib } from './lib.ts';
import { decodeProvisionMessage, type ProvisionEnvelope, type ProvisionMessage } from './schema.ts';

const te = new TextEncoder();

function toBytes(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array<ArrayBuffer> {
  return toBytes(createHmac('sha256', key).update(data).digest());
}

export function sha256(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return toBytes(createHash('sha256').update(data).digest());
}

export function random(length: number): Uint8Array<ArrayBuffer> {
  return toBytes(randomBytes(length));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function aesCbc(
  mode: 'encrypt' | 'decrypt',
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const cipher =
    mode === 'encrypt' ? createCipheriv('aes-256-cbc', key, iv) : createDecipheriv('aes-256-cbc', key, iv);
  return toBytes(Buffer.concat([cipher.update(data), cipher.final()]));
}

function aesCtr(key: Uint8Array, counter: Uint8Array, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const cipher = createCipheriv('aes-256-ctr', key, counter);
  return toBytes(Buffer.concat([cipher.update(data), cipher.final()]));
}

/** HKDF-SHA256 into three 32-byte keys (Desktop's `deriveSecrets`). */
function deriveSecrets(lib: SignalLib, input: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array[] {
  const out = lib.core.hkdf(
    96,
    input as Uint8Array<ArrayBuffer>,
    info as Uint8Array<ArrayBuffer>,
    salt as Uint8Array<ArrayBuffer>,
  );
  return [out.subarray(0, 32), out.subarray(32, 64), out.subarray(64, 96)];
}

const PROVISIONING_INFO = te.encode('TextSecure Provisioning Message');

/**
 * Open the envelope the primary phone sent through the provisioning socket. `privateKey` is the
 * provisioning key whose public half was in the link URL.
 */
export function decryptProvisionEnvelope(
  lib: SignalLib,
  envelope: ProvisionEnvelope,
  privateKey: Core.PrivateKey,
): ProvisionMessage {
  if (!envelope.publicKey || !envelope.body) throw new Error('the provisioning envelope is incomplete');
  const message = envelope.body;
  if (message[0] !== 1) throw new Error('unknown provisioning message version');
  const iv = message.subarray(1, 17);
  const mac = message.subarray(message.length - 32);
  const ivAndCiphertext = message.subarray(0, message.length - 32);
  const ciphertext = message.subarray(17, message.length - 32);
  const shared = privateKey.agree(
    lib.core.PublicKey.deserialize(envelope.publicKey as Uint8Array<ArrayBuffer>),
  );
  const [cipherKey, macKey] = deriveSecrets(lib, shared, new Uint8Array(32), PROVISIONING_INFO);
  if (!constantTimeEqual(hmacSha256(macKey, ivAndCiphertext), mac)) {
    throw new Error('the provisioning message failed its integrity check');
  }
  return decodeProvisionMessage(aesCbc('decrypt', cipherKey, iv, ciphertext));
}

/** The primary's side of `decryptProvisionEnvelope` — for tests, which play the phone. */
export function encryptProvisionBody(
  lib: SignalLib,
  plaintext: Uint8Array,
  theirPublicKey: Uint8Array,
): { publicKey: Uint8Array<ArrayBuffer>; body: Uint8Array<ArrayBuffer> } {
  const ephemeral = lib.core.PrivateKey.generate();
  const shared = ephemeral.agree(lib.core.PublicKey.deserialize(theirPublicKey as Uint8Array<ArrayBuffer>));
  const [cipherKey, macKey] = deriveSecrets(lib, shared, new Uint8Array(32), PROVISIONING_INFO);
  const iv = random(16);
  const ciphertext = aesCbc('encrypt', cipherKey, iv, plaintext);
  const versioned = new Uint8Array(1 + 16 + ciphertext.length);
  versioned[0] = 1;
  versioned.set(iv, 1);
  versioned.set(ciphertext, 17);
  const body = new Uint8Array(versioned.length + 32);
  body.set(versioned);
  body.set(hmacSha256(macKey, versioned), versioned.length);
  return { publicKey: ephemeral.getPublicKey().serialize(), body };
}

/**
 * The device name as the server stores it: encrypted to the account's identity key, so only the
 * user's own devices can read it (Desktop's `encryptDeviceName`).
 */
export function encryptDeviceName(
  lib: SignalLib,
  name: string,
  identityPublic: Core.PublicKey,
): { ephemeralPublic: Uint8Array; syntheticIv: Uint8Array; ciphertext: Uint8Array } {
  const plaintext = te.encode(name);
  const ephemeral = lib.core.PrivateKey.generate();
  const master = ephemeral.agree(identityPublic);
  const key1 = hmacSha256(master, te.encode('auth'));
  const syntheticIv = hmacSha256(key1, plaintext).subarray(0, 16);
  const key2 = hmacSha256(master, te.encode('cipher'));
  const cipherKey = hmacSha256(key2, syntheticIv);
  return {
    ephemeralPublic: ephemeral.getPublicKey().serialize(),
    syntheticIv,
    ciphertext: aesCtr(cipherKey, new Uint8Array(16), plaintext),
  };
}

/** The inverse, for tests (Desktop's `decryptDeviceName`). */
export function decryptDeviceName(
  lib: SignalLib,
  encrypted: { ephemeralPublic: Uint8Array; syntheticIv: Uint8Array; ciphertext: Uint8Array },
  identityPrivate: Core.PrivateKey,
): string {
  const master = identityPrivate.agree(
    lib.core.PublicKey.deserialize(encrypted.ephemeralPublic as Uint8Array<ArrayBuffer>),
  );
  const key2 = hmacSha256(master, te.encode('cipher'));
  const cipherKey = hmacSha256(key2, encrypted.syntheticIv);
  const plaintext = aesCtr(cipherKey, new Uint8Array(16), encrypted.ciphertext);
  const key1 = hmacSha256(master, te.encode('auth'));
  if (!constantTimeEqual(hmacSha256(key1, plaintext).subarray(0, 16), encrypted.syntheticIv)) {
    throw new Error('device name: synthetic IV mismatch');
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * Decrypt a downloaded attachment: `iv(16) | AES-256-CBC ciphertext | HMAC-SHA256(32)` under a
 * 64-byte key (32 AES, 32 MAC). The digest, when the pointer carries one, is SHA-256 over the whole
 * download. `size` cuts the zero padding senders add (Desktop's `decryptAttachmentV2`).
 */
export function decryptAttachment(
  data: Uint8Array,
  key: Uint8Array,
  options: { size?: number | null; digest?: Uint8Array | null } = {},
): Uint8Array {
  if (key.length !== 64) throw new Error('an attachment key has 64 bytes');
  if (data.length < 16 + 16 + 32) throw new Error('the attachment is too short');
  if (options.digest && options.digest.length > 0 && !constantTimeEqual(sha256(data), options.digest)) {
    throw new Error('the attachment digest does not match');
  }
  const macKey = key.subarray(32);
  const body = data.subarray(0, data.length - 32);
  if (!constantTimeEqual(hmacSha256(macKey, body), data.subarray(data.length - 32))) {
    throw new Error('the attachment failed its integrity check');
  }
  const plaintext = aesCbc(
    'decrypt',
    key.subarray(0, 32),
    data.subarray(0, 16),
    data.subarray(16, data.length - 32),
  );
  return options.size !== null && options.size !== undefined
    ? plaintext.subarray(0, options.size)
    : plaintext;
}

/** The sender's side of `decryptAttachment`, for tests. */
export function encryptAttachment(
  plaintext: Uint8Array,
  key: Uint8Array,
): { data: Uint8Array; digest: Uint8Array } {
  const iv = random(16);
  const ciphertext = aesCbc('encrypt', key.subarray(0, 32), iv, plaintext);
  const body = new Uint8Array(16 + ciphertext.length);
  body.set(iv);
  body.set(ciphertext, 16);
  const data = new Uint8Array(body.length + 32);
  data.set(body);
  data.set(hmacSha256(key.subarray(32), body), body.length);
  return { data, digest: sha256(data) };
}
