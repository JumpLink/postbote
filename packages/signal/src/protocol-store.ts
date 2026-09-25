/**
 * libsignal's protocol stores on postbote's `SecretStore`: the session file of one Signal account.
 *
 * What it holds is everything this linked device is — the account's identity key pair, the
 * device's password and registration id, its signed, Kyber and one-time pre-keys, a session per
 * contact device, the identity key seen for each contact, and a sender key per group sender.
 * Whoever holds the file can read the account's incoming messages: it is SECRET (0600 in a 0700
 * directory, never logged, never in a DTO or MCP output).
 *
 * Writes are EXPLICIT and batched: every change lands in memory and marks its key dirty; `flush()`
 * writes all dirty keys in ONE `SecretStore.apply`. There is no timer. The receiver flushes at its
 * commit points — after the journal holds the decrypted messages and before it acknowledges the
 * envelopes — so an acknowledged message never leaves a ratchet step only in memory. That order
 * matters more here than for WhatsApp: postbote sends no retry requests, so a lost ratchet step
 * would leave a contact's later messages undecryptable. (One apply per commit also keeps within
 * the per-process execution budget: gjsify gap, unfixed, gjsify#1838.)
 *
 * The stores implement libsignal's abstract store classes structurally (libsignal bridges them by
 * shape, not by class), so this module needs libsignal only at run time, through `SignalLib`.
 */

import type { SecretChange, SecretStore } from '@postbote/store';
import type * as Core from '@signalapp/libsignal-client';
import type { SignalLib } from './lib.ts';

export const NS = {
  account: 'signal.account',
  session: 'signal.session',
  identity: 'signal.identity',
  preKey: 'signal.prekey',
  signedPreKey: 'signal.signedprekey',
  kyberPreKey: 'signal.kyberprekey',
  kyberUsed: 'signal.kyberused',
  senderKey: 'signal.senderkey',
} as const;

/** postbote's own namespace in the same file: which account this is, for `accounts list`. */
export const ACCOUNT_NAMESPACE = 'postbote.account';

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The linked device's own credentials — what `linkDevice` created. */
export interface DeviceAccount {
  aci: string;
  deviceId: number;
  password: string;
  registrationId: number;
}

type Address = Core.ProtocolAddress;

const addressKey = (a: Address): string => `${a.name()}.${a.deviceId()}`;

export class SignalProtocolStore {
  private readonly lib: SignalLib;
  private readonly store: SecretStore;
  private readonly data = new Map<string, Map<string, string>>();
  private readonly dirty = new Map<string, Set<string>>();
  /** How many times the file was written — a test measures the batching with it. */
  writes = 0;

  private constructor(lib: SignalLib, store: SecretStore) {
    this.lib = lib;
    this.store = store;
  }

  /** Load the whole file (one execution). */
  static open(lib: SignalLib, store: SecretStore): SignalProtocolStore {
    const s = new SignalProtocolStore(lib, store);
    for (const [namespace, entries] of store.loadAll()) s.data.set(namespace, new Map(entries));
    return s;
  }

  // ── raw access ──

  get(namespace: string, key: string): string | null {
    return this.data.get(namespace)?.get(key) ?? null;
  }

  set(namespace: string, key: string, value: string | null): void {
    let map = this.data.get(namespace);
    if (!map) {
      map = new Map();
      this.data.set(namespace, map);
    }
    if (value === null) map.delete(key);
    else map.set(key, value);
    let keys = this.dirty.get(namespace);
    if (!keys) {
      keys = new Set();
      this.dirty.set(namespace, keys);
    }
    keys.add(key);
  }

  /** Every key of a namespace (ids of stored pre-keys, addresses of sessions). */
  keys(namespace: string): string[] {
    return [...(this.data.get(namespace)?.keys() ?? [])];
  }

  count(namespace: string): number {
    return this.data.get(namespace)?.size ?? 0;
  }

  get pending(): number {
    let n = 0;
    for (const keys of this.dirty.values()) n += keys.size;
    return n;
  }

  /** Write every change since the last flush in one transaction. */
  flush(): void {
    if (this.dirty.size === 0) return;
    const changes: SecretChange[] = [];
    for (const [namespace, keys] of this.dirty) {
      for (const key of keys) changes.push({ namespace, key, value: this.get(namespace, key) });
    }
    this.store.apply(changes);
    this.dirty.clear();
    this.writes++;
  }

  /** Drop unwritten changes (a link that failed before the phone confirmed it). */
  discard(): void {
    this.dirty.clear();
  }

  // ── the device ──

  get registered(): boolean {
    return this.account() !== null;
  }

  account(): DeviceAccount | null {
    const aci = this.get(NS.account, 'aci');
    const deviceId = this.get(NS.account, 'deviceId');
    const password = this.get(NS.account, 'password');
    const registrationId = this.get(NS.account, 'registrationId');
    if (!aci || !deviceId || !password || !registrationId) return null;
    return { aci, deviceId: Number(deviceId), password, registrationId: Number(registrationId) };
  }

  setAccount(account: DeviceAccount): void {
    this.set(NS.account, 'aci', account.aci);
    this.set(NS.account, 'deviceId', String(account.deviceId));
    this.set(NS.account, 'password', account.password);
    this.set(NS.account, 'registrationId', String(account.registrationId));
  }

  setIdentityKey(privateKey: Core.PrivateKey): void {
    this.set(NS.account, 'identityPrivate', toBase64(privateKey.serialize()));
  }

  identityKey(): Core.PrivateKey {
    const stored = this.get(NS.account, 'identityPrivate');
    if (!stored) throw new Error('the Signal session has no identity key');
    return this.lib.core.PrivateKey.deserialize(fromBase64(stored));
  }

  setRegistrationId(id: number): void {
    this.set(NS.account, 'registrationId', String(id));
  }

  // ── libsignal's stores ──

  readonly sessions = {
    saveSession: async (address: Address, record: Core.SessionRecord): Promise<void> => {
      this.set(NS.session, addressKey(address), toBase64(record.serialize()));
    },
    getSession: async (address: Address): Promise<Core.SessionRecord | null> => {
      const stored = this.get(NS.session, addressKey(address));
      return stored ? this.lib.core.SessionRecord.deserialize(fromBase64(stored)) : null;
    },
    getExistingSessions: async (addresses: Address[]): Promise<Core.SessionRecord[]> =>
      addresses.map((address) => {
        const stored = this.get(NS.session, addressKey(address));
        if (!stored) throw new Error(`no session for ${addressKey(address)}`);
        return this.lib.core.SessionRecord.deserialize(fromBase64(stored));
      }),
  } as unknown as Core.SessionStore;

  readonly identities = {
    getIdentityKey: async (): Promise<Core.PrivateKey> => this.identityKey(),
    getIdentityKeyPair: async (): Promise<Core.IdentityKeyPair> => {
      const key = this.identityKey();
      return new this.lib.core.IdentityKeyPair(key.getPublicKey(), key);
    },
    getLocalRegistrationId: async (): Promise<number> => {
      const id = this.get(NS.account, 'registrationId');
      if (!id) throw new Error('the Signal session has no registration id');
      return Number(id);
    },
    // Read-only client: every identity is accepted and recorded. postbote never sends, so there is
    // no message a changed key could leak; what a key change means is the phone's to show.
    isTrustedIdentity: async (): Promise<boolean> => true,
    saveIdentity: async (address: Address, key: Core.PublicKey): Promise<Core.IdentityChange> => {
      const previous = this.get(NS.identity, address.name());
      const next = toBase64(key.serialize());
      this.set(NS.identity, address.name(), next);
      return previous && previous !== next
        ? this.lib.core.IdentityChange.ReplacedExisting
        : this.lib.core.IdentityChange.NewOrUnchanged;
    },
    getIdentity: async (address: Address): Promise<Core.PublicKey | null> => {
      const stored = this.get(NS.identity, address.name());
      return stored ? this.lib.core.PublicKey.deserialize(fromBase64(stored)) : null;
    },
  } as unknown as Core.IdentityKeyStore;

  readonly preKeys = {
    savePreKey: async (id: number, record: Core.PreKeyRecord): Promise<void> => {
      this.set(NS.preKey, String(id), toBase64(record.serialize()));
    },
    getPreKey: async (id: number): Promise<Core.PreKeyRecord> => {
      const stored = this.get(NS.preKey, String(id));
      if (!stored) throw new Error(`pre-key ${id} not found`);
      return this.lib.core.PreKeyRecord.deserialize(fromBase64(stored));
    },
    removePreKey: async (id: number): Promise<void> => {
      this.set(NS.preKey, String(id), null);
    },
  } as unknown as Core.PreKeyStore;

  readonly signedPreKeys = {
    saveSignedPreKey: async (id: number, record: Core.SignedPreKeyRecord): Promise<void> => {
      this.set(NS.signedPreKey, String(id), toBase64(record.serialize()));
    },
    getSignedPreKey: async (id: number): Promise<Core.SignedPreKeyRecord> => {
      const stored = this.get(NS.signedPreKey, String(id));
      if (!stored) throw new Error(`signed pre-key ${id} not found`);
      return this.lib.core.SignedPreKeyRecord.deserialize(fromBase64(stored));
    },
  } as unknown as Core.SignedPreKeyStore;

  /** Save a Kyber pre-key; a last-resort key is kept after use, a one-time key is not. */
  saveKyberPreKey(id: number, record: Core.KyberPreKeyRecord, lastResort: boolean): void {
    this.set(
      NS.kyberPreKey,
      String(id),
      JSON.stringify({ record: toBase64(record.serialize()), lastResort }),
    );
  }

  readonly kyberPreKeys = {
    saveKyberPreKey: async (id: number, record: Core.KyberPreKeyRecord): Promise<void> => {
      this.saveKyberPreKey(id, record, false);
    },
    getKyberPreKey: async (id: number): Promise<Core.KyberPreKeyRecord> => {
      const stored = this.get(NS.kyberPreKey, String(id));
      if (!stored) throw new Error(`kyber pre-key ${id} not found`);
      return this.lib.core.KyberPreKeyRecord.deserialize(
        fromBase64((JSON.parse(stored) as { record: string }).record),
      );
    },
    markKyberPreKeyUsed: async (
      id: number,
      signedPreKeyId: number,
      baseKey: Core.PublicKey,
    ): Promise<void> => {
      const stored = this.get(NS.kyberPreKey, String(id));
      if (!stored) throw new Error(`kyber pre-key ${id} not found`);
      if (!(JSON.parse(stored) as { lastResort: boolean }).lastResort) {
        this.set(NS.kyberPreKey, String(id), null);
        return;
      }
      // A last-resort key stays; the same (key, signed key, base key) twice is a replay.
      const seen = `${id}:${signedPreKeyId}:${toBase64(baseKey.serialize())}`;
      if (this.get(NS.kyberUsed, seen)) throw new Error('kyber pre-key reused with the same base key');
      this.set(NS.kyberUsed, seen, '1');
    },
  } as unknown as Core.KyberPreKeyStore;

  readonly senderKeys = {
    saveSenderKey: async (
      sender: Address,
      distributionId: string,
      record: Core.SenderKeyRecord,
    ): Promise<void> => {
      this.set(NS.senderKey, `${addressKey(sender)}::${distributionId}`, toBase64(record.serialize()));
    },
    getSenderKey: async (sender: Address, distributionId: string): Promise<Core.SenderKeyRecord | null> => {
      const stored = this.get(NS.senderKey, `${addressKey(sender)}::${distributionId}`);
      return stored ? this.lib.core.SenderKeyRecord.deserialize(fromBase64(stored)) : null;
    },
  } as unknown as Core.SenderKeyStore;
}
