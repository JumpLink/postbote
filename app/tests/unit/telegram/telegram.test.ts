import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, ChatBackend } from '@postbote/protocol';
import { isChatBackend, validateManifest } from '@postbote/protocol';
import {
  chatConversationId,
  getConversation,
  listConversations,
  rebuildConversations,
  SecretStore,
  syncChats,
} from '@postbote/store';
import {
  API_HASH_ENV,
  API_ID_ENV,
  identityOf,
  peerAddresses,
  resolveCredentials,
  SecretStoreStorage,
  TELEGRAM_MANIFEST,
  TelegramBackend,
  TelegramChatSession,
  toChatInfo,
  toChatMessage,
} from '@postbote/telegram';
import { conversationsList, conversationsShow, openIndex } from '../../../src/core/actions/index.ts';
import { telegramFixture } from '../store/chat-fixtures.ts';
import { freshDb } from '../store/fixtures.ts';
import { fakeFactory, group, ME, tgMessage, user } from './fake-client.ts';

/**
 * The Telegram backend without Telegram: mapping of mtcute's shapes, the chat session over a fake
 * client, the session storage on postbote's SQLite, the login flow and what it leaves on disk,
 * and a full sync through the backend into the conversation view. All data is synthetic.
 */

const HASH = '0123456789abcdef0123456789abcdef';
const ANNA = user(1001, 'Anna Example', { username: 'Anna_Example', phoneNumber: '491510000000' });
const BEN = user(1002, 'Ben Example');
const BOT = user(1003, 'Helper Bot', { username: 'helper_bot', isBot: true });
const ORGA = group(-1004001, 'Sommerfest Orga');
const NEWS = group(-1005000, 'Example News', 'channel', 'example_news');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postbote-telegram-'));
}

function context(dir: string, env: Record<string, string | undefined> = {}): BackendContext {
  return {
    settings: { apiId: 12345, apiHash: HASH },
    env,
    secretsDir: join(dir, 'secrets', 'telegram'),
  };
}

function prompter(answers: string[]): AccountPrompter & { asked: string[]; notes: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    async ask(label, options) {
      asked.push(`${label}${options?.secret ? ' (secret)' : ''}`);
      const next = queue.shift();
      if (next === undefined) throw new Error('no answer left');
      return next;
    },
    notify: (message) => notes.push(message),
  };
}

export default async () => {
  await describe('Telegram manifest', async () => {
    await it('is a valid server-archive chat manifest with truthful capabilities', async () => {
      expect(validateManifest(TELEGRAM_MANIFEST).length).toBe(0);
      expect(TELEGRAM_MANIFEST.syncModel).toBe('server-archive');
      expect(TELEGRAM_MANIFEST.capabilities.e2ee).toBe(false);
      expect(TELEGRAM_MANIFEST.capabilities.subject).toBe(false);
      expect(TELEGRAM_MANIFEST.capabilities.edits && TELEGRAM_MANIFEST.capabilities.readReceipts).toBe(true);
      expect(TELEGRAM_MANIFEST.addressKinds.join(',')).toBe('telegram,phone');
      expect(TELEGRAM_MANIFEST.terms?.summary.includes('api_id')).toBe(true);
    });
  });

  await describe('Telegram credentials', async () => {
    await it('reads the config settings, and the environment wins', async () => {
      const fromConfig = resolveCredentials({
        settings: { apiId: '777', apiHash: HASH.toUpperCase() },
        env: {},
      });
      expect(fromConfig.apiId).toBe(777);
      expect(fromConfig.apiHash).toBe(HASH);
      const fromEnv = resolveCredentials({
        settings: { apiId: 777, apiHash: HASH },
        env: { [API_ID_ENV]: '888', [API_HASH_ENV]: 'ffffffffffffffffffffffffffffffff' },
      });
      expect(fromEnv.apiId).toBe(888);
    });

    await it('refuses without them, and never echoes a bad hash', async () => {
      expect(() => resolveCredentials({ settings: {}, env: {} })).toThrow(/my\.telegram\.org/);
      let message = '';
      try {
        resolveCredentials({ settings: { apiId: 1, apiHash: 'not-a-hash-secret-value' }, env: {} });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/32 hexadecimal/);
      expect(message.includes('not-a-hash-secret-value')).toBe(false);
    });
  });

  await describe('Telegram mapping', async () => {
    await it('gives a user their id, handle and international phone number', async () => {
      const addresses = peerAddresses(ANNA).map((a) => `${a.kind}:${a.value}`);
      expect(addresses).toEqualArray(['telegram:1001', 'telegram:anna_example', 'phone:+491510000000']);
      // A channel has no user id to address; its public handle is its address.
      expect(peerAddresses(NEWS).map((a) => a.value)).toEqualArray(['example_news']);
      expect(peerAddresses(ORGA).length).toBe(0);
    });

    await it('maps dialogs to direct, group and broadcast chats with their read markers', async () => {
      const direct = toChatInfo({
        peer: ANNA,
        lastMessage: tgMessage(ANNA, 7, ANNA, 'x'),
        lastReadIngoing: 5,
        lastReadOutgoing: 6,
      });
      expect(direct.kind).toBe('direct');
      expect(direct.remoteId).toBe('1001');
      expect(direct.members[0].remoteId).toBe('1001');
      expect(direct.lastSeq).toBe(7);
      expect(direct.readInboxSeq).toBe(5);
      expect(direct.readOutboxSeq).toBe(6);
      expect(
        toChatInfo({ peer: ORGA, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 }).kind,
      ).toBe('group');
      expect(
        toChatInfo({ peer: NEWS, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 }).kind,
      ).toBe('broadcast');
      // Saved Messages is a chat with yourself: nobody else is in it.
      expect(
        toChatInfo({ peer: ME, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 }).members.length,
      ).toBe(0);
    });

    await it('maps messages: own, attachments, link previews, replies, topics, service notices', async () => {
      const mine = toChatMessage(tgMessage(ANNA, 3, 'me', 'hi'));
      expect(mine?.fromSelf).toBe(true);
      expect(mine?.sender).toBe(null);
      expect(mine?.remoteId).toBe('1001/3');
      const photo = toChatMessage(tgMessage(ANNA, 4, ANNA, '', { media: { type: 'photo' } }));
      expect(photo?.hasAttachments).toBe(true);
      expect(photo?.text).toBe(null);
      const link = toChatMessage(tgMessage(ANNA, 5, ANNA, 'see', { media: { type: 'webpage' } }));
      expect(link?.hasAttachments).toBe(false);
      const topic = toChatMessage(
        tgMessage(ORGA, 20, BEN, 'im Thema', {
          replyToMessage: { id: 18, threadId: 15 },
          isTopicMessage: true,
          editDate: new Date('2026-08-01T12:00:00Z'),
        }),
      );
      expect(topic?.replyToRemoteId).toBe('-1004001/18');
      expect(topic?.threadRemoteId).toBe('-1004001/15');
      expect(topic?.editedAt).toBe('2026-08-01T12:00:00.000Z');
      expect(toChatMessage(tgMessage(ORGA, 21, BEN, '', { isService: true }))).toBe(null);
      const anonymous = toChatMessage(tgMessage(ORGA, 22, BEN, 'anon', { sender: { type: 'anonymous' } }));
      expect(anonymous?.sender).toBe(null);
      expect(anonymous?.fromSelf).toBe(false);
    });

    await it('never lists a phone number as the account identity', async () => {
      expect(identityOf(ME)).toBe('@me_example');
      expect(identityOf(user(9, 'Nur Name'))).toBe('Nur Name');
    });
  });

  await describe('TelegramChatSession', async () => {
    const history = new Map([
      [
        -1004001,
        [
          tgMessage(ORGA, 1, BEN, 'eins'),
          tgMessage(ORGA, 2, BEN, '', { isService: true }),
          tgMessage(ORGA, 3, ANNA, 'drei'),
          tgMessage(ORGA, 4, BEN, 'vier'),
        ],
      ],
    ]);

    await it('takes the newest window, oldest first, service notices out but counted in the cursor', async () => {
      const { create } = fakeFactory({ history });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const session = new TelegramChatSession(client);
      const page = await session.fetchHistory('-1004001', null, 3);
      expect(page.messages.map((m) => m.seq)).toEqualArray([3, 4]);
      expect(page.highestSeq).toBe(4);
      expect(page.exhausted).toBe(true);
    });

    await it('walks forward strictly after the cursor, asking mtcute for the offset + 1', async () => {
      const { create } = fakeFactory({ history });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const session = new TelegramChatSession(client);
      const page = await session.fetchHistory('-1004001', 1, 2);
      // #2 is a service notice: not a message, but the cursor moves past it.
      expect(page.messages.map((m) => m.seq)).toEqualArray([3]);
      expect(page.highestSeq).toBe(3);
      expect(page.exhausted).toBe(false);
      expect(client.calls.includes('getHistory:-1004001:rev@2:2')).toBe(true);
      const rest = await session.fetchHistory('-1004001', 3, 2);
      expect(rest.messages.map((m) => m.seq)).toEqualArray([4]);
      expect(rest.exhausted).toBe(true);
    });
  });

  await describe('Telegram session storage', async () => {
    await it('persists auth keys at once and everything else on save, as TEXT', async () => {
      const dir = tempDir();
      const path = join(dir, 's', 'telegram-1.db');
      try {
        const store = SecretStore.open(path);
        const storage = new SecretStoreStorage(store);
        await storage.driver.load();
        await storage.authKeys.set(2, new Uint8Array([0, 1, 254, 255]));
        // Written immediately — mtcute's contract for auth keys.
        const probe = SecretStore.open(path);
        expect(probe.load('mtcute.auth_keys').get('2')).toBe('AAH+/w==');
        probe.close();

        await storage.kv.set('self', new Uint8Array([7, 7]));
        await storage.peers.store({
          id: 1001,
          accessHash: '123456789',
          isMin: false,
          usernames: ['anna_example'],
          updated: 1,
          phone: '491510000000',
          complete: new Uint8Array([9, 8, 7]),
        });
        await storage.refMessages.store(1001, -1004001, 3);
        await storage.driver.save();
        store.close();
        expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
        expect((statSync(join(dir, 's')).mode & 0o777).toString(8)).toBe('700');

        const reopened = new SecretStoreStorage(SecretStore.open(path));
        await reopened.driver.load();
        expect([...((await reopened.authKeys.get(2)) ?? [])]).toEqualArray([0, 1, 254, 255]);
        expect([...((await reopened.kv.get('self')) ?? [])]).toEqualArray([7, 7]);
        const anna = await reopened.peers.getByUsername('anna_example');
        expect(anna?.accessHash).toBe('123456789');
        expect([...(anna?.complete ?? [])]).toEqualArray([9, 8, 7]);
        expect((await reopened.peers.getByPhone('491510000000'))?.id).toBe(1001);
        expect((await reopened.refMessages.getByPeer(1001))?.join(',')).toBe('-1004001,3');

        // Deletions are persisted too.
        await reopened.authKeys.deleteAll();
        await reopened.kv.delete('self');
        await reopened.driver.save();
        const after = SecretStore.open(path);
        expect(after.load('mtcute.auth_keys').size).toBe(0);
        expect(after.load('mtcute.kv').size).toBe(0);
        after.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('writes nothing when nothing changed', async () => {
      const store = SecretStore.open(':memory:');
      let applied = 0;
      const apply = store.apply.bind(store);
      store.apply = (changes) => {
        applied += changes.length;
        apply(changes);
      };
      const storage = new SecretStoreStorage(store);
      await storage.driver.load();
      await storage.kv.set('a', new Uint8Array([1]));
      await storage.driver.save();
      expect(applied).toBe(1);
      await storage.driver.save();
      expect(applied).toBe(1);
      store.close();
    });
  });

  await describe('Telegram in the frontends', async () => {
    await it('the conversation actions (CLI and MCP) list and show chats with no branching', async () => {
      const dir = tempDir();
      const dbPath = join(dir, 'index.db');
      const configPath = join(dir, 'config.json');
      try {
        const db = openIndex(dbPath);
        await syncChats(db, telegramFixture());
        rebuildConversations(db);
        db.close();
        const listed = conversationsList({ dbPath, configPath, peopleOnly: true });
        expect(listed.count).toBe(2);
        expect(listed.indexedAt !== null).toBe(true);
        const shown = conversationsShow({
          id: listed.conversations[0].id,
          dbPath,
          configPath,
          includeBodies: true,
        });
        expect(
          shown.messages.every((m) => m.presentation === 'bubble' && typeof m.ref.remoteId === 'string'),
        ).toBe(true);
        expect(shown.messages.some((m) => typeof m.bodyText === 'string')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('TelegramBackend', async () => {
    await it('logs in: asks phone, code, password; keeps the session under the account id', async () => {
      const dir = tempDir();
      try {
        const factory = fakeFactory({});
        const backend = new TelegramBackend(context(dir), factory.create);
        const ask = prompter(['+49 170 0000000', '12345', 'correct horse']);
        const account = await backend.addAccount(ask);
        expect(account.id).toBe('telegram-42');
        expect(account.identity).toBe('@me_example');
        expect(ask.asked[2].endsWith('(secret)')).toBe(true);
        const files = readdirSync(context(dir).secretsDir);
        expect(files).toEqualArray(['telegram-42.db']);
        expect((statSync(join(context(dir).secretsDir, 'telegram-42.db')).mode & 0o777).toString(8)).toBe(
          '600',
        );
        const accounts = await backend.listAccounts();
        expect(accounts.map((a) => `${a.id} ${a.identity}`)).toEqualArray(['telegram-42 @me_example']);
        // The account list carries no phone number anywhere.
        expect(JSON.stringify(accounts).includes('4917')).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('leaves no file behind when the login fails', async () => {
      const dir = tempDir();
      try {
        const backend = new TelegramBackend(context(dir), fakeFactory({}).create);
        await expect(backend.addAccount(prompter(['+49 170 0000000', '12345', 'wrong']))).rejects.toThrow(
          /PASSWORD_HASH_INVALID/,
        );
        expect(readdirSync(context(dir).secretsDir).length).toBe(0);
        expect((await backend.listAccounts()).length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses to log in without api credentials, before asking anything', async () => {
      const dir = tempDir();
      try {
        const backend = new TelegramBackend({ ...context(dir), settings: {} }, fakeFactory({}).create);
        const ask = prompter([]);
        await expect(backend.addAccount(ask)).rejects.toThrow(/api_id/);
        expect(ask.asked.length).toBe(0);
        expect(existsSync(context(dir).secretsDir)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('turns a revoked session into one clear re-login message', async () => {
      const dir = tempDir();
      try {
        await new TelegramBackend(context(dir), fakeFactory({}).create).addAccount(
          prompter(['+49 170 0000000', '12345', 'correct horse']),
        );
        const revoked = fakeFactory({ unauthorized: true });
        const backend = new TelegramBackend(context(dir), revoked.create);
        await expect(backend.connect('telegram-42')).rejects.toThrow(/accounts add telegram/);
        expect(revoked.clients[0].destroyed).toBe(1);
        await expect(backend.connect('telegram-7')).rejects.toThrow(/no Telegram session/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('syncs through the port into conversations — no Telegram-specific reads', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await new TelegramBackend(context(dir), fakeFactory({}).create).addAccount(
          prompter(['+49 170 0000000', '12345', 'correct horse']),
        );
        const script = {
          dialogs: [
            {
              peer: ORGA,
              lastMessage: tgMessage(ORGA, 12, ANNA, 'x'),
              lastReadIngoing: 12,
              lastReadOutgoing: 0,
            },
            {
              peer: ANNA,
              lastMessage: tgMessage(ANNA, 3, ANNA, 'x'),
              lastReadIngoing: 2,
              lastReadOutgoing: 2,
            },
            {
              peer: NEWS,
              lastMessage: tgMessage(NEWS, 500, NEWS, 'x'),
              lastReadIngoing: 0,
              lastReadOutgoing: 0,
            },
          ],
          history: new Map([
            [
              ANNA.id,
              [
                tgMessage(ANNA, 1, ANNA, 'Kommst du am Samstag?'),
                tgMessage(ANNA, 2, 'me', 'Ja, gerne'),
                tgMessage(ANNA, 3, ANNA, 'Super', { media: { type: 'photo' } }),
              ],
            ],
            [
              ORGA.id,
              [
                tgMessage(ORGA, 10, BEN, 'Wer bringt Salat?'),
                tgMessage(ORGA, 11, BOT, 'Umfrage'),
                tgMessage(ORGA, 12, ANNA, 'Ich'),
              ],
            ],
            [NEWS.id, [tgMessage(NEWS, 500, NEWS, 'Neue Ausgabe')]],
          ]),
        };
        const backend: ChatBackend = new TelegramBackend(context(dir), fakeFactory(script).create);
        expect(isChatBackend(backend)).toBe(true);
        const result = await syncChats(db, backend);
        expect(result.added).toBe(7);
        rebuildConversations(db, {
          contacts: [{ uid: 'c-anna', name: 'Anna E.', org: null, emails: [], phones: ['+49 151 0000000'] }],
        });
        const all = listConversations(db);
        expect(all.length).toBe(3);
        expect(all.every((c) => c.backend === 'telegram' && c.accountId === 'telegram-42')).toBe(true);
        const direct = getConversation(db, chatConversationId('telegram', 'telegram-42', '1001'));
        expect(direct?.conversation.participants[0].contactUid).toBe('c-anna');
        expect(direct?.conversation.unreadCount).toBe(1);
        expect(direct?.messages.map((m) => m.presentation).join(',')).toBe('bubble,bubble,bubble');
        const people = listConversations(db, { peopleOnly: true });
        expect(people.some((c) => c.title === 'Example News')).toBe(false);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
