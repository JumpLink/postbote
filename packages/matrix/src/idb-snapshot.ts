/**
 * An IndexedDB, dumped into a `SecretStore` and loaded back — how the Matrix crypto store
 * survives between two runs of postbote.
 *
 * The Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`) persists its Olm account, Olm sessions
 * and Megolm room keys only through IndexedDB; without one it keeps them in memory and they are
 * gone when the process ends — every run would be a new device that can decrypt nothing sent
 * before it. Neither GJS nor Node has an IndexedDB. So the crypto runs against an in-memory
 * IndexedDB (`fake-indexeddb`, pure JS, the same on both runtimes), and this module moves its
 * contents in and out of the account's secret file:
 *
 *   - `restore` recreates every database (version, object stores, indexes, records) BEFORE the
 *     crypto opens it — the crypto sees the store it left behind.
 *   - `save` reads every database back and writes only the records that changed since the last
 *     load or save, in one batch — executions are a per-process budget shared with the index
 *     (gjsify gap, unfixed, gjsify#1838 — see `insertMany` in `@postbote/store`).
 *
 * One record per `SecretStore` row: namespace `idb:<database>/<object store>`, key and value
 * as tagged JSON (`encodeValue`), because the store holds TEXT only.
 *
 * Works on a passed-in `IDBFactory`, never the global one, so the tests run it against a fresh
 * factory on both runtimes.
 */

import type { SecretChange, SecretStore } from '@postbote/store';
import { Buffer } from 'node:buffer';

/** Where the database layouts live: one key per database, the value its schema as JSON. */
export const IDB_SCHEMA_NAMESPACE = 'idb.schema';
const RECORD_PREFIX = 'idb:';

interface IndexSchema {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface StoreSchema {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSchema[];
}

interface DatabaseSchema {
  version: number;
  stores: StoreSchema[];
}

type Snapshot = Map<string, Map<string, string>>;

// ── tagged JSON: structured-clone values as TEXT ─────────────────────────

const TYPED_ARRAYS = {
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

/** Decoded bytes in a fresh ArrayBuffer of exactly their length (Buffer's may be a shared pool). */
function unb64Buffer(text: string): ArrayBuffer {
  const bytes = unb64(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function typedArrayName(value: ArrayBufferView): TypedArrayName | null {
  for (const name of Object.keys(TYPED_ARRAYS) as TypedArrayName[]) {
    if (value instanceof TYPED_ARRAYS[name]) return name;
  }
  return null;
}

/**
 * A structured-clone value as plain JSON. Objects that carry their own `$` key are wrapped so the
 * tag cannot be forged by data. Anything that is not cloneable data (a function, a class
 * instance) throws: a record silently turned into `{}` would be a lost key, found much later.
 */
export function encodeValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $: 'n', v: String(value) };
  if (value === undefined) return { $: 'u' };
  if (typeof value === 'bigint') return { $: 'b', v: value.toString() };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value instanceof ArrayBuffer) return { $: 'ab', v: b64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const name = value instanceof DataView ? null : typedArrayName(value);
    if (!name) throw new Error('cannot snapshot a DataView');
    return { $: 't', k: name, v: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (value instanceof Date) return { $: 'd', v: value.getTime() };
  if (value instanceof Map)
    return { $: 'm', v: [...value].map(([k, v]) => [encodeValue(k), encodeValue(v)]) };
  if (value instanceof Set) return { $: 's', v: [...value].map(encodeValue) };
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`cannot snapshot a ${proto?.constructor?.name ?? 'foreign'} object`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeValue(v);
    return '$' in out ? { $: 'o', v: out } : out;
  }
  throw new Error(`cannot snapshot a ${typeof value}`);
}

export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const tagged = value as { $?: unknown; v?: unknown; k?: unknown };
  switch (tagged.$) {
    case undefined:
      break;
    case 'n':
      return Number(tagged.v);
    case 'u':
      return undefined;
    case 'b':
      return BigInt(String(tagged.v));
    case 'ab':
      return unb64Buffer(String(tagged.v));
    case 't': {
      const Ctor = TYPED_ARRAYS[String(tagged.k) as TypedArrayName];
      if (!Ctor) throw new Error(`unknown typed array ${String(tagged.k)}`);
      return new (Ctor as new (buffer: ArrayBuffer) => ArrayBufferView)(unb64Buffer(String(tagged.v)));
    }
    case 'd':
      return new Date(Number(tagged.v));
    case 'm':
      return new Map((tagged.v as unknown[][]).map(([k, v]) => [decodeValue(k), decodeValue(v)]));
    case 's':
      return new Set((tagged.v as unknown[]).map(decodeValue));
    case 'o':
      return decodePlain(tagged.v as Record<string, unknown>);
    default:
      throw new Error(`unknown snapshot tag ${JSON.stringify(tagged.$)}`);
  }
  return decodePlain(value as Record<string, unknown>);
}

function decodePlain(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v);
  return out;
}

// ── IndexedDB, as promises ───────────────────────────────────────────────

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function open(
  factory: IDBFactory,
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`cannot open IndexedDB ${name}`));
    request.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by an open connection`));
  });
}

const keyPathOf = (keyPath: string | string[] | null): string | string[] | null =>
  keyPath === null ? null : Array.isArray(keyPath) ? [...keyPath] : keyPath;

/** Read one database whole: its schema and every record, encoded. */
async function dumpDatabase(factory: IDBFactory, name: string, into: Snapshot): Promise<DatabaseSchema> {
  const db = await open(factory, name);
  try {
    const storeNames = [...db.objectStoreNames];
    const schema: DatabaseSchema = { version: db.version, stores: [] };
    if (storeNames.length === 0) return schema;
    const tx = db.transaction(storeNames, 'readonly');
    const reads: Array<Promise<void>> = [];
    for (const storeName of storeNames) {
      const store = tx.objectStore(storeName);
      schema.stores.push({
        name: storeName,
        keyPath: keyPathOf(store.keyPath),
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((indexName) => {
          const index = store.index(indexName);
          return {
            name: indexName,
            keyPath: keyPathOf(index.keyPath) as string | string[],
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        }),
      });
      const records = new Map<string, string>();
      into.set(`${RECORD_PREFIX}${name}/${storeName}`, records);
      reads.push(
        Promise.all([done(store.getAllKeys()), done(store.getAll())]).then(([keys, values]) => {
          keys.forEach((key, i) => {
            records.set(JSON.stringify(encodeValue(key)), JSON.stringify(encodeValue(values[i])));
          });
        }),
      );
    }
    await Promise.all([...reads, finished(tx)]);
    return schema;
  } finally {
    db.close();
  }
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`cannot delete IndexedDB ${name}`));
  });
}

/** Recreate one database from its schema and records. An existing one of that name is replaced. */
async function loadDatabase(
  factory: IDBFactory,
  name: string,
  schema: DatabaseSchema,
  records: (storeName: string) => Map<string, string>,
): Promise<void> {
  await deleteDatabase(factory, name);
  const db = await open(factory, name, schema.version, (fresh) => {
    for (const store of schema.stores) {
      const created = fresh.createObjectStore(store.name, {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
      });
      for (const index of store.indexes) {
        created.createIndex(index.name, index.keyPath, {
          unique: index.unique,
          multiEntry: index.multiEntry,
        });
      }
    }
  });
  try {
    if (schema.stores.length === 0) return;
    const tx = db.transaction(
      schema.stores.map((s) => s.name),
      'readwrite',
    );
    for (const storeSchema of schema.stores) {
      const store = tx.objectStore(storeSchema.name);
      for (const [key, value] of records(storeSchema.name)) {
        const decoded = decodeValue(JSON.parse(value));
        // In-line keys come from the value itself; passing one as well is an error.
        if (storeSchema.keyPath === null) store.put(decoded, decodeValue(JSON.parse(key)) as IDBValidKey);
        else store.put(decoded);
      }
    }
    await finished(tx);
  } finally {
    db.close();
  }
}

/**
 * The IndexedDB databases whose names start with `prefix`, kept in a `SecretStore`.
 *
 * One instance per account and connection: `restore` before the crypto opens its store,
 * `save` after it is done (and whenever a checkpoint is worth it).
 */
export class IndexedDbSnapshot {
  private readonly factory: IDBFactory;
  private readonly store: SecretStore;
  private readonly prefix: string;
  /** What the secret file holds right now, to write only the difference. */
  private persisted: Snapshot = new Map();

  constructor(factory: IDBFactory, store: SecretStore, prefix: string) {
    this.factory = factory;
    this.store = store;
    this.prefix = prefix;
  }

  /** Load every saved database into the factory. Returns how many there were. */
  async restore(): Promise<number> {
    const all = this.store.loadAll();
    const schemas = all.get(IDB_SCHEMA_NAMESPACE) ?? new Map<string, string>();
    this.persisted = new Map();
    // Whatever this process already holds under the prefix goes first: it belongs to an earlier
    // connection (or another device of the same account) and must not mix with the saved one.
    for (const { name } of await this.factory.databases()) {
      if (name?.startsWith(this.prefix)) await deleteDatabase(this.factory, name);
    }
    let count = 0;
    for (const [name, json] of schemas) {
      if (!name.startsWith(this.prefix)) continue;
      const schema = JSON.parse(json) as DatabaseSchema;
      await loadDatabase(this.factory, name, schema, (storeName) => {
        const ns = `${RECORD_PREFIX}${name}/${storeName}`;
        const records = all.get(ns) ?? new Map<string, string>();
        this.persisted.set(ns, new Map(records));
        return records;
      });
      count++;
    }
    this.persisted.set(
      IDB_SCHEMA_NAMESPACE,
      new Map([...schemas].filter(([name]) => name.startsWith(this.prefix))),
    );
    return count;
  }

  /** Dump every database of the prefix and write what changed. Returns the number of changes. */
  async save(): Promise<number> {
    const names = (await this.factory.databases())
      .map((d) => d.name)
      .filter((n): n is string => typeof n === 'string' && n.startsWith(this.prefix));
    const current: Snapshot = new Map();
    const schemas = new Map<string, string>();
    for (const name of names.sort()) {
      schemas.set(name, JSON.stringify(await dumpDatabase(this.factory, name, current)));
    }
    current.set(IDB_SCHEMA_NAMESPACE, schemas);

    const changes: SecretChange[] = [];
    for (const [namespace, now] of current) {
      const before = this.persisted.get(namespace) ?? new Map<string, string>();
      for (const [key, value] of now) if (before.get(key) !== value) changes.push({ namespace, key, value });
      for (const key of before.keys()) if (!now.has(key)) changes.push({ namespace, key, value: null });
    }
    // A whole object store (or database) that disappeared.
    for (const [namespace, before] of this.persisted) {
      if (current.has(namespace)) continue;
      for (const key of before.keys()) changes.push({ namespace, key, value: null });
    }
    this.store.apply(changes);
    this.persisted = current;
    return changes.length;
  }
}
