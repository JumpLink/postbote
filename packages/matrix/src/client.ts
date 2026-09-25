/**
 * The real client: matrix-js-sdk with its Rust crypto compiled to WebAssembly
 * (`@matrix-org/matrix-sdk-crypto-wasm`) — the web-standards path ADR 0001 §7 prefers over a
 * native addon. It runs on GJS through gjsify on fetch, WebAssembly and WebCrypto.
 *
 * Everything else in this package talks to `MatrixApi`; this file is the only one that
 * constructs matrix-js-sdk, so the tests never need a homeserver.
 *
 * Why a sync loop at all, for a client that reads history with `/messages`: room keys of
 * encrypted rooms arrive as to-device messages, and only `/sync` delivers them. `connect` runs
 * the SDK's sync until the first complete response (`PREPARED`) — room list, read receipts, and
 * every room key queued for this device since the last run, handed to the crypto — and saves the
 * crypto store before any history is read. `close` saves it again after the loop has stopped.
 */

import type { SecretStore } from '@postbote/store';
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from 'fake-indexeddb';
import type { MatrixClient, MatrixEvent, Room, SyncState } from 'matrix-js-sdk';
import type { MatrixApi, MxEvent, MxMessagesPage, MxRoom } from './api.ts';
import { readOnlyFetch, ReadOnlyViolation, refusals } from './guard.ts';
import { IndexedDbSnapshot } from './idb-snapshot.ts';

export type MatrixSdk = typeof import('matrix-js-sdk');

/**
 * matrix-js-sdk and the crypto's WASM glue, loaded on first use rather than at startup: a mail-
 * only `postbote` run (and the MCP server) never evaluates them. It also keeps gjsify's
 * `--app node` bundle loadable — gjsify gap (unfixed, no upstream issue yet): that target
 * resolves ESM imports with CJS-first conditions (`['require','node','module']`) and then
 * applies Node-mode default interop, so `bs58`'s `import basex from 'base-x'` gets base-x's CJS
 * build and a `default` that is not a function; evaluating the SDK throws at module init.
 */
export async function loadMatrixSdk(): Promise<MatrixSdk> {
  const sdk = await import('matrix-js-sdk');
  await quietGlobalLoggers();
  return sdk;
}

/** The SDK's logger interface, as `createClient` takes it (not exported under a name). */
type Logger = NonNullable<Parameters<MatrixSdk['createClient']>[0]['logger']>;

/** How long the first sync may take before `connect` gives up. */
const FIRST_SYNC_TIMEOUT_MS = 120_000;

/**
 * matrix-js-sdk logs every request at debug level to the console — on the MCP server that is
 * the protocol stream. Only warnings and errors pass, to stderr, and never an argument that is
 * not a string or an Error: a logged object can carry an event's content.
 */
const drop = (): void => {};
const toStderr =
  (level: string) =>
  (...msg: unknown[]): void => {
    const text = msg
      .map((m) => (typeof m === 'string' ? m : m instanceof Error ? m.message : '[…]'))
      .join(' ');
    console.error(`matrix ${level}: ${text}`);
  };

function quietLogger(): Logger {
  const logger: Logger = {
    trace: drop,
    debug: drop,
    info: drop,
    warn: toStderr('warning'),
    error: toStderr('error'),
    getChild: () => logger,
  };
  return logger;
}

let globalLoggersQuiet = false;

/**
 * The same for the SDK's module-level loggers (room and event models log through a global
 * `loglevel` logger, not the client's, at debug level to stdout). Every logger registered so far
 * is rebuilt; children created later copy the parent's factory.
 */
async function quietGlobalLoggers(): Promise<void> {
  if (globalLoggersQuiet) return;
  globalLoggersQuiet = true;
  const loglevel = (await import('loglevel')).default;
  const factory = (method: string) =>
    method === 'warn' || method === 'error' ? toStderr(method === 'warn' ? 'warning' : 'error') : drop;
  for (const logger of [loglevel, ...Object.values(loglevel.getLoggers())]) {
    logger.methodFactory = factory as typeof logger.methodFactory;
    logger.rebuild();
  }
}

/**
 * The IndexedDB the Rust crypto persists into. Neither GJS nor Node has one, so an in-memory
 * implementation is installed — once per process, and only where no IndexedDB exists — and its
 * contents live in the account's secret file between runs (`IndexedDbSnapshot`). The crypto
 * store looks the factory up on the global object, so it has to be a global.
 */
export function ensureIndexedDb(): IDBFactory {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.indexedDB) {
    Object.assign(g, {
      indexedDB: new IDBFactory(),
      IDBCursor,
      IDBCursorWithValue,
      IDBDatabase,
      IDBFactory,
      IDBIndex,
      IDBKeyRange,
      IDBObjectStore,
      IDBOpenDBRequest,
      IDBRequest,
      IDBTransaction,
      IDBVersionChangeEvent,
    });
  }
  return g.indexedDB as IDBFactory;
}

/** The IndexedDB name prefix of one account's crypto store. */
export function cryptoStorePrefix(accountId: string): string {
  return `postbote-${accountId}`;
}

export interface MatrixSession {
  homeserver: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /** The account's secret file: the crypto store is saved into it. */
  store: SecretStore;
  accountId: string;
}

export type MatrixConnector = (session: MatrixSession) => Promise<MatrixApi>;

function toMxEvent(event: MatrixEvent): MxEvent {
  const raw = event.event as { redacts?: unknown };
  const failure = event.isDecryptionFailure();
  return {
    eventId: event.getId() ?? '',
    type: event.getType(),
    sender: event.getSender() ?? '',
    ts: event.getTs(),
    ...(event.isState() ? { stateKey: event.getStateKey() ?? '' } : {}),
    content: event.getContent(),
    ...(typeof raw.redacts === 'string' ? { redacts: raw.redacts } : {}),
    redacted: event.isRedacted(),
    undecryptable: failure ? String(event.decryptionFailureReason ?? 'unknown') : null,
  };
}

function receiptTs(room: Room, userId: string): number | null {
  const receipt = room.getReadReceiptForUserId(userId);
  if (!receipt) return null;
  // The read event's own timestamp when the room holds it; otherwise the time of the receipt,
  // which is never earlier than the event it points at.
  return room.findEventById(receipt.eventId)?.getTs() ?? receipt.data?.ts ?? null;
}

function directRoomIds(client: MatrixClient): Map<string, string> {
  const content = (client.getAccountData('m.direct' as never)?.getContent() ?? {}) as Record<string, unknown>;
  const rooms = new Map<string, string>();
  for (const [userId, ids] of Object.entries(content)) {
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') rooms.set(id, userId);
  }
  return rooms;
}

function toMxRoom(client: MatrixClient, room: Room, direct: Map<string, string>): MxRoom {
  const self = client.getSafeUserId();
  const others = room.getJoinedMembers().filter((m) => m.userId !== self);
  const directWith = direct.get(room.roomId);
  const members = others.map((m) => ({ userId: m.userId, displayName: m.name || null }));
  if (directWith && members.length === 0) members.push({ userId: directWith, displayName: null });
  const last = room.getLastActiveTimestamp();
  const peerRead = others.map((m) => receiptTs(room, m.userId)).filter((ts): ts is number => ts !== null);
  return {
    roomId: room.roomId,
    name: room.name || null,
    direct: directWith !== undefined,
    members,
    lastEventTs: last > 0 ? last : null,
    readUpToTs: receiptTs(room, self),
    peerReadUpToTs: peerRead.length > 0 ? Math.max(...peerRead) : null,
  };
}

function firstSync(sdk: MatrixSdk, client: MatrixClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(sdk.ClientEvent.Sync, onSync);
      reject(new Error(`no answer from the homeserver's /sync within ${FIRST_SYNC_TIMEOUT_MS / 1000} s`));
    }, FIRST_SYNC_TIMEOUT_MS);
    const onSync = (state: SyncState, _previous: SyncState | null, data?: { error?: Error }): void => {
      if (state === sdk.SyncState.Prepared || state === sdk.SyncState.Syncing) {
        clearTimeout(timer);
        client.removeListener(sdk.ClientEvent.Sync, onSync);
        resolve();
      } else if (state === sdk.SyncState.Error) {
        clearTimeout(timer);
        client.removeListener(sdk.ClientEvent.Sync, onSync);
        reject(data?.error ?? new Error('the first /sync failed'));
      }
    };
    client.on(sdk.ClientEvent.Sync, onSync);
  });
}

/** The one place matrix-js-sdk is constructed. */
export const connectMatrixClient: MatrixConnector = async (session) => {
  const sdk = await loadMatrixSdk();
  const { LoggerLevel, Tracing } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  const snapshot = new IndexedDbSnapshot(
    ensureIndexedDb(),
    session.store,
    cryptoStorePrefix(session.accountId),
  );
  await snapshot.restore();

  // Saves never overlap (a checkpoint may still run when `close` asks for the last one), and the
  // first failure sticks: every later call — history, close — throws it. A crypto store that
  // could not be written is a device that silently forgets keys; that must stop the run.
  let saving: Promise<unknown> = Promise.resolve();
  let saveError: Error | null = null;
  const save = (): Promise<void> => {
    const next = saving.then(async () => {
      try {
        await snapshot.save();
      } catch (err) {
        saveError ??= new Error(
          `the Matrix crypto store could not be saved (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (saveError) throw saveError;
    });
    saving = next.catch(() => {});
    return next;
  };
  const refusedBefore = refusals.length;
  const healthy = (): void => {
    if (saveError) throw saveError;
    const refused = refusals.slice(refusedBefore);
    if (refused.length > 0) throw new ReadOnlyViolation(refused[0]);
  };

  /**
   * The SDK's own store, with a checkpoint: `setSyncData` is awaited by the sync loop after a
   * response was processed — room keys handed to the crypto — and BEFORE the next /sync, which
   * is what acknowledges those to-device messages to the server. Saving here means no key is
   * ever acknowledged that is not on disk; a crash at any point loses nothing the server will not
   * deliver again.
   */
  class CheckpointStore extends sdk.MemoryStore {
    override async setSyncData(
      data: Parameters<InstanceType<MatrixSdk['MemoryStore']>['setSyncData']>[0],
    ): Promise<void> {
      await super.setSyncData(data);
      await save();
    }
  }

  const client = sdk.createClient({
    baseUrl: session.homeserver,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    logger: quietLogger(),
    store: new CheckpointStore(),
    fetchFn: readOnlyFetch(globalThis.fetch.bind(globalThis)),
  });
  let running = false;
  try {
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: cryptoStorePrefix(session.accountId),
    });
    // The WASM logs through its own tracing, at debug level by default.
    if (Tracing.isAvailable()) new Tracing(LoggerLevel.Warn).turnOn();
    const synced = firstSync(sdk, client);
    running = true;
    await client.startClient({
      initialSyncLimit: 1,
      lazyLoadMembers: true,
      // An omitted `set_presence` marks the user ONLINE on every /sync (client-server spec). The
      // read-only gate refuses such a request too; this keeps it from being attempted.
      disablePresence: true,
    });
    await synced;
    await save();
    healthy();
  } catch (err) {
    if (running) client.stopClient();
    const saved = await save().then(
      () => null,
      (e: unknown) => e as Error,
    );
    if (saved && saved !== err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; ${saved.message}`);
    }
    throw err;
  }

  const mapper = client.getEventMapper();
  return {
    userId: session.userId,
    listRooms: async () => {
      const direct = directRoomIds(client);
      return client
        .getRooms()
        .filter((room) => room.getMyMembership() === 'join')
        .map((room) => toMxRoom(client, room, direct));
    },
    messages: async (roomId, from, limit): Promise<MxMessagesPage> => {
      healthy();
      const response = await client.createMessagesRequest(roomId, from, limit, sdk.Direction.Backward);
      const events: MxEvent[] = [];
      for (const raw of response.chunk) {
        const event = mapper(raw);
        await client.decryptEventIfNeeded(event);
        events.push(toMxEvent(event));
      }
      const displayNames = new Map<string, string>();
      for (const state of response.state ?? []) {
        const name = (state.content as { displayname?: unknown } | undefined)?.displayname;
        if (state.type === 'm.room.member' && state.state_key && typeof name === 'string' && name) {
          displayNames.set(state.state_key, name);
        }
      }
      const room = client.getRoom(roomId);
      for (const event of events) {
        const name = room?.getMember(event.sender)?.name;
        if (!displayNames.has(event.sender) && name && name !== event.sender)
          displayNames.set(event.sender, name);
      }
      return { events, end: response.end ?? null, displayNames };
    },
    fetchEvent: async (roomId, eventId): Promise<MxEvent | null> => {
      healthy();
      let raw;
      try {
        raw = await client.fetchRoomEvent(roomId, eventId);
      } catch (err) {
        if ((err as { errcode?: string }).errcode === 'M_NOT_FOUND') return null;
        throw err;
      }
      const event = mapper(raw);
      await client.decryptEventIfNeeded(event);
      return toMxEvent(event);
    },
    close: async () => {
      client.stopClient();
      await save();
      healthy();
    },
  };
};
