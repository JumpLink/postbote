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

import type { AccountPrompter, BackendContext, DeliveryEvent } from '@postbote/protocol';
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
  accountIdFromCreds,
  FileJournal,
  journalPath,
  JidResolver,
  parseJid,
  parsePairingPhone,
  parseSettings,
  PENDING_STALE_MS,
  renderModules,
  renderQr,
  SecretStoreAuthState,
  WHATSAPP_MANIFEST,
  WhatsAppBackend,
  WhatsAppMapper,
  WhatsAppReceiver,
  extractContent,
  unwrapContent,
} from '@postbote/whatsapp';
import type { WaMessage } from '@postbote/whatsapp';
import { Curve } from 'baileys';
import { freshDb } from '../store/fixtures.ts';
import {
  ANNA_LID,
  ANNA_PN,
  BEN_LID,
  fakeFactory,
  type FakeSocket,
  GROUP,
  ManualClock,
  text,
  tick,
  waMessage,
} from './fake-socket.ts';

/**
 * The WhatsApp backend without WhatsApp: JID identity, mapping of Baileys' shapes, the auth state
 * on postbote's SQLite, the receive path over a fake socket and a manual clock, the link flow and
 * what it leaves on disk, and a whole sync through the backend into the conversation view. All
 * data is synthetic.
 */

const ME = { id: '4915100000009:3@s.whatsapp.net', lid: '100000000000009:3@lid', name: 'Test Person' };
const ACCOUNT = 'whatsapp-100000000000009';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postbote-whatsapp-'));
}

function context(dir: string, settings: BackendContext['settings'] = {}): BackendContext {
  return { settings, env: {}, secretsDir: join(dir, 'secrets', 'whatsapp') };
}

function prompter(answers: string[]): AccountPrompter & { asked: string[]; notes: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    async ask(label) {
      asked.push(label);
      const next = queue.shift();
      if (next === undefined) throw new Error('no answer left');
      return next;
    },
    notify: (message) => notes.push(message),
  };
}

/** Script a link: the first socket shows a QR code, the phone pairs, WhatsApp asks for a restart; the second opens. */
function linkScript(socket: FakeSocket, index: number): void {
  if (index === 0) {
    socket.emit('connection.update', { qr: '2@synthetic-qr-payload,AAAA,BBBB,CCCC' });
    socket.options.auth.state.creds.me = { ...ME };
    socket.options.auth.saveCreds();
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: Object.assign(new Error('restart required'), { output: { statusCode: 515 } }),
      },
    });
  } else {
    socket.emit('connection.update', { connection: 'open' });
  }
}

async function link(dir: string, answers = ['']) {
  const factory = fakeFactory(linkScript);
  const ask = prompter(answers);
  const account = await new WhatsAppBackend(context(dir), { createSocket: factory.create }).addAccount(ask);
  return { account, ask, factory };
}

function receiver(socketScript: (s: FakeSocket, i: number) => void, clock: ManualClock, extra = {}) {
  const factory = fakeFactory(socketScript);
  const r = new WhatsAppReceiver(() => factory.create({ auth: null as never }), new WhatsAppMapper(), {
    mode: 'catch-up',
    quietMs: 1000,
    maxMs: 60_000,
    coalesceMs: 0,
    setTimer: clock.set,
    clearTimer: clock.clear,
    ...extra,
  });
  return { r, factory };
}

export default async () => {
  await describe('WhatsApp manifest', async () => {
    await it('is a valid delivery-only manifest whose terms say plainly it is unofficial and can get the account banned', async () => {
      expect(validateManifest(WHATSAPP_MANIFEST).length).toBe(0);
      expect(WHATSAPP_MANIFEST.syncModel).toBe('delivery-only');
      const c = WHATSAPP_MANIFEST.capabilities;
      expect(c.e2ee && c.edits && c.reactions && c.groups && c.readReceipts && c.attachments).toBe(true);
      expect(c.subject || c.folders || c.threads).toBe(false);
      expect(WHATSAPP_MANIFEST.addressKinds.join(',')).toBe('whatsapp,phone');
      const terms = WHATSAPP_MANIFEST.terms?.summary ?? '';
      expect(terms.includes('UNOFFICIAL')).toBe(true);
      expect(terms.includes("violates WhatsApp's Terms of Service")).toBe(true);
      expect(terms.includes('ban')).toBe(true);
    });

    await it('takes only non-secret settings', async () => {
      expect(parseSettings({}).fullHistory).toBe(false);
      expect(parseSettings({ fullHistory: true }).fullHistory).toBe(true);
      expect(() => parseSettings({ creds: 'x' })).toThrow(/unknown setting/);
      expect(() => parseSettings({ fullHistory: 'yes' })).toThrow(/true or false/);
    });
  });

  await describe('WhatsApp identities', async () => {
    await it('parses JIDs with and without a device', async () => {
      expect(parseJid('4915100000001:12@s.whatsapp.net')?.device).toBe(12);
      expect(parseJid(GROUP)?.server).toBe('g.us');
      expect(parseJid('not a jid')).toBe(null);
    });

    await it('files one person under the LID once the pair is known, with the phone number as an address', async () => {
      const resolver = new JidResolver();
      expect(resolver.user(ANNA_PN)?.id).toBe(ANNA_PN);
      resolver.learn(ANNA_LID, ANNA_PN);
      const user = resolver.user(ANNA_PN);
      expect(user?.id).toBe(ANNA_LID);
      expect(user?.addresses.map((a) => `${a.kind}:${a.value}`)).toEqualArray([
        `whatsapp:${ANNA_LID}`,
        `whatsapp:${ANNA_PN}`,
        'phone:+4915100000001',
      ]);
      expect(resolver.chatId(ANNA_LID)).toBe(ANNA_LID);
      expect(resolver.chatId(GROUP)).toBe(GROUP);
    });

    await it("uses Baileys' stored LID mapping for pairs not seen in this run", async () => {
      const resolver = new JidResolver({
        lidForPn: (pn) => (pn === '4915100000001' ? '100000000000001' : null),
        pnForLid: () => null,
      });
      expect(resolver.chatId(ANNA_PN)).toBe(ANNA_LID);
    });

    await it('names an account by its LID, never by the phone number', async () => {
      expect(accountIdFromCreds({ me: ME })).toBe(ACCOUNT);
      expect(accountIdFromCreds({ me: { id: ME.id }, registrationId: 4711 })).toBe('whatsapp-4711');
    });
  });

  await describe('WhatsApp mapping', async () => {
    await it('extracts text, captions, files and replies through the wrappers', async () => {
      expect(extractContent(text('Hallo'))?.text).toBe('Hallo');
      const wrapped = unwrapContent({
        ephemeralMessage: {
          message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'Foto' } } } },
        },
      });
      expect(JSON.stringify(extractContent(wrapped))).toBe(
        JSON.stringify({ text: 'Foto', hasAttachments: true, replyTo: null }),
      );
      const doc = extractContent({ documentMessage: { fileName: 'plan.pdf' } });
      expect(doc?.text).toBe('plan.pdf');
      const reply = extractContent({
        extendedTextMessage: { text: 'genau', contextInfo: { stanzaId: 'X1' } },
      });
      expect(reply?.replyTo).toBe('X1');
      expect(extractContent({ reactionMessage: {} })).toBe(null);
      expect(
        extractContent({ locationMessage: { degreesLatitude: 52.5, degreesLongitude: 13.4 } })?.text,
      ).toBe('geo:52.5,13.4');
    });

    await it('maps incoming, own and group messages; drops stubs, reactions and status updates', async () => {
      const mapper = new WhatsAppMapper();
      const [direct] = mapper.message(
        waMessage(ANNA_LID, 'A1', 1_767_268_800, text('Hi'), { pushName: 'Anna', remoteJidAlt: ANNA_PN }),
        false,
      );
      expect(direct.type).toBe('message');
      if (direct.type !== 'message') return;
      expect(direct.chatRemoteId).toBe(ANNA_LID);
      expect(direct.message.remoteId).toBe('A1');
      expect(direct.message.sender?.displayName).toBe('Anna');
      expect(direct.message.sender?.addresses.some((a) => a.kind === 'phone')).toBe(true);
      expect(direct.message.sentAt).toBe('2026-01-01T12:00:00.000Z');
      // The PN-addressed chat of the same person now resolves to the same conversation.
      const [again] = mapper.message(waMessage(ANNA_PN, 'A2', 1_767_268_801, text('Du?')), false);
      expect(again.type === 'message' && again.chatRemoteId).toBe(ANNA_LID);

      const own = mapper.message(
        waMessage(ANNA_LID, 'A3', 1, text('Ja'), { fromMe: true, status: 4 }),
        false,
      );
      expect(own.map((e) => e.type).join(',')).toBe('message,peer-read');
      const [group] = mapper.message(
        waMessage(GROUP, 'G1', 2, text('Salat?'), { participant: BEN_LID, pushName: 'Ben' }),
        false,
      );
      expect(group.type === 'message' && group.chatKind).toBe('group');
      expect(group.type === 'message' && group.message.sender?.remoteId).toBe(BEN_LID);

      expect(mapper.message(waMessage(ANNA_LID, 'S1', 3, null, { messageStubType: 1 }), false).length).toBe(
        0,
      );
      expect(mapper.message(waMessage(ANNA_LID, 'R1', 3, { reactionMessage: {} }), false).length).toBe(0);
      expect(mapper.message(waMessage('status@broadcast', 'ST', 3, text('story')), false).length).toBe(0);
    });

    await it('turns revokes and edits into delete and edit events for the message they name', async () => {
      const mapper = new WhatsAppMapper();
      const [revoke] = mapper.message(
        waMessage(ANNA_LID, 'P1', 5, {
          protocolMessage: { type: 0, key: { remoteJid: ANNA_LID, id: 'A1' } },
        }),
        false,
      );
      expect(JSON.stringify(revoke)).toBe(
        JSON.stringify({ type: 'delete', chatRemoteId: ANNA_LID, remoteId: 'A1' }),
      );
      const [edit] = mapper.message(
        waMessage(ANNA_LID, 'P2', 6, {
          editedMessage: {
            message: {
              protocolMessage: {
                type: 14,
                key: { id: 'A1' },
                editedMessage: text('Neu'),
                timestampMs: 1_767_268_860_000,
              },
            },
          },
        }),
        false,
      );
      expect(JSON.stringify(edit)).toBe(
        JSON.stringify({
          type: 'edit',
          chatRemoteId: ANNA_LID,
          remoteId: 'A1',
          text: 'Neu',
          editedAt: '2026-01-01T12:01:00.000Z',
        }),
      );
    });

    await it('reads a history chunk: pairs first, oldest first, absolute unread counts last', async () => {
      const mapper = new WhatsAppMapper();
      const events = mapper.history({
        chats: [
          { id: ANNA_PN, name: 'Anna', unreadCount: 1 },
          { id: GROUP, name: 'Sommerfest', unreadCount: 0 },
        ],
        contacts: [{ id: ANNA_LID, phoneNumber: ANNA_PN, name: 'Anna Example' }],
        messages: [waMessage(ANNA_PN, 'H2', 20, text('zwei')), waMessage(ANNA_PN, 'H1', 10, text('eins'))],
        lidPnMappings: [{ lid: ANNA_LID, pn: ANNA_PN }],
      });
      const types = events.map((e) => e.type).join(',');
      expect(types).toBe('peer,chat,chat,message,message,chat-read,chat-read');
      const messages = events.filter(
        (e): e is Extract<DeliveryEvent, { type: 'message' }> => e.type === 'message',
      );
      expect(messages.map((m) => m.message.text).join(',')).toBe('eins,zwei');
      expect(messages.every((m) => m.chatRemoteId === ANNA_LID && m.seen)).toBe(true);
      // An update's positive count is Baileys' own increment, not a read state.
      expect(mapper.chat({ id: ANNA_LID, unreadCount: 3 }, false).some((e) => e.type === 'chat-read')).toBe(
        false,
      );
      expect(mapper.chat({ id: ANNA_LID, unreadCount: 0 }, false).some((e) => e.type === 'chat-read')).toBe(
        true,
      );
    });

    await it('maps "delete for me" and "clear chat" from another device', async () => {
      const mapper = new WhatsAppMapper();
      expect(mapper.deletion({ keys: [{ remoteJid: ANNA_LID, id: 'A1' }] })[0].type).toBe('delete');
      expect(mapper.deletion({ jid: ANNA_LID, all: true })[0].type).toBe('chat-cleared');
      expect(mapper.chatDeletion([GROUP])[0].type).toBe('chat-deleted');
    });
  });

  await describe('WhatsApp auth state', async () => {
    await it('round-trips creds and keys as TEXT, bytes included, in a 0600 file', async () => {
      const dir = tempDir();
      const path = join(dir, 'secrets', 'session.db');
      try {
        let store = SecretStore.open(path);
        let auth = SecretStoreAuthState.open(store, { flushDelayMs: 0 });
        expect(auth.registered).toBe(false);
        const identity = Buffer.from(auth.state.creds.signedIdentityKey.public).toString('hex');
        await auth.state.keys.set({
          session: { 'anna.0': new Uint8Array([1, 2, 3]) },
          'lid-mapping': { '4915100000001': '100000000000001', '100000000000001_reverse': '4915100000001' },
          'app-state-sync-key': { K1: { keyData: new Uint8Array([9]), timestamp: 1 } },
        });
        store.close();
        expect((statSync(path).mode & 0o777).toString(8)).toBe('600');

        store = SecretStore.open(path);
        auth = SecretStoreAuthState.open(store, { flushDelayMs: 0 });
        expect(Buffer.from(auth.state.creds.signedIdentityKey.public).toString('hex')).toBe(identity);
        const sessions = await auth.state.keys.get('session', ['anna.0', 'missing']);
        expect([...(sessions['anna.0'] as Uint8Array)].join(',')).toBe('1,2,3');
        expect('missing' in sessions).toBe(false);
        const appKey = (await auth.state.keys.get('app-state-sync-key', ['K1'])).K1;
        expect([...(appKey.keyData as Uint8Array)].join(',')).toBe('9');
        expect(auth.lidLookup().lidForPn('4915100000001')).toBe('100000000000001');
        expect(auth.lidLookup().pnForLid('100000000000001')).toBe('4915100000001');
        await auth.state.keys.set({ session: { 'anna.0': null } });
        store.close();
        store = SecretStore.open(path);
        expect(store.get('baileys.key.session', 'anna.0')).toBe(null);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('writes behind: many key updates become one write', async () => {
      const store = SecretStore.open(':memory:');
      const clock = new ManualClock();
      const auth = SecretStoreAuthState.open(store, {
        flushDelayMs: 500,
        setTimer: clock.set,
        clearTimer: clock.clear,
      });
      const before = auth.writes;
      for (let i = 0; i < 100; i++)
        await auth.state.keys.set({ session: { [`peer.${i}`]: new Uint8Array([i]) } });
      auth.saveCreds();
      expect(auth.writes).toBe(before);
      clock.advance(500);
      expect(auth.writes).toBe(before + 1);
      expect(store.load('baileys.key.session').size).toBe(100);
      auth.flush();
      expect(auth.writes).toBe(before + 1);
      store.close();
    });

    await it('the Signal curve agrees on a shared secret, whichever path libsignal takes (gjsify#1834)', async () => {
      const a = Curve.generateKeyPair();
      const b = Curve.generateKeyPair();
      const ab = Buffer.from(Curve.sharedKey(a.private, b.public)).toString('hex');
      const ba = Buffer.from(Curve.sharedKey(b.private, a.public)).toString('hex');
      expect(ab).toBe(ba);
      expect(ab.length).toBe(64);
    });
  });

  await describe('WhatsApp QR code', async () => {
    await it('renders two modules per character, with a quiet zone', async () => {
      const plain = renderModules(2, (r, c) => r === c, false).split('\n');
      // 2 modules + 2×4 quiet = 10 wide, 5 lines of two rows.
      expect(plain.length).toBe(5);
      expect(plain[0].length).toBe(10);
      expect(plain[2]).toBe('████▄▀████');
      const qr = renderQr('2@synthetic', false);
      expect(qr.split('\n').length > 10).toBe(true);
    });
  });

  await describe('WhatsApp receive path', async () => {
    await it('catches up: done after the offline queue, the history and a quiet period', async () => {
      const clock = new ManualClock();
      const { r, factory } = receiver(() => {}, clock);
      r.start();
      await tick();
      const socket = factory.sockets[0];
      socket.emit('connection.update', { connection: 'open' });
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [waMessage(ANNA_LID, 'H1', 1, text('alt'))],
        progress: 40,
      });
      socket.emit('connection.update', { receivedPendingNotifications: true });
      const first = await r.nextBatch();
      expect(first?.length).toBe(1);
      // History still running: the quiet period alone does not end it.
      clock.advance(5000);
      socket.emit('messaging-history.status', { syncType: 0, status: 'complete', explicit: true });
      socket.emit('messages.upsert', {
        messages: [waMessage(ANNA_LID, 'L1', 2, text('neu'))],
        type: 'notify',
      });
      const second = await r.nextBatch();
      expect(second?.length).toBe(1);
      expect(second?.[0].type === 'message' && second[0].seen).toBe(false);
      clock.advance(1000);
      expect(await r.nextBatch()).toBe(null);
      expect(JSON.stringify(r.outcome())).toBe(JSON.stringify({ caughtUp: true, error: null }));
      await r.close();
      expect(socket.ended).toBe(true);
      expect(socket.listenerCount()).toBe(0);
    });

    await it("on a new device, waits for the end of Baileys' first sync, however quiet it is", async () => {
      const clock = new ManualClock();
      const { r, factory } = receiver(() => {}, clock, { initialSync: true });
      r.start();
      await tick();
      const socket = factory.sockets[0];
      socket.emit('connection.update', { receivedPendingNotifications: true });
      // Baileys holds events back for up to 20 s here: silence is not the end.
      clock.advance(15_000);
      let ended = false;
      const next = r.nextBatch().then((b) => {
        ended = b === null;
      });
      await tick();
      expect(ended).toBe(false);
      socket.emit('creds.update', { accountSyncCounter: 1 });
      clock.advance(1000);
      await next;
      expect(ended).toBe(true);
      expect(r.outcome().caughtUp).toBe(true);
      await r.close();
    });

    await it('drains what Baileys still buffers before the socket closes — it was already acknowledged', async () => {
      const clock = new ManualClock();
      const { r, factory } = receiver(() => {}, clock, { initialSync: true });
      r.start();
      await tick();
      const socket = factory.sockets[0];
      socket.hold('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [waMessage(ANNA_LID, 'B1', 1, text('gepuffert'))],
      });
      // Give up waiting (maxMs) while Baileys still holds the history back.
      clock.advance(60_000);
      const batch = await r.nextBatch();
      expect(batch?.length).toBe(1);
      expect(await r.nextBatch()).toBe(null);
      expect(r.outcome().caughtUp).toBe(false);
      expect(socket.listenerCount()).toBe(0);
    });

    await it('stops at maxMs without claiming to be caught up', async () => {
      const clock = new ManualClock();
      const { r } = receiver(() => {}, clock);
      r.start();
      clock.advance(60_000);
      expect(await r.nextBatch()).toBe(null);
      expect(r.outcome().caughtUp).toBe(false);
      await r.close();
    });

    await it('reconnects a dropped connection, and gives up on a logout with a relink hint', async () => {
      const clock = new ManualClock();
      const drop = { error: Object.assign(new Error('lost'), { output: { statusCode: 408 } }) };
      const out = { error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }) };
      const { r, factory } = receiver(
        (s, i) => s.emit('connection.update', { connection: 'close', lastDisconnect: i === 0 ? drop : out }),
        clock,
      );
      r.start();
      await tick();
      await tick();
      expect(factory.sockets.length).toBe(2);
      expect(await r.nextBatch()).toBe(null);
      expect(r.outcome().error ?? '').toMatch(/logged this device out.*accounts add whatsapp/);
      await r.close();
    });

    await it('in follow mode, keeps going until closed', async () => {
      const clock = new ManualClock();
      const { r, factory } = receiver(() => {}, clock, { mode: 'follow' });
      r.start();
      await tick();
      factory.sockets[0].emit('connection.update', { receivedPendingNotifications: true });
      clock.advance(10 * 60_000);
      const pending = r.nextBatch();
      factory.sockets[0].emit('messages.upsert', {
        messages: [waMessage(ANNA_LID, 'F1', 1, text('x'))],
        type: 'notify',
      });
      expect((await pending)?.length).toBe(1);
      const last = r.nextBatch();
      await r.close();
      expect(await last).toBe(null);
    });
  });

  await describe('WhatsAppBackend', async () => {
    await it('links by QR code: the session lands 0600 under the LID account id, named without the number', async () => {
      const dir = tempDir();
      try {
        const { account, ask, factory } = await link(dir);
        expect(JSON.stringify(account)).toBe(
          JSON.stringify({ id: ACCOUNT, identity: 'Test Person', provider: 'WhatsApp' }),
        );
        expect(ask.asked.length).toBe(1);
        expect(ask.notes.some((n) => n.includes('█') && n.includes('Linked devices'))).toBe(true);
        expect(ask.notes.some((n) => n.includes('4915100000009'))).toBe(false);
        expect(factory.sockets.length).toBe(2);
        expect(factory.sockets.every((s) => s.ended)).toBe(true);
        const secrets = context(dir).secretsDir;
        expect(readdirSync(secrets).join(',')).toBe(`${ACCOUNT}.db`);
        expect((statSync(join(secrets, `${ACCOUNT}.db`)).mode & 0o777).toString(8)).toBe('600');
        const accounts = await new WhatsAppBackend(context(dir)).listAccounts();
        expect(accounts.map((a) => a.identity).join(',')).toBe('Test Person');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('links by pairing code when given a phone number', async () => {
      const dir = tempDir();
      try {
        const { ask, factory } = await link(dir, ['+49 151 0000 0009']);
        expect(factory.sockets[0].pairingRequests).toEqualArray(['4915100000009']);
        expect(ask.notes.some((n) => n.includes('ABCD1234'))).toBe(true);
        expect(() => parsePairingPhone('0151 123')).toThrow(/international/);
        expect(parsePairingPhone('  ')).toBe(null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('leaves no file behind when linking fails', async () => {
      const dir = tempDir();
      try {
        const factory = fakeFactory((s) =>
          s.emit('connection.update', {
            connection: 'close',
            lastDisconnect: {
              error: Object.assign(new Error('QR refs attempts ended'), { output: { statusCode: 408 } }),
            },
          }),
        );
        let message = '';
        try {
          await new WhatsAppBackend(context(dir), { createSocket: factory.create }).addAccount(
            prompter(['']),
          );
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toMatch(/nothing was saved/);
        expect(readdirSync(context(dir).secretsDir).length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('sweeps a stale pending link, keeps a fresh one, lists neither', async () => {
      const dir = tempDir();
      try {
        const secrets = context(dir).secretsDir;
        mkdirSync(secrets, { recursive: true });
        const stale = join(secrets, 'link-1-1.pending.db');
        const fresh = join(secrets, 'link-2-2.pending.db');
        writeFileSync(stale, '');
        writeFileSync(fresh, '');
        const old = (Date.now() - PENDING_STALE_MS - 60_000) / 1000;
        utimesSync(stale, old, old);
        expect((await new WhatsAppBackend(context(dir)).listAccounts()).length).toBe(0);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a session that was never linked, and a missing one', async () => {
      const dir = tempDir();
      try {
        const backend = new WhatsAppBackend(context(dir));
        let message = '';
        await backend.connect(ACCOUNT, { mode: 'catch-up' }).catch((err: Error) => {
          message = err.message;
        });
        expect(message).toMatch(/accounts add whatsapp/);
        const store = SecretStore.open(join(context(dir).secretsDir, `${ACCOUNT}.db`));
        store.close();
        message = '';
        await backend.connect(ACCOUNT, { mode: 'catch-up' }).catch((err: Error) => {
          message = err.message;
        });
        expect(message).toMatch(/never linked/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('syncs through the port into conversations: history, live messages, an edit and a revoke', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const factory = fakeFactory((s) => {
          s.emit('connection.update', { connection: 'open' });
          s.emit('messaging-history.set', {
            chats: [
              { id: ANNA_LID, pnJid: ANNA_PN, name: 'Anna', unreadCount: 1 },
              { id: GROUP, name: 'Sommerfest', unreadCount: 0 },
            ],
            contacts: [{ id: ANNA_LID, phoneNumber: ANNA_PN, name: 'Anna Example' }],
            messages: [
              waMessage(ANNA_LID, 'H2', 1_767_268_802, text('Super')),
              waMessage(ANNA_LID, 'H1', 1_767_268_801, text('Ja'), { fromMe: true, status: 4 }),
              waMessage(ANNA_PN, 'H0', 1_767_268_800, text('Kommst du?')),
              waMessage(GROUP, 'G1', 1_767_268_800, text('Wer bringt Salat?'), {
                participant: BEN_LID,
                pushName: 'Ben',
              }),
            ],
            progress: 100,
          });
          s.emit('connection.update', { receivedPendingNotifications: true });
          // Baileys' end of a new device's first sync.
          s.emit('creds.update', { accountSyncCounter: 1 });
          s.emit('messages.upsert', {
            type: 'append',
            messages: [
              waMessage(GROUP, 'G2', 1_767_268_900, text('Ich!'), { participant: BEN_LID }),
              waMessage(
                GROUP,
                'P1',
                1_767_268_901,
                { protocolMessage: { type: 0, key: { id: 'G1' } } },
                { participant: BEN_LID },
              ),
              waMessage(ANNA_LID, 'P2', 1_767_268_902, {
                protocolMessage: { type: 14, key: { id: 'H2' }, editedMessage: text('Super!') },
              }),
            ],
          });
        });
        const backend = new WhatsAppBackend(context(dir), {
          createSocket: factory.create,
          receiver: { quietMs: 30, coalesceMs: 5, maxMs: 5000 },
          flushDelayMs: 10,
        });
        expect(isDeliveryBackend(backend)).toBe(true);
        const result = await receiveDeliveries(db, backend);
        expect(result.errors).toBe(0);
        expect(result.accounts[0].caughtUp).toBe(true);
        expect(factory.sockets[0].ended).toBe(true);
        rebuildConversations(db, {
          contacts: [{ uid: 'c-anna', name: 'Anna E.', org: null, emails: [], phones: ['+49 151 00000001'] }],
        });
        const all = listConversations(db);
        expect(all.length).toBe(2);
        expect(all.every((c) => c.backend === 'whatsapp' && c.accountId === ACCOUNT)).toBe(true);
        const direct = getConversation(db, chatConversationId('whatsapp', ACCOUNT, ANNA_LID), {
          includeBodies: true,
        });
        // One person, one chat — though one history message named the phone-number JID.
        expect(direct?.messages.map((m) => m.bodyText).join('|')).toBe('Kommst du?|Ja|Super!');
        expect(direct?.messages[1].readByPeer).toBe(true);
        expect(direct?.conversation.participants[0].contactUid).toBe('c-anna');
        expect(direct?.conversation.unreadCount).toBe(1);
        const group = getConversation(db, chatConversationId('whatsapp', ACCOUNT, GROUP), {
          includeBodies: true,
        });
        expect(group?.conversation.title).toBe('Sommerfest');
        expect(group?.messages.map((m) => m.bodyText).join('|')).toBe('Ich!');
        // The ratchet state of the run reached the session file.
        const store = SecretStore.open(join(context(dir).secretsDir, `${ACCOUNT}.db`));
        expect(store.get('baileys.creds', 'creds') !== null).toBe(true);
        store.close();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('WhatsApp receive journal', async () => {
    await it('is durable before the handler returns, skips a torn tail, and keeps what came after a release', async () => {
      const dir = tempDir();
      const path = join(dir, 'secrets', 'a.journal');
      try {
        const journal = FileJournal.open(path);
        const clock = new ManualClock();
        const factory = fakeFactory(() => {});
        const r = new WhatsAppReceiver(() => factory.create({ auth: null as never }), new WhatsAppMapper(), {
          mode: 'follow',
          coalesceMs: 0,
          journal,
          setTimer: clock.set,
          clearTimer: clock.clear,
        });
        r.start();
        await tick();
        factory.sockets[0].emit('messages.upsert', {
          messages: [waMessage(ANNA_LID, 'J1', 1, text('eins'))],
          type: 'notify',
        });
        // On disk the moment the handler returned — before anyone asked for a batch.
        expect(readFileSync(path, 'utf8').includes('"J1"')).toBe(true);
        expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
        expect((await r.nextBatch())?.length).toBe(1);
        factory.sockets[0].emit('messages.upsert', {
          messages: [waMessage(ANNA_LID, 'J2', 2, text('zwei'))],
          type: 'notify',
        });
        // Asking again acknowledges J1: it leaves the journal, J2 (not handed out yet) stays.
        const next = await r.nextBatch();
        expect(next?.length).toBe(1);
        const kept = readFileSync(path, 'utf8');
        expect(kept.includes('"J1"')).toBe(false);
        expect(kept.includes('"J2"')).toBe(true);
        await r.close();
        // Closed without another nextBatch(): J2 may not be written, so it stays for replay.
        writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"mess`);
        const reopened = FileJournal.open(path);
        expect(reopened.recovered.length).toBe(1);
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('a crash between receipt and the index write loses nothing, and replay stores each message once', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const script = (messages: WaMessage[]) =>
          fakeFactory((s) => {
            s.emit('connection.update', { connection: 'open' });
            if (messages.length > 0) s.emit('messages.upsert', { type: 'append', messages });
            s.emit('connection.update', { receivedPendingNotifications: true });
            s.emit('creds.update', { accountSyncCounter: 1 });
          });
        const backend = (factory: ReturnType<typeof script>) =>
          new WhatsAppBackend(context(dir), {
            createSocket: factory.create,
            receiver: { quietMs: 20, coalesceMs: 0, maxMs: 5000 },
            flushDelayMs: 10,
          });
        const journal = journalPath(join(context(dir).secretsDir, `${ACCOUNT}.db`));
        // Run 1 "crashes": the index write throws after WhatsApp already delivered (and forgot) both.
        const prepare = db.prepare.bind(db);
        let crash = true;
        (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
          if (crash && sql.includes('INSERT OR REPLACE INTO conversation_messages'))
            throw new Error('simulated crash');
          return prepare(sql);
        }) as typeof db.prepare;
        const first = await receiveDeliveries(
          db,
          backend(
            script([
              waMessage(ANNA_LID, 'C1', 10, text('eins')),
              waMessage(ANNA_LID, 'C2', 11, text('zwei')),
            ]),
          ),
        );
        expect(first.accounts[0].error ?? '').toMatch(/simulated crash/);
        expect(listConversations(db).length).toBe(0);
        expect(readFileSync(journal, 'utf8').includes('"C2"')).toBe(true);
        // Run 2: WhatsApp has nothing left to send; the journal has it.
        crash = false;
        const second = await receiveDeliveries(
          db,
          backend(script([waMessage(ANNA_LID, 'C3', 12, text('drei'))])),
        );
        expect(second.errors).toBe(0);
        const conv = getConversation(db, chatConversationId('whatsapp', ACCOUNT, ANNA_LID), {
          includeBodies: true,
        });
        expect(conv?.messages.map((m) => m.bodyText).join('|')).toBe('eins|zwei|drei');
        expect(statSync(journal).size).toBe(0);
        // A crash after the commit but before the journal was trimmed: replaying stores nothing twice.
        const replay = new WhatsAppMapper().message(waMessage(ANNA_LID, 'C1', 10, text('eins')), false);
        writeFileSync(journal, `${replay.map((e) => JSON.stringify(e)).join('\n')}\n`);
        await receiveDeliveries(db, backend(script([])));
        expect(
          getConversation(db, chatConversationId('whatsapp', ACCOUNT, ANNA_LID))?.conversation.messageCount,
        ).toBe(3);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('a chat first seen under the phone number merges into the LID chat once the pair is learned', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await link(dir);
        const factory = fakeFactory((s) => {
          s.emit('connection.update', { connection: 'open' });
          s.emit('messages.upsert', {
            type: 'append',
            messages: [waMessage(ANNA_PN, 'M1', 10, text('per Nummer'))],
          });
          s.emit('connection.update', { receivedPendingNotifications: true });
          s.emit('creds.update', { accountSyncCounter: 1 });
        });
        const backend = (f: typeof factory) =>
          new WhatsAppBackend(context(dir), {
            createSocket: f.create,
            receiver: { quietMs: 20, coalesceMs: 0, maxMs: 5000 },
            flushDelayMs: 10,
          });
        await receiveDeliveries(db, backend(factory));
        expect(listConversations(db).length).toBe(1);
        // Next run: the pair arrives mid-sync, then a message under the LID and a revoke of M1 by it.
        const flip = fakeFactory((s) => {
          s.emit('connection.update', { connection: 'open' });
          s.emit('lid-mapping.update', { lid: ANNA_LID, pn: ANNA_PN });
          s.emit('messages.upsert', {
            type: 'notify',
            messages: [waMessage(ANNA_LID, 'M2', 20, text('per LID'))],
          });
          s.emit('connection.update', { receivedPendingNotifications: true });
          s.emit('creds.update', { accountSyncCounter: 1 });
        });
        await receiveDeliveries(db, backend(flip));
        const all = listConversations(db);
        expect(all.length).toBe(1);
        const merged = getConversation(db, chatConversationId('whatsapp', ACCOUNT, ANNA_LID), {
          includeBodies: true,
        });
        expect(merged?.messages.map((m) => m.bodyText).join('|')).toBe('per Nummer|per LID');
        const cursors = db.prepare('SELECT chat_id, last_seq FROM chat_cursors').all() as Array<
          Record<string, unknown>
        >;
        expect(cursors.map((c) => `${c.chat_id}:${c.last_seq}`).join(',')).toBe(`${ANNA_LID}:20`);
        // A later revoke addressed under the LID reaches the merged message.
        const revoke = fakeFactory((s) => {
          s.emit('messages.upsert', {
            type: 'notify',
            messages: [waMessage(ANNA_LID, 'P9', 30, { protocolMessage: { type: 0, key: { id: 'M1' } } })],
          });
          s.emit('connection.update', { receivedPendingNotifications: true });
          s.emit('creds.update', { accountSyncCounter: 1 });
        });
        await receiveDeliveries(db, backend(revoke));
        const after = getConversation(db, chatConversationId('whatsapp', ACCOUNT, ANNA_LID), {
          includeBodies: true,
        });
        expect(after?.messages.map((m) => m.bodyText).join('|')).toBe('per LID');
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
