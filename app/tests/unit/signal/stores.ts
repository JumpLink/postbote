/**
 * In-memory libsignal protocol stores for the tests — modelled on libsignal's own
 * `node/ts/test/protocol/TestStores.ts` (AGPL-3.0-only, Signal Messenger, LLC). Synthetic only.
 */

import * as Signal from '@signalapp/libsignal-client';

const key = (address: Signal.ProtocolAddress): string => `${address.name()}::${address.deviceId()}`;

export class MemorySessionStore extends Signal.SessionStore {
  readonly records = new Map<string, Uint8Array<ArrayBuffer>>();
  async saveSession(address: Signal.ProtocolAddress, record: Signal.SessionRecord): Promise<void> {
    this.records.set(key(address), record.serialize());
  }
  async getSession(address: Signal.ProtocolAddress): Promise<Signal.SessionRecord | null> {
    const bytes = this.records.get(key(address));
    return bytes ? Signal.SessionRecord.deserialize(bytes) : null;
  }
  async getExistingSessions(addresses: Signal.ProtocolAddress[]): Promise<Signal.SessionRecord[]> {
    return addresses.map((address) => {
      const bytes = this.records.get(key(address));
      if (!bytes) throw new Error(`no session for ${key(address)}`);
      return Signal.SessionRecord.deserialize(bytes);
    });
  }
}

export class MemoryIdentityStore extends Signal.IdentityKeyStore {
  readonly identity: Signal.PrivateKey;
  readonly registrationId: number;
  readonly known = new Map<string, Signal.PublicKey>();
  constructor(registrationId: number, identity?: Signal.PrivateKey) {
    super();
    this.registrationId = registrationId;
    this.identity = identity ?? Signal.PrivateKey.generate();
  }
  async getIdentityKey(): Promise<Signal.PrivateKey> {
    return this.identity;
  }
  async getLocalRegistrationId(): Promise<number> {
    return this.registrationId;
  }
  async isTrustedIdentity(address: Signal.ProtocolAddress, identity: Signal.PublicKey): Promise<boolean> {
    return this.known.get(key(address))?.equals(identity) ?? true;
  }
  async saveIdentity(
    address: Signal.ProtocolAddress,
    identity: Signal.PublicKey,
  ): Promise<Signal.IdentityChange> {
    const previous = this.known.get(key(address));
    this.known.set(key(address), identity);
    return previous && !previous.equals(identity)
      ? Signal.IdentityChange.ReplacedExisting
      : Signal.IdentityChange.NewOrUnchanged;
  }
  async getIdentity(address: Signal.ProtocolAddress): Promise<Signal.PublicKey | null> {
    return this.known.get(key(address)) ?? null;
  }
}

export class MemoryPreKeyStore extends Signal.PreKeyStore {
  readonly records = new Map<number, Signal.PreKeyRecord>();
  async savePreKey(id: number, record: Signal.PreKeyRecord): Promise<void> {
    this.records.set(id, record);
  }
  async getPreKey(id: number): Promise<Signal.PreKeyRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`pre-key ${id} not found`);
    return record;
  }
  async removePreKey(id: number): Promise<void> {
    this.records.delete(id);
  }
}

export class MemorySignedPreKeyStore extends Signal.SignedPreKeyStore {
  readonly records = new Map<number, Signal.SignedPreKeyRecord>();
  async saveSignedPreKey(id: number, record: Signal.SignedPreKeyRecord): Promise<void> {
    this.records.set(id, record);
  }
  async getSignedPreKey(id: number): Promise<Signal.SignedPreKeyRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`signed pre-key ${id} not found`);
    return record;
  }
}

export class MemoryKyberPreKeyStore extends Signal.KyberPreKeyStore {
  readonly records = new Map<number, Signal.KyberPreKeyRecord>();
  readonly used = new Set<number>();
  async saveKyberPreKey(id: number, record: Signal.KyberPreKeyRecord): Promise<void> {
    this.records.set(id, record);
  }
  async getKyberPreKey(id: number): Promise<Signal.KyberPreKeyRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`kyber pre-key ${id} not found`);
    return record;
  }
  async markKyberPreKeyUsed(id: number): Promise<void> {
    this.used.add(id);
  }
  async hasKyberPreKeyBeenUsed(id: number): Promise<boolean> {
    return this.used.has(id);
  }
}

export class MemorySenderKeyStore extends Signal.SenderKeyStore {
  readonly records = new Map<string, Signal.SenderKeyRecord>();
  async saveSenderKey(
    sender: Signal.ProtocolAddress,
    distributionId: string,
    record: Signal.SenderKeyRecord,
  ): Promise<void> {
    this.records.set(`${key(sender)}::${distributionId}`, record);
  }
  async getSenderKey(
    sender: Signal.ProtocolAddress,
    distributionId: string,
  ): Promise<Signal.SenderKeyRecord | null> {
    return this.records.get(`${key(sender)}::${distributionId}`) ?? null;
  }
}

/** One party: its address and every store libsignal asks for. */
export class Party {
  readonly address: Signal.ProtocolAddress;
  readonly identity: MemoryIdentityStore;
  readonly sessions = new MemorySessionStore();
  readonly preKeys = new MemoryPreKeyStore();
  readonly signedPreKeys = new MemorySignedPreKeyStore();
  readonly kyberPreKeys = new MemoryKyberPreKeyStore();
  readonly senderKeys = new MemorySenderKeyStore();
  constructor(aci: string, deviceId: number, registrationId: number, identity?: Signal.PrivateKey) {
    this.address = Signal.ProtocolAddress.new(aci, deviceId);
    this.identity = new MemoryIdentityStore(registrationId, identity);
  }

  /** Publishes one EC, one signed and one Kyber pre-key, as the server would hand them out. */
  async bundle(): Promise<Signal.PreKeyBundle> {
    const id = this.identity.identity;
    const preKey = Signal.PrivateKey.generate();
    const signedPreKey = Signal.PrivateKey.generate();
    const kyber = Signal.KEMKeyPair.generate();
    const signedSig = id.sign(signedPreKey.getPublicKey().serialize());
    const kyberSig = id.sign(kyber.getPublicKey().serialize());
    await this.preKeys.savePreKey(31, Signal.PreKeyRecord.new(31, preKey.getPublicKey(), preKey));
    await this.signedPreKeys.saveSignedPreKey(
      22,
      Signal.SignedPreKeyRecord.new(22, 42, signedPreKey.getPublicKey(), signedPreKey, signedSig),
    );
    await this.kyberPreKeys.saveKyberPreKey(77, Signal.KyberPreKeyRecord.new(77, 42, kyber, kyberSig));
    return Signal.PreKeyBundle.new(
      this.identity.registrationId,
      this.address.deviceId(),
      31,
      preKey.getPublicKey(),
      22,
      signedPreKey.getPublicKey(),
      signedSig,
      id.getPublicKey(),
      77,
      kyber.getPublicKey(),
      kyberSig,
    );
  }
}
