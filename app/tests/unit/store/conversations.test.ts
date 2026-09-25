import { describe, expect, it } from '@gjsify/unit';

import type { AutomationHeaders, ContactDTO } from '@postbote/protocol';
import {
  getConversation,
  listConversations,
  migrate,
  openIndexDb,
  rebuildConversations,
  SCHEMA_VERSION,
  syncIndex,
} from '@postbote/store';
import { AT, FakeBackend, freshDb, message } from './fixtures.ts';

/**
 * Conversations built from a synced fake mailbox: threading, participants, the
 * conversational/automated split, overrides at read time, and the privacy default of no bodies.
 * The account identity in the fake is `me@example.com`, which makes it the user's own address.
 * All content is synthetic.
 */

const NONE: AutomationHeaders = {
  listId: null,
  listUnsubscribe: null,
  autoSubmitted: null,
  precedence: null,
};
const ANNA = { name: 'Anna Example', email: 'Anna@example.org' };
const BEN = { name: 'Ben Example', email: 'ben@example.net' };
const ME = { name: 'Me', email: 'me@example.com' };
const SHOP = { name: 'Shop', email: 'news@shop.example' };

const CONTACTS: ContactDTO[] = [
  {
    uid: 'contact-anna',
    name: 'Anna E.',
    org: null,
    emails: ['anna@example.org', 'anna@work.example'],
    phones: ['+49 151 0000000'],
  },
];

/** A mailbox with: a thread Anna ↔ me, a newsletter, a stranger, and a thread I started to Ben. */
function mailbox(): FakeBackend {
  const backend = new FakeBackend();
  backend.put('INBOX', [
    message(1, 'Sommerfest', 'Kommst du am Samstag?', {
      messageId: '<t1@example.org>',
      from: [ANNA],
      to: [ME],
    }),
    message(2, 'Re: Sommerfest', 'Ja, gerne', {
      messageId: '<t2@example.com>',
      from: [ME],
      to: [ANNA],
      inReplyTo: '<t1@example.org>',
      references: ['<t1@example.org>'],
      seen: true,
    }),
    message(3, 'Newsletter Mai', 'Angebote', {
      messageId: '<n1@shop.example>',
      from: [SHOP],
      to: [ME],
      automation: { ...NONE, listUnsubscribe: '<mailto:unsub@shop.example>' },
    }),
    message(4, 'Frage zum Angebot', 'Hallo, eine Frage', {
      messageId: '<s1@example.net>',
      from: [BEN],
      to: [ME],
    }),
    message(5, 'Treffen', 'Hallo Ben und Anna', {
      messageId: '<m1@example.com>',
      from: [ME],
      to: [BEN],
      cc: [ANNA],
      seen: true,
    }),
  ]);
  return backend;
}

async function built() {
  const db = freshDb();
  await syncIndex(db, mailbox(), { now: AT('2026-08-06T12:00:00Z') });
  const result = rebuildConversations(db, { contacts: CONTACTS });
  return { db, result };
}

export default async () => {
  await describe('rebuildConversations', async () => {
    await it('threads the mailbox into conversations', async () => {
      const { db, result } = await built();
      try {
        expect(result.conversations).toBe(4);
        expect(result.messages).toBe(5);
        const all = listConversations(db);
        expect(all.length).toBe(4);
        const fest = all.find((c) => c.title === 'Sommerfest');
        expect(fest?.messageCount).toBe(2);
        expect(fest?.backend).toBe('mail');
      } finally {
        db.close();
      }
    });

    await it('builds one participant per person, with every address the contact has', async () => {
      const { db } = await built();
      try {
        const fest = listConversations(db).find((c) => c.title === 'Sommerfest');
        expect(fest?.participants.length).toBe(1);
        const anna = fest?.participants[0];
        expect(anna?.contactUid).toBe('contact-anna');
        expect(anna?.displayName).toBe('Anna E.');
        // Mail, a second mail address and a phone — one person, three typed addresses.
        expect(anna?.addresses.map((a) => `${a.kind}:${a.value}`).sort()).toEqualArray([
          'email:anna@example.org',
          'email:anna@work.example',
          'phone:+491510000000',
        ]);
      } finally {
        db.close();
      }
    });

    await it('never lists the user among the participants, and marks group threads', async () => {
      const { db } = await built();
      try {
        const meeting = listConversations(db).find((c) => c.title === 'Treffen');
        expect(meeting?.kind).toBe('group');
        expect(meeting?.participants.length).toBe(2);
        const addresses = meeting?.participants.flatMap((p) => p.addresses.map((a) => a.value)) ?? [];
        expect(addresses.includes('me@example.com')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('classifies: replied and own threads are people, the newsletter and the stranger are not', async () => {
      const { db } = await built();
      try {
        const byTitle = new Map(listConversations(db).map((c) => [c.title, c]));
        expect(byTitle.get('Sommerfest')?.classification).toBe('conversational');
        expect(byTitle.get('Treffen')?.classification).toBe('conversational');
        expect(byTitle.get('Newsletter Mai')?.classificationReason).toBe('automated-header');
        expect(byTitle.get('Frage zum Angebot')?.classificationReason).toBe('unknown-sender');

        const people = listConversations(db, { peopleOnly: true })
          .map((c) => c.title)
          .sort();
        expect(people).toEqualArray(['Sommerfest', 'Treffen']);
      } finally {
        db.close();
      }
    });

    await it('counts unread messages from others only', async () => {
      const { db } = await built();
      try {
        const fest = listConversations(db).find((c) => c.title === 'Sommerfest');
        expect(fest?.unreadCount).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('is idempotent: a second rebuild yields the same ids', async () => {
      const { db } = await built();
      try {
        const before = listConversations(db)
          .map((c) => c.id)
          .sort();
        rebuildConversations(db, { contacts: CONTACTS });
        const after = listConversations(db)
          .map((c) => c.id)
          .sort();
        expect(after).toEqualArray(before);
      } finally {
        db.close();
      }
    });

    await it('without an address book, a contact is just an address', async () => {
      const { db } = await built();
      try {
        rebuildConversations(db, {});
        const fest = listConversations(db).find((c) => c.title === 'Sommerfest');
        // Still conversational — the user replied — but no longer linked to a contact.
        expect(fest?.classification).toBe('conversational');
        expect(fest?.participants[0]?.contactUid).toBe(null);
        expect(fest?.participants[0]?.addresses.length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('bulk writes', async () => {
    await it('writes every row across several multi-row INSERT chunks', async () => {
      // 121 threads: many chunks at every table's width, plus a short tail. A `?` in the data
      // proves the values are bound, not spliced into the SQL text.
      // Seeded straight into `messages`: through syncIndex the upserts alone took seconds on GJS.
      const db = freshDb();
      try {
        const from = JSON.stringify([BEN]);
        const to = JSON.stringify([ME]);
        // The account identity is what makes me@example.com the user, not a participant.
        db.prepare('INSERT INTO accounts (id, identity, provider) VALUES (?, ?, ?)').run(
          'acct',
          'me@example.com',
          'imap_smtp',
        );
        for (let start = 0; start < 121; start += 11) {
          const rows = Array.from({ length: 11 }, (_, k) => start + k);
          db.prepare(
            `INSERT INTO messages (account_id, folder_path, uid, message_id, subject, sender, recipients, date,
               indexed_at, thread_refs, from_json, to_json)
             VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          ).run(
            ...rows.flatMap((i) => [
              'acct',
              'INBOX',
              i + 1,
              `<bulk${i}@example.org>`,
              `Frage ${i}?`,
              'Ben',
              'me@example.com',
              '2026-08-06T10:00:00Z',
              '2026-08-06T12:00:00Z',
              '',
              from,
              to,
            ]),
          );
        }
        const result = rebuildConversations(db, {});
        const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
        expect(result.conversations).toBe(121);
        expect(count('SELECT COUNT(*) AS n FROM conversations')).toBe(121);
        expect(count('SELECT COUNT(*) AS n FROM conversation_messages')).toBe(121);
        expect(count('SELECT COUNT(*) AS n FROM conversation_participants')).toBe(121);
        expect(count(`SELECT COUNT(*) AS n FROM conversations WHERE title = 'Frage 120?'`)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('per-sender overrides at read time', async () => {
    await it('promote a stranger into the people list', async () => {
      const { db } = await built();
      try {
        const overrides = { 'ben@example.net': 'conversational' as const };
        const people = listConversations(db, { peopleOnly: true, overrides });
        const question = people.find((c) => c.title === 'Frage zum Angebot');
        expect(question?.classification).toBe('conversational');
        expect(question?.classificationReason).toBe('override');
      } finally {
        db.close();
      }
    });

    await it('demote a sender out of it, even in a thread the user replied in', async () => {
      const { db } = await built();
      try {
        const overrides = { 'anna@example.org': 'automated' as const };
        const people = listConversations(db, { peopleOnly: true, overrides }).map((c) => c.title);
        expect(people.includes('Sommerfest')).toBe(false);
        // The SQL filter and the JS verdict must agree: what the filter drops is automated.
        const fest = listConversations(db, { overrides }).find((c) => c.title === 'Sommerfest');
        expect(fest?.classification).toBe('automated');
      } finally {
        db.close();
      }
    });
  });

  await describe('getConversation', async () => {
    await it('returns messages oldest first, as documents, with a ref mail_get_message accepts', async () => {
      const { db } = await built();
      try {
        const id = listConversations(db).find((c) => c.title === 'Sommerfest')?.id ?? '';
        const found = getConversation(db, id);
        expect(found?.messages.length).toBe(2);
        const [first, second] = found?.messages ?? [];
        expect(first.presentation).toBe('document');
        expect(first.fromSelf).toBe(false);
        expect(first.senderAddress?.value).toBe('anna@example.org');
        expect(second.fromSelf).toBe(true);
        expect(second.senderId).toBe(null);
        expect(first.ref.folder).toBe('INBOX');
        expect(first.ref.uid).toBe(1);
        // Mail is located by folder + uid; remoteId is for the other backends.
        expect(first.ref.remoteId).toBe(undefined);
      } finally {
        db.close();
      }
    });

    await it('omits bodies unless asked, and caps them when asked', async () => {
      const { db } = await built();
      try {
        const id = listConversations(db).find((c) => c.title === 'Sommerfest')?.id ?? '';
        const plain = getConversation(db, id);
        expect(plain?.messages[0].bodyText).toBe(undefined);
        const withBodies = getConversation(db, id, { includeBodies: true, maxBodyChars: 5 });
        expect(withBodies?.messages[0].bodyText).toBe('Komms');
        expect(withBodies?.messages[0].bodyTruncated).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('returns null for an unknown id', async () => {
      const { db } = await built();
      try {
        expect(getConversation(db, 'c-00000000000000')).toBe(null);
      } finally {
        db.close();
      }
    });
  });

  await describe('schema v2 upgrade', async () => {
    await it('adds the threading columns to a v1 index and resets the cursors for a re-fetch', async () => {
      const db = openIndexDb(':memory:');
      try {
        // A v1 index as it exists on disk: v1 tables, one synced folder, version 1 recorded.
        db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        db.exec(
          `CREATE TABLE folders (account_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
             uid_validity INTEGER, uid_next INTEGER, last_uid INTEGER NOT NULL DEFAULT 0, message_count INTEGER,
             sync_enabled INTEGER NOT NULL DEFAULT 1, last_sync_at TEXT, PRIMARY KEY (account_id, path))`,
        );
        db.exec(
          `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
             folder_path TEXT NOT NULL, uid INTEGER NOT NULL, message_id TEXT, subject TEXT, sender TEXT,
             recipients TEXT, date TEXT, internal_date TEXT, size INTEGER, seen INTEGER NOT NULL DEFAULT 0,
             flagged INTEGER NOT NULL DEFAULT 0, has_attachment INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL)`,
        );
        db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')`).run();
        db.prepare(
          `INSERT INTO folders (account_id, path, name, uid_validity, uid_next, last_uid, message_count)
           VALUES ('acct', 'INBOX', 'INBOX', 1, 43, 42, 10)`,
        ).run();

        migrate(db);

        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
        const folder = db.prepare('SELECT last_uid, uid_next, message_count FROM folders').get() as Record<
          string,
          unknown
        >;
        expect(Number(folder.last_uid)).toBe(0);
        expect(folder.uid_next).toBe(null);
        const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(columns.includes('thread_refs')).toBe(true);
        expect(columns.includes('list_unsubscribe')).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('refuses an index from a newer postbote and leaves it untouched', async () => {
      const db = freshDb();
      try {
        db.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`).run(
          String(SCHEMA_VERSION + 1),
        );
        expect(() => migrate(db)).toThrow(/only knows up to/);
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        // Writing our own, lower number here is what made the newer binary replay its upgrades.
        expect(version.value).toBe(String(SCHEMA_VERSION + 1));
      } finally {
        db.close();
      }
    });

    await it('replays the v2 upgrade safely after an old binary set the version back to 1', async () => {
      // A released v1 binary has no too-new check: it opens a v2 index and records version 1.
      // The next v2 open replays UPGRADES[2] against columns that already exist.
      const db = freshDb();
      try {
        db.prepare(`UPDATE schema_meta SET value = '1' WHERE key = 'schema_version'`).run();
        migrate(db);
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
      } finally {
        db.close();
      }
    });

    await it('migrating a current index again changes nothing', async () => {
      const db = freshDb();
      try {
        migrate(db);
        migrate(db);
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
      } finally {
        db.close();
      }
    });
  });
};
