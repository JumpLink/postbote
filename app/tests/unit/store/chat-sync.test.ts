import { describe, expect, it } from '@gjsify/unit';

import type { ContactDTO } from '@postbote/protocol';
import {
  chatConversationId,
  deletedBy,
  getConversation,
  listConversations,
  rebuildConversations,
  syncChats,
  syncIndex,
  syncStatus,
} from '@postbote/store';
import { BEN, chatMessage, FakeChatBackend, telegramFixture } from './chat-fixtures.ts';
import { AT, FakeBackend, freshDb, message } from './fixtures.ts';

/**
 * The chat sync engine against a fake chat network, and chats in the conversation view next to
 * mail: windowed first sync, forward walk, the per-run budget, read state, and the participant
 * directory that turns a Telegram peer with a known phone number into the address-book contact.
 * All content is synthetic.
 */

const ACCOUNT = 'telegram-42';
const DIRECT = chatConversationId('telegram', ACCOUNT, '1001');
const GROUP = chatConversationId('telegram', ACCOUNT, '-4001');
const CHANNEL = chatConversationId('telegram', ACCOUNT, '-1005000');

const CONTACTS: ContactDTO[] = [
  {
    uid: 'contact-anna',
    name: 'Anna E.',
    org: null,
    emails: ['anna@example.org'],
    phones: ['+49 151 0000000'],
  },
];

function count(db: ReturnType<typeof freshDb>, sql: string, ...params: string[]): number {
  const row = db.prepare(sql).get(...params) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export default async () => {
  await describe('syncChats', async () => {
    await it('writes every chat as a conversation of bubbles, with the network ids', async () => {
      const db = freshDb();
      try {
        const result = await syncChats(db, telegramFixture(), { now: AT('2026-08-06T12:00:00Z') });
        expect(result.added).toBe(7);
        expect(result.errors).toBe(0);
        expect(result.accounts[0].chats).toBe(3);
        rebuildConversations(db);
        const direct = getConversation(db, DIRECT);
        expect(direct?.conversation.backend).toBe('telegram');
        expect(direct?.conversation.kind).toBe('direct');
        expect(direct?.messages.length).toBe(3);
        const [first, mine] = direct?.messages ?? [];
        expect(first.presentation).toBe('bubble');
        expect(first.ref.remoteId).toBe('1001/1');
        expect(first.ref.folder === undefined && first.ref.uid === undefined).toBe(true);
        expect(first.senderAddress?.kind).toBe('telegram');
        expect(first.senderAddress?.value).toBe('1001');
        expect(mine.fromSelf).toBe(true);
        expect(mine.senderId).toBe(null);
        expect(getConversation(db, GROUP)?.conversation.kind).toBe('group');
      } finally {
        db.close();
      }
    });

    await it('returns bodies only when asked, capped like mail', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture());
        const bare = getConversation(db, DIRECT);
        expect(bare?.messages[0].bodyText).toBe(undefined);
        const full = getConversation(db, DIRECT, { includeBodies: true, maxBodyChars: 5 });
        expect(full?.messages[0].bodyText).toBe('Komms');
        expect(full?.messages[0].bodyTruncated).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('takes a window on the first sync and walks forward afterwards, without a gap', async () => {
      const backend = new FakeChatBackend();
      backend.addChat({ remoteId: '1002', kind: 'direct', title: 'Ben', members: [BEN] });
      for (let seq = 1; seq <= 30; seq++) backend.post('1002', chatMessage('1002', seq, BEN, `m${seq}`));
      const db = freshDb();
      try {
        await syncChats(db, backend, { historyDepth: 10 });
        const id = chatConversationId('telegram', ACCOUNT, '1002');
        let messages = getConversation(db, id)?.messages ?? [];
        // The newest ten — older history stays on the server.
        expect(messages.length).toBe(10);
        expect(messages[0].ref.remoteId).toBe('1002/21');

        for (let seq = 31; seq <= 55; seq++) backend.post('1002', chatMessage('1002', seq, BEN, `m${seq}`));
        backend.calls.length = 0;
        const second = await syncChats(db, backend, { historyDepth: 10, pageSize: 10 });
        expect(second.added).toBe(25);
        // Three pages forward from the cursor: 10 + 10 + 5.
        expect(backend.calls.join(' ')).toBe('1002:30:10 1002:40:10 1002:50:10');
        messages = getConversation(db, id)?.messages ?? [];
        expect(messages.length).toBe(35);
        expect(messages[messages.length - 1].ref.remoteId).toBe('1002/55');

        backend.calls.length = 0;
        const third = await syncChats(db, backend);
        // Caught up: no fetch at all.
        expect(third.added).toBe(0);
        expect(backend.calls.length).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('stops at the per-run budget and continues on the next run', async () => {
      const backend = new FakeChatBackend();
      backend.addChat({ remoteId: '1002', kind: 'direct', title: 'Ben', members: [BEN] });
      backend.post('1002', chatMessage('1002', 1, BEN, 'hallo'));
      const db = freshDb();
      try {
        await syncChats(db, backend);
        for (let seq = 2; seq <= 21; seq++) backend.post('1002', chatMessage('1002', seq, BEN, `m${seq}`));
        const capped = await syncChats(db, backend, { maxMessages: 8, pageSize: 5 });
        expect(capped.added).toBe(8);
        expect(capped.budgetExhausted).toBe(true);
        const resumed = await syncChats(db, backend, { maxMessages: 100 });
        expect(resumed.added).toBe(12);
        expect(resumed.budgetExhausted).toBe(false);
        const id = chatConversationId('telegram', ACCOUNT, '1002');
        expect(getConversation(db, id)?.messages.length).toBe(21);
      } finally {
        db.close();
      }
    });

    await it('leaves a chat out entirely when the budget is spent before it starts', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        const result = await syncChats(db, backend, { maxMessages: 3, historyDepth: 3 });
        expect(result.budgetExhausted).toBe(true);
        // Most recent first: the channel (1 message) fits. A 3-message window does not fit into
        // the 2 left, and a window is never cut short — nothing would ever back-fill it — so the
        // other two chats have no row yet and the next run starts them fresh.
        expect(result.added).toBe(1);
        expect(listConversations(db).length).toBe(1);
        const next = await syncChats(db, backend, { historyDepth: 3 });
        expect(next.added).toBe(6);
        expect(listConversations(db).length).toBe(3);
      } finally {
        db.close();
      }
    });

    await it('follows the read markers: unread counts, seen, and read by the other side', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        await syncChats(db, backend);
        rebuildConversations(db);
        let direct = listConversations(db).find((c) => c.id === DIRECT);
        // Anna's #3 is past the read marker (2).
        expect(direct?.unreadCount).toBe(1);
        expect(direct?.hasAttachments).toBe(true);
        const mine = getConversation(db, DIRECT)?.messages.find((m) => m.fromSelf);
        expect(mine?.readByPeer).toBe(true);
        expect(mine?.seen).toBe(true);

        // Read on the phone, no new message: the next sync still picks it up.
        backend.markRead('1001', 3, 2);
        await syncChats(db, backend);
        direct = listConversations(db).find((c) => c.id === DIRECT);
        expect(direct?.unreadCount).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('keeps other chats going when one fails, and retries the failed one next run', async () => {
      const backend = telegramFixture();
      backend.failing.add('-4001');
      const db = freshDb();
      try {
        const result = await syncChats(db, backend);
        expect(result.accounts[0].chatErrors).toBe(1);
        expect(result.accounts[0].error).toBe(null);
        expect(result.added).toBe(4);
        expect(listConversations(db).some((c) => c.id === GROUP)).toBe(false);
        backend.failing.clear();
        const retry = await syncChats(db, backend);
        expect(retry.added).toBe(3);
        expect(listConversations(db).some((c) => c.id === GROUP)).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('reports an account that cannot connect, without throwing', async () => {
      const backend = telegramFixture();
      backend.connectError = new Error('session revoked');
      const db = freshDb();
      try {
        const result = await syncChats(db, backend);
        expect(result.failed).toBe(true);
        expect(result.accounts[0].error).toBe('session revoked');
      } finally {
        db.close();
      }
    });

    await it('closes the session after every run', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        await syncChats(db, backend);
        await syncChats(db, backend);
        expect(backend.closed).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('counts the chat run towards the index freshness', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture(), { now: AT('2026-08-06T12:00:00Z') });
        expect(syncStatus(db, 24, new Date('2026-08-06T13:00:00Z')).newestSync).toBe(
          '2026-08-06T12:00:00.000Z',
        );
      } finally {
        db.close();
      }
    });

    await it('writes a full default run in few executions (5 000 messages)', async () => {
      // The per-process execution budget (gjsify#1838) breaks every SELECT after ~16 000 run()s.
      // One statement per message would spend 5 000 here and fail the reads below on GJS.
      const backend = new FakeChatBackend();
      for (let chat = 0; chat < 25; chat++) {
        const id = String(2000 + chat);
        backend.addChat({ remoteId: id, kind: 'direct', title: `Chat ${chat}`, members: [BEN] });
        for (let seq = 1; seq <= 200; seq++) backend.post(id, chatMessage(id, seq, BEN, `Nachricht ${seq}`));
      }
      const db = freshDb();
      try {
        const result = await syncChats(db, backend);
        expect(result.added).toBe(5000);
        rebuildConversations(db);
        expect(count(db, 'SELECT COUNT(*) AS n FROM conversation_messages')).toBe(5000);
        expect(listConversations(db, { limit: 100 }).length).toBe(25);
      } finally {
        db.close();
      }
    });
  });

  await describe('chats in the conversation view', async () => {
    await it('turns a peer whose phone is in the address book into that contact', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture());
        rebuildConversations(db, { contacts: CONTACTS });
        const direct = listConversations(db).find((c) => c.id === DIRECT);
        const anna = direct?.participants[0];
        expect(anna?.contactUid).toBe('contact-anna');
        expect(anna?.displayName).toBe('Anna E.');
        expect(anna?.addresses.map((a) => `${a.kind}:${a.value}`).sort()).toEqualArray([
          'email:anna@example.org',
          'phone:+491510000000',
          'telegram:1001',
          'telegram:anna_example',
        ]);
        const first = getConversation(db, DIRECT)?.messages[0];
        expect(first?.classificationReason).toBe('known-contact');
        expect(first?.senderId).toBe(anna?.id ?? 'missing');
        // A stranger in a group is a person, not held back like an unknown mail sender.
        const ben = getConversation(db, GROUP)?.messages.find((m) => m.senderName === 'Ben Example');
        expect(ben?.classification).toBe('conversational');
        expect(ben?.classificationReason).toBe('chat-member');
      } finally {
        db.close();
      }
    });

    await it('re-links on the next rebuild when a contact is added later', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture());
        rebuildConversations(db);
        let first = getConversation(db, DIRECT)?.messages[0];
        expect(first?.classificationReason).toBe('chat-member');
        rebuildConversations(db, { contacts: CONTACTS });
        first = getConversation(db, DIRECT)?.messages[0];
        expect(first?.classificationReason).toBe('known-contact');
        const participant = listConversations(db).find((c) => c.id === DIRECT)?.participants[0];
        expect(participant?.contactUid).toBe('contact-anna');
      } finally {
        db.close();
      }
    });

    await it('marks channels and bots automated, so people-only hides a channel', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture());
        rebuildConversations(db, { contacts: CONTACTS });
        const channel = listConversations(db).find((c) => c.id === CHANNEL);
        expect(channel?.classification).toBe('automated');
        expect(channel?.classificationReason).toBe('broadcast');
        const bot = getConversation(db, GROUP)?.messages.find((m) => m.senderName === 'Helper Bot');
        expect(bot?.classification).toBe('automated');
        expect(bot?.classificationReason).toBe('bot');
        const people = listConversations(db, { peopleOnly: true }).map((c) => c.id);
        expect(people.includes(CHANNEL)).toBe(false);
        expect(people.includes(DIRECT)).toBe(true);
        expect(people.includes(GROUP)).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('carries reply ids for chat rows and leaves mail rows as they were', async () => {
      const db = freshDb();
      try {
        const mail = new FakeBackend();
        mail.put('INBOX', [
          message(1, 'Hallo', 'Mail-Text', { from: [{ name: 'Anna', email: 'anna@example.org' }] }),
        ]);
        await syncIndex(db, mail);
        await syncChats(db, telegramFixture());
        rebuildConversations(db, { contacts: CONTACTS });
        const reply = getConversation(db, GROUP)?.messages.find((m) => m.senderName === 'Anna Example');
        expect(reply?.replyToRemoteId).toBe('-4001/10');
        const mailConv = listConversations(db, { backend: 'mail' })[0];
        const mailMessage = getConversation(db, mailConv.id, { includeBodies: true })?.messages[0];
        expect(mailMessage?.presentation).toBe('document');
        expect('replyToRemoteId' in (mailMessage ?? {})).toBe(false);
        expect(mailMessage?.bodyText).toBe('Mail-Text');
      } finally {
        db.close();
      }
    });

    await it('mail and chat meet at the address book: one participant for Anna', async () => {
      const db = freshDb();
      try {
        const mail = new FakeBackend();
        mail.put('INBOX', [
          message(1, 'Hallo', 'Mail-Text', { from: [{ name: 'Anna', email: 'anna@example.org' }] }),
        ]);
        await syncIndex(db, mail);
        await syncChats(db, telegramFixture());
        rebuildConversations(db, { contacts: CONTACTS });
        const all = listConversations(db);
        const annaIds = new Set(
          all.flatMap((c) => c.participants.filter((p) => p.contactUid === 'contact-anna').map((p) => p.id)),
        );
        expect(annaIds.size).toBe(1);
        const backends = new Set(
          all.filter((c) => c.participants.some((p) => annaIds.has(p.id))).map((c) => c.backend),
        );
        expect([...backends].sort()).toEqualArray(['mail', 'telegram']);
      } finally {
        db.close();
      }
    });

    await it('survives the mail rebuild: rebuilding twice keeps every chat and its links', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture());
        rebuildConversations(db, { contacts: CONTACTS });
        const before = listConversations(db).map(
          (c) => `${c.id}:${c.participants.map((p) => p.id).join(',')}`,
        );
        rebuildConversations(db, { contacts: CONTACTS });
        const after = listConversations(db).map(
          (c) => `${c.id}:${c.participants.map((p) => p.id).join(',')}`,
        );
        expect(after.sort()).toEqualArray(before.sort());
        expect(after.length).toBe(3);
      } finally {
        db.close();
      }
    });

    await it('a full scan of a chat with new messages walks forward instead of skipping a gap', async () => {
      const backend = new FakeChatBackend();
      backend.addChat({ remoteId: '1002', kind: 'direct', title: 'Ben', members: [BEN] });
      backend.post('1002', chatMessage('1002', 1, BEN, 'eins'));
      const db = freshDb();
      try {
        await syncChats(db, backend, { historyDepth: 5 });
        for (let seq = 2; seq <= 20; seq++) backend.post('1002', chatMessage('1002', seq, BEN, `m${seq}`));
        await syncChats(db, backend, { historyDepth: 5, fullScan: true });
        const id = chatConversationId('telegram', ACCOUNT, '1002');
        expect(getConversation(db, id)?.messages.length).toBe(20);
      } finally {
        db.close();
      }
    });

    await it('a message deleted on the server survives an incremental run, not a full scan', async () => {
      const backend = new FakeChatBackend();
      backend.addChat({ remoteId: '1002', kind: 'direct', title: 'Ben', members: [BEN] });
      for (let seq = 1; seq <= 10; seq++) backend.post('1002', chatMessage('1002', seq, BEN, `m${seq}`));
      const db = freshDb();
      const id = chatConversationId('telegram', ACCOUNT, '1002');
      const seqs = () => (getConversation(db, id)?.messages ?? []).map((m) => m.ref.remoteId).join(' ');
      try {
        await syncChats(db, backend, { historyDepth: 10 });
        const chat = backend.chats.get('1002');
        if (!chat) throw new Error('fixture chat missing');
        // Deleted on the phone: #3 inside the chat, #10 its newest message.
        chat.messages = chat.messages.filter((m) => m.seq !== 3 && m.seq !== 10);
        await syncChats(db, backend);
        expect(getConversation(db, id)?.messages.length).toBe(10);
        // The full scan's window of 4 covers #6–#9 and everything above: #10 goes, #3 is
        // outside the window and so not proven deleted — it stays until a window covers it.
        const scan = await syncChats(db, backend, { historyDepth: 4, fullScan: true });
        expect(scan.removed).toBe(1);
        expect(seqs()).toBe('1002/1 1002/2 1002/3 1002/4 1002/5 1002/6 1002/7 1002/8 1002/9');
        const deep = await syncChats(db, backend, { historyDepth: 50, fullScan: true });
        expect(deep.removed).toBe(1);
        expect(seqs().includes('1002/3')).toBe(false);
        expect(listConversations(db).find((c) => c.id === id)?.messageCount).toBe(8);
      } finally {
        db.close();
      }
    });

    await it('a full scan removes a chat that left the list, with its messages', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        await syncChats(db, backend);
        backend.chats.delete('-4001');
        await syncChats(db, backend);
        expect(listConversations(db).some((c) => c.id === GROUP)).toBe(true);
        const scan = await syncChats(db, backend, { fullScan: true });
        expect(scan.removed).toBe(1);
        expect(listConversations(db).some((c) => c.id === GROUP)).toBe(false);
        expect(
          count(db, 'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?', GROUP),
        ).toBe(0);
        expect(count(db, 'SELECT COUNT(*) AS n FROM chat_cursors WHERE conversation_id = ?', GROUP)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('deletedBy proves deletions only inside the range a page covered', async () => {
      const stored = [1, 2, 3, 4, 5].map((seq) => ({ id: `m${seq}`, seq }));
      const msg = (seq: number) => chatMessage('1', seq, BEN, 'x');
      const base = { exhausted: true, reachedStart: false };
      // Window #3–#5 (newest): #4 missing, #1/#2 are outside it.
      expect(
        deletedBy({ ...base, messages: [msg(3), msg(5)], lowestSeq: 3, highestSeq: 5 }, stored),
      ).toEqualArray(['m4']);
      // An empty page that did not reach the start proves nothing.
      expect(deletedBy({ ...base, messages: [], lowestSeq: null, highestSeq: null }, stored).length).toBe(0);
      // An empty page that reached the start: the chat is empty.
      expect(
        deletedBy({ ...base, reachedStart: true, messages: [], lowestSeq: null, highestSeq: null }, stored)
          .length,
      ).toBe(5);
    });

    await it('an edited message re-fetched by a full scan replaces its row', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        await syncChats(db, backend);
        const chat = backend.chats.get('1001');
        if (!chat) throw new Error('fixture chat missing');
        chat.messages[0] = {
          ...chat.messages[0],
          text: 'Kommst du am Sonntag?',
          editedAt: '2026-08-01T11:00:00.000Z',
        };
        await syncChats(db, backend, { fullScan: true });
        const first = getConversation(db, DIRECT, { includeBodies: true })?.messages[0];
        expect(first?.bodyText).toBe('Kommst du am Sonntag?');
        expect(first?.editedAt).toBe('2026-08-01T11:00:00.000Z');
        expect(getConversation(db, DIRECT)?.messages.length).toBe(3);
      } finally {
        db.close();
      }
    });
  });
};
