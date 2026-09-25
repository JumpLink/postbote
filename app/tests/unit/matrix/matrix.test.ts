import { describe, expect, it } from '@gjsify/unit';
import { IDBFactory } from 'fake-indexeddb';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isChatBackend, validateManifest } from '@postbote/protocol';
import {
  chatConversationId,
  getConversation,
  rebuildConversations,
  SecretStore,
  syncChats,
} from '@postbote/store';
import {
  accountIdFor,
  accountPath,
  decodeValue,
  encodeValue,
  IndexedDbSnapshot,
  listAccounts,
  MATRIX_MANIFEST,
  MatrixBackend,
  MatrixChatSession,
  mapEvents,
  readOnlyFetch,
  ReadOnlyViolation,
  refusal,
  seqOf,
  stripReplyFallback,
  toChatInfo,
  toChatMessage,
  UNDECRYPTABLE_TEXT,
  writeAccessToken,
  writeAccountRecord,
} from '@postbote/matrix';
import { freshDb } from '../store/fixtures.ts';
import {
  ANNA,
  BEN,
  edit,
  event,
  FakeMatrixApi,
  fakeConnector,
  ME,
  redaction,
  text,
  undecryptable,
} from './fake-api.ts';

/**
 * The Matrix backend without a homeserver: event mapping (edits, redactions, replies, threads,
 * undecryptable messages), the history walk over a fake `/messages`, the IndexedDB snapshot that
 * carries the crypto store between runs, and a full sync through the backend into the
 * conversation view. All data is synthetic.
 */

const NAMES = new Map([[ANNA, 'Anna Example']]);
const T0 = Date.parse('2026-09-01T10:00:00Z');
/** T0 plus whole seconds. */
const at = (seconds: number): number => T0 + seconds * 1000;
const S = (seconds: number): number => seqOf(at(seconds));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postbote-matrix-'));
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(factory: IDBFactory, name: string, version?: number, upgrade?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version ? factory.open(name, version) : factory.open(name);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withTx(db: IDBDatabase, stores: string[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const tx = db.transaction(stores, 'readwrite');
  fn(tx);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** An account file the backend can connect with (the fake connector ignores the token). */
function seedAccount(dir: string, userId = ME): string {
  const id = accountIdFor(userId);
  const store = SecretStore.open(accountPath(dir, id));
  writeAccountRecord(store, { userId, homeserver: 'https://matrix.example.org', deviceId: 'DEVICE' });
  writeAccessToken(store, 'synthetic-token');
  store.close();
  return id;
}

export default async () => {
  await describe('Matrix read-only gate', async () => {
    const HS = 'https://matrix.example.org/_matrix/client/v3';

    await it('lets reads through, and /sync only with set_presence=offline', async () => {
      expect(refusal('GET', `${HS}/rooms/!r/messages?dir=b`)).toBe(null);
      expect(refusal('GET', `${HS}/sync?filter=1&set_presence=offline&since=s1`)).toBe(null);
      // An omitted set_presence means online: refused.
      expect(refusal('GET', `${HS}/sync?filter=1&since=s1`) !== null).toBe(true);
      expect(refusal('GET', `${HS}/sync?set_presence=online`) !== null).toBe(true);
    });

    await it('allows the key protocol and login, and refuses everything people would see', async () => {
      for (const [method, path] of [
        ['POST', '/login'],
        ['POST', '/logout'],
        ['POST', '/user/%40me%3Aexample.org/filter'],
        ['POST', '/keys/upload'],
        ['POST', '/keys/query'],
        ['POST', '/keys/claim'],
        ['PUT', '/sendToDevice/m.room_key_request/t1'],
      ]) {
        expect(refusal(method, `${HS}${path}`)).toBe(null);
      }
      for (const [method, path] of [
        ['POST', '/rooms/!r/receipt/m.read/$e'],
        ['POST', '/rooms/!r/read_markers'],
        ['PUT', '/rooms/!r/typing/%40me%3Aexample.org'],
        ['PUT', '/rooms/!r/send/m.room.message/t1'],
        ['PUT', '/rooms/!r/redact/$e/t1'],
        ['PUT', '/presence/%40me%3Aexample.org/status'],
        ['POST', '/join/!r'],
        ['POST', '/rooms/!r/leave'],
        ['PUT', '/user/%40me%3Aexample.org/account_data/m.direct'],
        ['DELETE', '/devices/ABC'],
      ]) {
        expect(refusal(method, `${HS}${path}`) !== null).toBe(true);
      }
    });

    await it('fails closed: a refused request never reaches the network', async () => {
      const sent: string[] = [];
      const inner = (async (input: string | URL | Request) => {
        sent.push(String(input));
        return new Response('{}');
      }) as typeof fetch;
      const guarded = readOnlyFetch(inner);
      await guarded(`${HS}/sync?set_presence=offline`);
      let error: unknown = null;
      try {
        await guarded(`${HS}/rooms/!r/receipt/m.read/$e`, { method: 'POST' });
      } catch (err) {
        error = err;
      }
      expect(error instanceof ReadOnlyViolation).toBe(true);
      expect(sent.length).toBe(1);
    });
  });

  await describe('Matrix manifest', async () => {
    await it('is valid, server-archive, end-to-end encrypted, with no extra terms', async () => {
      expect(validateManifest(MATRIX_MANIFEST).length).toBe(0);
      expect(MATRIX_MANIFEST.syncModel).toBe('server-archive');
      expect(MATRIX_MANIFEST.capabilities.e2ee).toBe(true);
      expect(MATRIX_MANIFEST.addressKinds.join()).toBe('matrix');
      expect(MATRIX_MANIFEST.terms).toBe(null);
    });
  });

  await describe('Matrix event mapping', async () => {
    await it('maps a text message with its sender, timestamp sequence and event id', async () => {
      const e = text(ANNA, T0, 'Hallo');
      const m = toChatMessage(e, ME, NAMES);
      expect(m?.remoteId).toBe(e.eventId);
      expect(m?.seq).toBe(T0);
      expect(m?.sentAt).toBe('2026-09-01T10:00:00.000Z');
      expect(m?.text).toBe('Hallo');
      expect(m?.sender?.displayName).toBe('Anna Example');
      expect(m?.sender?.addresses[0].kind).toBe('matrix');
      expect(m?.sender?.addresses[0].value).toBe(ANNA);
      expect(m?.fromSelf).toBe(false);
      const mine = toChatMessage(text(ME, T0, 'Hi'), ME, NAMES);
      expect(mine?.fromSelf).toBe(true);
      expect(mine?.sender).toBe(null);
    });

    await it('treats a file body as its name, and a separate caption as text', async () => {
      const bare = toChatMessage(text(ANNA, T0, 'scan.pdf', { msgtype: 'm.file' }), ME, NAMES);
      expect(bare?.hasAttachments).toBe(true);
      expect(bare?.text).toBe(null);
      const captioned = toChatMessage(
        text(ANNA, T0, 'Die Rechnung', { msgtype: 'm.image', filename: 'img.png' }),
        ME,
        NAMES,
      );
      expect(captioned?.text).toBe('Die Rechnung');
      const sticker = toChatMessage(event('m.sticker', ANNA, T0, { body: 'cat' }), ME, NAMES);
      expect(sticker?.hasAttachments).toBe(true);
    });

    await it('strips the reply fallback and keeps the relation; a thread is not a reply', async () => {
      expect(stripReplyFallback('> <@anna:example.org> Frage?\n> zweite Zeile\n\nAntwort')).toBe('Antwort');
      expect(stripReplyFallback('>_> kein Zitat')).toBe('>_> kein Zitat');
      const reply = toChatMessage(
        text(BEN, T0, '> <@anna:example.org> Frage?\n\nAntwort', {
          'm.relates_to': { 'm.in_reply_to': { event_id: '$q:example.org' } },
        }),
        ME,
        NAMES,
      );
      expect(reply?.text).toBe('Antwort');
      expect(reply?.replyToRemoteId).toBe('$q:example.org');
      const threaded = toChatMessage(
        text(BEN, T0, 'im Thread', {
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$root:example.org',
            is_falling_back: true,
            'm.in_reply_to': { event_id: '$last:example.org' },
          },
        }),
        ME,
        NAMES,
      );
      expect(threaded?.threadRemoteId).toBe('$root:example.org');
      expect(threaded?.replyToRemoteId).toBe(null);
    });

    await it('keeps an undecryptable message as a placeholder, never the ciphertext', async () => {
      const raw = toChatMessage(
        event(
          'm.room.encrypted',
          ANNA,
          T0,
          { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'AAAA' },
          { undecryptable: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' },
        ),
        ME,
        NAMES,
      );
      expect(raw?.text).toBe(UNDECRYPTABLE_TEXT);
      // matrix-js-sdk's shape for the same failure.
      const sdk = toChatMessage(
        event(
          'm.room.message',
          ANNA,
          T0,
          { msgtype: 'm.bad.encrypted', body: '** Unable to decrypt **' },
          { undecryptable: 'x' },
        ),
        ME,
        NAMES,
      );
      expect(sdk?.text).toBe(UNDECRYPTABLE_TEXT);
      expect(sdk?.hasAttachments).toBe(false);
    });

    await it('leaves out state, reactions, redactions and stripped events', async () => {
      expect(
        toChatMessage(
          event('m.room.member', ANNA, T0, { membership: 'join' }, { stateKey: ANNA }),
          ME,
          NAMES,
        ),
      ).toBe(null);
      expect(toChatMessage(event('m.reaction', ANNA, T0, {}), ME, NAMES)).toBe(null);
      expect(toChatMessage(redaction(ANNA, T0, '$x'), ME, NAMES)).toBe(null);
      expect(toChatMessage(event('m.room.message', ANNA, T0, {}, { redacted: true }), ME, NAMES)).toBe(null);
    });

    await it('applies edits on the page by the original sender only, and hands on the others', async () => {
      const original = text(ANNA, T0, 'Treffen um 5');
      const forged = edit(BEN, T0 + 1, original.eventId, 'Treffen abgesagt');
      const own = edit(ANNA, T0 + 2, original.eventId, 'Treffen um 6');
      const earlier = edit(ANNA, T0 + 3, '$older:example.org', 'korrigiert');
      const mapped = mapEvents([original, forged, own, earlier], ME, NAMES);
      expect(mapped.messages.length).toBe(1);
      expect(mapped.messages[0].text).toBe('Treffen um 6');
      expect(mapped.messages[0].editedAt).toBe(new Date(T0 + 2).toISOString());
      expect(mapped.edits.length).toBe(1);
      expect(mapped.edits[0].remoteId).toBe('$older:example.org');
      expect(mapped.edits[0].senderRemoteId).toBe(ANNA);
    });

    await it('removes a redacted message from the page and reports it', async () => {
      const gone = text(ANNA, T0, 'versehentlich');
      const mapped = mapEvents([gone, redaction(ANNA, T0 + 5, gone.eventId)], ME, NAMES);
      expect(mapped.messages.length).toBe(0);
      expect(mapped.retracted.join()).toBe(gone.eventId);
    });

    await it('turns a room into a chat: direct names the other person, cursors are timestamps', async () => {
      const info = toChatInfo({
        roomId: '!dm:example.org',
        name: 'Anna Example',
        direct: true,
        members: [{ userId: ANNA, displayName: 'Anna Example' }],
        lastEventTs: T0,
        readUpToTs: at(-10),
        peerReadUpToTs: null,
      });
      expect(info.kind).toBe('direct');
      expect(info.members[0].remoteId).toBe(ANNA);
      expect(info.lastSeq).toBe(S(0));
      expect(info.readInboxSeq).toBe(S(-10));
      const group = toChatInfo({
        ...{
          roomId: '!g:example.org',
          name: 'Orga',
          direct: false,
          members: [{ userId: BEN, displayName: null }],
          lastEventTs: null,
          readUpToTs: null,
          peerReadUpToTs: null,
        },
      });
      expect(group.kind).toBe('group');
      expect(group.members.length).toBe(0);
    });
  });

  await describe('Matrix history walk', async () => {
    await it('takes the newest window and never splits a millisecond', async () => {
      const api = new FakeMatrixApi();
      api.addRoom({ roomId: '!r' });
      for (let i = 0; i < 10; i++) api.post('!r', text(ANNA, at(i * 10), `m${i}`));
      // Two messages in the same millisecond at the window's lower edge.
      api.post('!r', text(ANNA, at(200), 'a'), text(BEN, at(200), 'b'), text(ANNA, at(300), 'c'));
      const session = new MatrixChatSession(api);
      const page = await session.fetchHistory('!r', null, 2);
      expect(page.messages.map((m) => m.text).join()).toBe('a,b,c');
      expect(page.highestSeq).toBe(S(300));
      // Not the room's start: an older event may share the lowest millisecond.
      expect(page.lowestSeq).toBe(S(200) + 1);
      expect(page.reachedStart).toBe(false);
      expect(page.exhausted).toBe(true);
    });

    await it('reaches the start of a short room', async () => {
      const api = new FakeMatrixApi();
      api.addRoom({ roomId: '!r' });
      api.post('!r', event('m.room.create', ANNA, T0, {}, { stateKey: '' }), text(ANNA, at(1), 'erste'));
      const page = await new MatrixChatSession(api).fetchHistory('!r', null, 50);
      expect(page.reachedStart).toBe(true);
      expect(page.lowestSeq).toBe(S(0));
      expect(page.messages.length).toBe(1);
    });

    await it('walks forward from a cursor in pages, with one walk per session', async () => {
      const api = new FakeMatrixApi();
      api.addRoom({ roomId: '!r' });
      for (let i = 1; i <= 250; i++) api.post('!r', text(ANNA, at(i), `m${i}`));
      const session = new MatrixChatSession(api);
      const first = await session.fetchHistory('!r', S(100), 100);
      expect(first.messages[0].text).toBe('m101');
      expect(first.messages.length).toBe(100);
      expect(first.exhausted).toBe(false);
      expect(first.highestSeq).toBe(S(200));
      const calls = api.calls.length;
      const second = await session.fetchHistory('!r', first.highestSeq, 100);
      expect(second.messages.map((m) => m.text).join()).toBe(
        Array.from({ length: 50 }, (_, i) => `m${201 + i}`).join(),
      );
      expect(second.exhausted).toBe(true);
      // The second page came from the walk the first one did.
      expect(api.calls.length).toBe(calls);
      const none = await session.fetchHistory('!r', S(250), 100);
      expect(none.messages.length).toBe(0);
      expect(none.highestSeq).toBe(null);
    });
  });

  await describe('IndexedDB snapshot', async () => {
    await it('round-trips structured-clone values through tagged JSON', async () => {
      const value = {
        bytes: new Uint8Array([0, 1, 254, 255]),
        buffer: new Uint8Array([9, 8]).buffer,
        list: [1, 'two', null, undefined, Number.NaN],
        big: 12345678901234567890n,
        when: new Date(T0),
        map: new Map([['k', new Set([1])]]),
        $: 'a key that looks like a tag',
      };
      const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
      expect([...back.bytes].join()).toBe('0,1,254,255');
      expect(back.bytes instanceof Uint8Array).toBe(true);
      expect(back.buffer instanceof ArrayBuffer && back.buffer.byteLength === 2).toBe(true);
      expect(back.list[3]).toBe(undefined);
      expect(Number.isNaN(back.list[4] as number)).toBe(true);
      expect(back.big).toBe(12345678901234567890n);
      expect(back.when.getTime()).toBe(T0);
      expect(back.map.get('k')?.has(1)).toBe(true);
      expect(back.$).toBe('a key that looks like a tag');
      expect(() => encodeValue(new (class Foreign {})())).toThrow();
    });

    await it('carries databases into a fresh factory and saves only what changed', async () => {
      const store = SecretStore.open(':memory:');
      try {
        const before = new IDBFactory();
        const db = await openDb(before, 'postbote-a::crypto', 3, (fresh) => {
          const inline = fresh.createObjectStore('sessions', { keyPath: ['room', 'id'] });
          inline.createIndex('by_room', 'room', { unique: false });
          fresh.createObjectStore('kv');
        });
        await withTx(db, ['sessions', 'kv'], (tx) => {
          tx.objectStore('sessions').put({ room: '!r', id: 's1', key: new Uint8Array([1, 2, 3]) });
          tx.objectStore('kv').put(new Uint8Array([42]), 'account');
        });
        db.close();
        // Another prefix is not this account's business.
        (await openDb(before, 'other-db', 1, (fresh) => fresh.createObjectStore('x'))).close();

        const saving = new IndexedDbSnapshot(before, store, 'postbote-a');
        expect((await saving.save()) > 0).toBe(true);
        expect(await saving.save()).toBe(0);

        const after = new IDBFactory();
        const restoring = new IndexedDbSnapshot(after, store, 'postbote-a');
        expect(await restoring.restore()).toBe(1);
        const names = (await after.databases()).map((d) => d.name);
        expect(names.join()).toBe('postbote-a::crypto');
        const copy = await openDb(after, 'postbote-a::crypto');
        expect(copy.version).toBe(3);
        const tx = copy.transaction(['sessions', 'kv'], 'readonly');
        const session = (await idbRequest(tx.objectStore('sessions').index('by_room').get('!r'))) as {
          key: Uint8Array;
        };
        expect([...session.key].join()).toBe('1,2,3');
        const account = (await idbRequest(tx.objectStore('kv').get('account'))) as Uint8Array;
        expect(account[0]).toBe(42);
        copy.close();
        expect(await restoring.save()).toBe(0);

        const again = await openDb(after, 'postbote-a::crypto');
        await withTx(again, ['kv'], (t) => {
          t.objectStore('kv').put(new Uint8Array([43]), 'account');
        });
        again.close();
        expect(await restoring.save()).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  await describe('IndexedDB snapshot deletions', async () => {
    await it('deletes a removed record, a dropped object store and a deleted database', async () => {
      const store = SecretStore.open(':memory:');
      try {
        const factory = new IDBFactory();
        const db = await openDb(factory, 'postbote-b::crypto', 1, (fresh) => {
          fresh.createObjectStore('keep');
          fresh.createObjectStore('drop');
        });
        await withTx(db, ['keep', 'drop'], (tx) => {
          tx.objectStore('keep').put('a', 'k1');
          tx.objectStore('keep').put('b', 'k2');
          tx.objectStore('drop').put('c', 'k3');
        });
        db.close();
        (await openDb(factory, 'postbote-b::other', 1, (fresh) => fresh.createObjectStore('x'))).close();
        const snapshot = new IndexedDbSnapshot(factory, store, 'postbote-b');
        await snapshot.save();
        const keys = () =>
          [...store.loadAll()]
            .filter(([ns]) => ns.startsWith('idb'))
            .flatMap(([ns, map]) => [...map.keys()].map((k) => `${ns}|${k}`))
            .sort()
            .join(' ');
        expect(keys().includes('idb:postbote-b::other/x')).toBe(false);

        // A removed record.
        const again = await openDb(factory, 'postbote-b::crypto');
        await withTx(again, ['keep'], (tx) => {
          tx.objectStore('keep').delete('k2');
        });
        again.close();
        expect(await snapshot.save()).toBe(1);
        expect(keys().includes('"k2"')).toBe(false);
        expect(keys().includes('"k1"')).toBe(true);

        // A dropped object store: its records and its place in the schema go.
        (await openDb(factory, 'postbote-b::crypto', 2, (up) => up.deleteObjectStore('drop'))).close();
        expect((await snapshot.save()) >= 2).toBe(true);
        expect(keys().includes('idb:postbote-b::crypto/drop')).toBe(false);

        // A deleted database: everything of it goes, the other stays.
        (await openDb(factory, 'postbote-b::other')).close();
        await new Promise<void>((resolve, reject) => {
          const request = factory.deleteDatabase('postbote-b::crypto');
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
        await snapshot.save();
        expect(keys().includes('postbote-b::crypto')).toBe(false);
        expect(keys().includes('idb.schema|postbote-b::other')).toBe(true);

        // And a restore into a fresh factory brings back exactly what is left.
        const fresh = new IDBFactory();
        expect(await new IndexedDbSnapshot(fresh, store, 'postbote-b').restore()).toBe(1);
        expect((await fresh.databases()).map((d) => d.name).join()).toBe('postbote-b::other');
      } finally {
        store.close();
      }
    });
  });

  await describe('Matrix backend', async () => {
    await it('lists the accounts it has files for, by user id', async () => {
      const dir = tempDir();
      try {
        const id = seedAccount(dir);
        expect(/^matrix-[0-9a-f]{14}$/.test(id)).toBe(true);
        const accounts = listAccounts(dir);
        expect(accounts.length).toBe(1);
        expect(accounts[0].identity).toBe(ME);
        expect(accounts[0].provider).toBe('Matrix');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses to connect an account without a file', async () => {
      const dir = tempDir();
      try {
        const backend = new MatrixBackend(
          { settings: {}, env: {}, secretsDir: dir },
          fakeConnector(new FakeMatrixApi()),
        );
        let message = '';
        try {
          await backend.connect(accountIdFor(ME));
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message.includes('postbote accounts add matrix')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('syncs rooms into the conversation view and applies later edits and redactions', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        const accountId = seedAccount(dir);
        const api = new FakeMatrixApi();
        api.addRoom({
          roomId: '!dm:example.org',
          name: 'Anna Example',
          direct: true,
          members: [{ userId: ANNA, displayName: 'Anna Example' }],
        });
        const hello = text(ANNA, T0, 'Hallo, bist du da?');
        const typo = text(ANNA, at(10), 'Treffen um 5');
        api.post('!dm:example.org', hello, text(ME, at(5), 'Ja'), typo);
        const connector = fakeConnector(api);
        const backend = new MatrixBackend({ settings: {}, env: {}, secretsDir: dir }, connector);
        expect(isChatBackend(backend)).toBe(true);

        const first = await syncChats(db, backend);
        expect(first.errors).toBe(0);
        expect(first.added).toBe(3);
        expect(connector.sessions[0].accessToken).toBe('synthetic-token');
        expect(api.closed).toBe(1);
        rebuildConversations(db);
        const id = chatConversationId('matrix', accountId, '!dm:example.org');
        let view = getConversation(db, id, { includeBodies: true });
        expect(view?.conversation.kind).toBe('direct');
        expect(view?.messages[0].presentation).toBe('bubble');
        expect(view?.messages[0].ref.remoteId).toBe(hello.eventId);
        expect(view?.messages[0].senderAddress?.value).toBe(ANNA);

        // Later: Anna fixes the time, somebody else tries to, and Anna withdraws her first message.
        api.post(
          '!dm:example.org',
          edit(ANNA, at(20), typo.eventId, 'Treffen um 6'),
          edit(BEN, at(25), typo.eventId, 'Treffen abgesagt'),
          redaction(ANNA, at(30), hello.eventId),
          text(ANNA, at(40), 'Bis dann'),
        );
        const second = await syncChats(db, backend);
        expect(second.errors).toBe(0);
        expect(second.added).toBe(1);
        expect(second.removed).toBe(1);
        view = getConversation(db, id, { includeBodies: true });
        const bodies = (view?.messages ?? []).map((m) => m.bodyText);
        expect(bodies.join('|')).toBe('Ja|Treffen um 6|Bis dann');
        expect(view?.messages[1].editedAt).toBe(new Date(at(20)).toISOString());
        expect(existsSync(join(dir, `${accountId}.db`))).toBe(true);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('retries undecryptable messages on later runs, also in chats with nothing new', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        const accountId = seedAccount(dir);
        const api = new FakeMatrixApi();
        api.addRoom({ roomId: '!e:example.org', name: 'Encrypted', direct: false });
        const locked = undecryptable(ANNA, at(1));
        const lockedEdit = undecryptable(ANNA, at(3));
        const target = text(ANNA, at(2), 'alt');
        const hopeless = undecryptable(BEN, at(4));
        api.post('!e:example.org', locked, target, lockedEdit, hopeless);
        const backend = new MatrixBackend({ settings: {}, env: {}, secretsDir: dir }, fakeConnector(api));
        const id = chatConversationId('matrix', accountId, '!e:example.org');
        const bodies = () =>
          (getConversation(db, id, { includeBodies: true })?.messages ?? []).map((m) => m.bodyText).join('|');

        await syncChats(db, backend);
        expect(bodies()).toBe(`${UNDECRYPTABLE_TEXT}|alt|${UNDECRYPTABLE_TEXT}|${UNDECRYPTABLE_TEXT}`);
        // Nothing is retried in the run that stored them.
        expect(api.fetched.length).toBe(0);

        // The keys for two of them arrive; the room itself has nothing new.
        api.decryptsNow.set(locked.eventId, {
          ...text(ANNA, locked.ts, 'jetzt lesbar'),
          eventId: locked.eventId,
        });
        api.decryptsNow.set(lockedEdit.eventId, {
          ...edit(ANNA, lockedEdit.ts, target.eventId, 'neu'),
          eventId: lockedEdit.eventId,
        });
        const second = await syncChats(db, backend);
        expect(second.errors).toBe(0);
        expect(api.fetched.length).toBe(3);
        // The message decrypts in place; the edit replaces its placeholder and lands on its target.
        expect(bodies()).toBe(`jetzt lesbar|neu|${UNDECRYPTABLE_TEXT}`);

        // Only the one still locked is tried again.
        api.fetched.length = 0;
        await syncChats(db, backend);
        expect(api.fetched.join()).toBe(hopeless.eventId);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
