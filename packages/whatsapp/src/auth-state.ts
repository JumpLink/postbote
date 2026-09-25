/**
 * Baileys' auth state on postbote's `SecretStore`: the session file of one WhatsApp account.
 *
 * What it holds is everything this linked device is: the identity and noise keys, the signed
 * pre-key, the registration id (`creds`), and the Signal protocol state Baileys keeps per
 * contact and group (`keys`: sessions, pre-keys, sender keys, app-state keys, the LID ↔ phone
 * mapping). Whoever holds the file can read the account's incoming messages — it is SECRET:
 * never logged, never in a DTO or MCP output, 0600 in a 0700 directory outside the repository.
 *
 * Baileys ships `useMultiFileAuthState` (one JSON file per key); postbote keeps one SQLite file
 * per account instead, like the Telegram session. Values are TEXT — Baileys' own `BufferJSON`
 * encoding, which writes bytes as base64 — because the libgda-backed `node:sqlite` cannot carry
 * a BLOB (see packages/store/AGENTS.md).
 *
 * Writes are WRITE-BEHIND: the state lives in memory, and every change marks its key dirty; a
 * flush a moment later (`flushDelayMs`) writes all dirty keys in ONE `SecretStore.apply`, and
 * `close()` flushes whatever is left. Baileys updates Signal sessions on every decrypted
 * message; one transaction per message would spend the per-process execution budget this file
 * shares with the index (gjsify gap, unfixed, gjsify#1838). The window a crash can lose is the
 * delay — and a lost ratchet step is what Signal's retry receipts exist to repair.
 */

import type { SecretChange, SecretStore } from '@postbote/store';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import type { LidLookup } from './jid.ts';

const CREDS_NAMESPACE = 'baileys.creds';
const CREDS_KEY = 'creds';
const KEY_NAMESPACE_PREFIX = 'baileys.key.';

/** postbote's own namespace in the same file: which account this is, for `accounts list`. */
export const ACCOUNT_NAMESPACE = 'postbote.account';

type KeyType = keyof SignalDataTypeMap;

export interface AuthStateOptions {
  /** How long a change may wait before it is written. 0 writes on every change. */
  flushDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const serialize = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (text: string): unknown => JSON.parse(text, BufferJSON.reviver);

export class SecretStoreAuthState {
  readonly state: AuthenticationState;
  private readonly store: SecretStore;
  private readonly keys = new Map<string, Map<string, unknown>>();
  private readonly dirty = new Map<string, Set<string>>();
  private credsDirty = false;
  private timer: unknown = null;
  private readonly flushDelayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** How many times the store was written — a test measures the batching with it. */
  writes = 0;

  private constructor(store: SecretStore, creds: AuthenticationCreds, options: AuthStateOptions) {
    this.store = store;
    this.flushDelayMs = options.flushDelayMs ?? 500;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.state = {
      creds,
      keys: {
        get: async <T extends KeyType>(type: T, ids: string[]) => this.get(type, ids),
        set: async (data: SignalDataSet) => this.set(data),
      },
    };
  }

  /** Load the whole file (one execution); a file without creds starts a fresh, unlinked device. */
  static open(store: SecretStore, options: AuthStateOptions = {}): SecretStoreAuthState {
    const all = store.loadAll();
    const stored = all.get(CREDS_NAMESPACE)?.get(CREDS_KEY);
    const creds = stored ? (deserialize(stored) as AuthenticationCreds) : initAuthCreds();
    const auth = new SecretStoreAuthState(store, creds, options);
    for (const [namespace, entries] of all) {
      if (!namespace.startsWith(KEY_NAMESPACE_PREFIX)) continue;
      const type = namespace.slice(KEY_NAMESPACE_PREFIX.length);
      const map = new Map<string, unknown>();
      for (const [id, text] of entries) map.set(id, deserialize(text));
      auth.keys.set(type, map);
    }
    // A fresh device must reach the file before the first QR is shown: its keys are what the
    // phone links to.
    if (!stored) auth.saveCreds();
    return auth;
  }

  /** True once a phone has linked this device (Baileys sets `me` on pairing). */
  get registered(): boolean {
    return Boolean(this.state.creds.me?.id);
  }

  private get<T extends KeyType>(type: T, ids: string[]): { [id: string]: SignalDataTypeMap[T] } {
    const map = this.keys.get(type);
    const result: { [id: string]: SignalDataTypeMap[T] } = {};
    for (const id of ids) {
      let value = map?.get(id);
      if (value === undefined || value === null) continue;
      if (type === 'app-state-sync-key')
        value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
      result[id] = value as SignalDataTypeMap[T];
    }
    return result;
  }

  private set(data: SignalDataSet): void {
    for (const type of Object.keys(data) as KeyType[]) {
      const entries = data[type];
      if (!entries) continue;
      let map = this.keys.get(type);
      if (!map) {
        map = new Map();
        this.keys.set(type, map);
      }
      let dirty = this.dirty.get(type);
      if (!dirty) {
        dirty = new Set();
        this.dirty.set(type, dirty);
      }
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) map.delete(id);
        else map.set(id, value);
        dirty.add(id);
      }
    }
    this.schedule();
  }

  /** Baileys changed `creds` (it mutates the object and then emits `creds.update`). */
  saveCreds(): void {
    this.credsDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.flushDelayMs <= 0) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelayMs);
  }

  /**
   * Drop what is pending WITHOUT writing it, and cancel the write-behind timer — for a state
   * that is being thrown away with its file (a session refused as never linked). Without this
   * the timer outlives the closed store and fires into it.
   */
  discard(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.credsDirty = false;
    this.dirty.clear();
  }

  /** Write every dirty key in one transaction. */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const changes: SecretChange[] = [];
    if (this.credsDirty)
      changes.push({ namespace: CREDS_NAMESPACE, key: CREDS_KEY, value: serialize(this.state.creds) });
    for (const [type, ids] of this.dirty) {
      const map = this.keys.get(type);
      for (const id of ids) {
        const value = map?.get(id);
        changes.push({
          namespace: `${KEY_NAMESPACE_PREFIX}${type}`,
          key: id,
          value: value === undefined ? null : serialize(value),
        });
      }
    }
    this.credsDirty = false;
    this.dirty.clear();
    if (changes.length === 0) return;
    this.store.apply(changes);
    this.writes++;
  }

  /** Baileys' LID mapping as kept in the auth state: `<pn>` → `<lid>`, `<lid>_reverse` → `<pn>`. */
  lidLookup(): LidLookup {
    const read = (id: string): string | null => {
      const value = this.keys.get('lid-mapping')?.get(id);
      return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
    };
    return { lidForPn: (pn) => read(pn), pnForLid: (lid) => read(`${lid}_reverse`) };
  }
}
