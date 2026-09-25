import { describe, expect, it } from '@gjsify/unit';

import { searchIndex, syncIndex, syncStatus } from '@postbote/store';
import { AT, FakeBackend, folder, freshDb, message } from './fixtures.ts';

/**
 * The sync engine is the most intricate code in the project: UIDVALIDITY resets, expunges,
 * flag drift and the cheap no-op path, against the fake server in fixtures.ts.
 */

export default async () => {
  await describe('initial sync', async () => {
    await it('indexes every message and makes it searchable', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Energieberatung'), message(2, 'Angebot Wärmepumpe')]);
      try {
        const result = await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(result.added).toBe(2);
        expect(result.failed).toBe(false);
        expect(searchIndex(db, { query: 'Wärmepumpe' }).length).toBe(1);
        expect(searchIndex(db, {}).length).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('records the cursor so a second run adds only what is new', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One'), message(2, 'Two')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        backend.put('INBOX', [message(1, 'One'), message(2, 'Two'), message(3, 'Three')]);
        const second = await syncIndex(db, backend, { now: AT('2026-08-06T12:05:00Z') });
        expect(second.added).toBe(1);
        expect(searchIndex(db, {}).length).toBe(3);
      } finally {
        db.close();
      }
    });

    await it('never re-adds a message already indexed', async () => {
      // `<n>:*` returns at least the highest existing UID even when n is past the end, so a
      // naive engine re-inserts the newest message on every run. That is the classic RFC 3501
      // trap, and the reason the loop discards anything at or below the cursor.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-06T18:00:00Z') });
        await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-07T02:00:00Z') });
        expect(searchIndex(db, {}).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('the cheap no-op path', async () => {
    await it('skips a folder whose uidNext AND count are unchanged', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        const before = backend.flagScans;
        // Only 10 minutes later, so the periodic full scan is not yet due.
        const second = await syncIndex(db, backend, { now: AT('2026-08-06T12:10:00Z') });
        expect(second.folders[0].skipped).toBe(true);
        expect(second.added).toBe(0);
        // The point of the skip: no flag scan at all.
        expect(backend.flagScans).toBe(before);
      } finally {
        db.close();
      }
    });

    await it('does the full pass once it is due', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        const before = backend.flagScans;
        const later = await syncIndex(db, backend, {
          fullScanIntervalHours: 6,
          now: AT('2026-08-06T19:00:00Z'),
        });
        expect(later.folders[0].skipped).toBe(false);
        expect(backend.flagScans).toBe(before + 1);
      } finally {
        db.close();
      }
    });
  });

  await describe('UIDVALIDITY', async () => {
    await it('rebuilds the folder from scratch when it changes', async () => {
      // Every stored UID now names a different message, or none. Nothing can be reused, and
      // keeping the old rows would mean serving results that point at the wrong messages.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Old one'), message(2, 'Old two')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, { query: 'Old' }).length).toBe(2);

        backend.uidValidity = 2;
        backend.uidNext = 1;
        backend.put('INBOX', [message(1, 'Brand new')]);
        const after = await syncIndex(db, backend, { now: AT('2026-08-06T13:00:00Z') });

        expect(after.folders[0].rebuilt).toBe(true);
        expect(searchIndex(db, { query: 'Old' }).length).toBe(0);
        expect(searchIndex(db, { query: 'Brand' }).length).toBe(1);
        expect(searchIndex(db, {}).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('expunges and flag drift', async () => {
    await it('removes messages that no longer exist on the server', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Keep'), message(2, 'Delete me'), message(3, 'Keep too')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        backend.messages.set(
          'INBOX',
          (backend.messages.get('INBOX') ?? []).filter((m) => m.uid !== 2),
        );
        const after = await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-06T13:00:00Z') });
        expect(after.removed).toBe(1);
        expect(searchIndex(db, { query: 'Delete' }).length).toBe(0);
        expect(searchIndex(db, {}).length).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('FORCES the full pass when the message count dropped', async () => {
      // A shrinking `exists` is proof of an expunge, so waiting for the periodic scan would
      // leave the index serving a deleted message — possibly for hours.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One'), message(2, 'Two')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        backend.messages.set(
          'INBOX',
          (backend.messages.get('INBOX') ?? []).filter((m) => m.uid !== 1),
        );
        // Ten minutes later — nowhere near the 6-hour interval.
        const after = await syncIndex(db, backend, { now: AT('2026-08-06T12:10:00Z') });
        expect(after.folders[0].skipped).toBe(false);
        expect(after.removed).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('picks up a flag change without touching the body', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Unread')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, { unseen: true }).length).toBe(1);

        const msgs = backend.messages.get('INBOX') ?? [];
        msgs[0].seen = true;
        msgs[0].flagged = true;
        const after = await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-06T13:00:00Z') });

        expect(after.updated).toBe(1);
        expect(after.added).toBe(0);
        expect(searchIndex(db, { unseen: true }).length).toBe(0);
        expect(searchIndex(db, { flagged: true }).length).toBe(1);
        // The body is still indexed — a flag change must not disturb the FTS row.
        expect(searchIndex(db, { query: 'body' }).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('resilience', async () => {
    await it('keeps a folder that vanished from LIST, but stops syncing it', async () => {
      // A transient LIST failure must never be able to empty the index; deleting is an explicit
      // decision, not a side effect of one bad response.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [folder('INBOX', 'INBOX', 'inbox'), folder('Projekte')];
      backend.put('INBOX', [message(1, 'In inbox')]);
      backend.put('Projekte', [message(2, 'In projekte')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, {}).length).toBe(2);

        backend.folders = [folder('INBOX', 'INBOX', 'inbox')];
        await syncIndex(db, backend, { now: AT('2026-08-06T13:00:00Z') });

        expect(searchIndex(db, { query: 'projekte' }).length).toBe(1);
        const status = syncStatus(db, 24, new Date('2026-08-06T13:00:00Z'));
        expect(status.folders).toBe(1); // only INBOX is still sync-enabled
      } finally {
        db.close();
      }
    });

    await it('reports a failing folder without losing the others', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [folder('INBOX', 'INBOX', 'inbox'), folder('Broken')];
      backend.put('INBOX', [message(1, 'Fine')]);
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        const session = await connect();
        const openFolder = session.openFolder.bind(session);
        session.openFolder = async (path: string) => {
          if (path === 'Broken') throw new Error('SELECT Broken failed');
          return openFolder(path);
        };
        return session;
      };
      try {
        const result = await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(result.errors).toBe(1);
        expect(result.failed).toBe(false); // not every folder failed
        expect(result.added).toBe(1);
        expect(searchIndex(db, { query: 'Fine' }).length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('closes the session even when a folder throws', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [folder('Broken')];
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        const session = await connect();
        session.openFolder = async () => {
          throw new Error('nope');
        };
        return session;
      };
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(backend.closed).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('skips Trash, Junk and All Mail by default', async () => {
      // All Mail is the load-bearing exclusion: it holds a copy of every message, so indexing
      // it would duplicate the entire mailbox.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [
        folder('INBOX', 'INBOX', 'inbox'),
        folder('Trash', 'Trash', 'trash'),
        folder('All', 'All Mail', 'all'),
      ];
      backend.put('INBOX', [message(1, 'Real')]);
      backend.put('Trash', [message(2, 'Deleted')]);
      backend.put('All', [message(3, 'Duplicate')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, {}).length).toBe(1);
        expect(searchIndex(db, { query: 'Real' }).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('syncStatus', async () => {
    await it('reports counts and which folders are stale', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });

        const fresh = syncStatus(db, 24, new Date('2026-08-06T13:00:00Z'));
        expect(fresh.messages).toBe(1);
        expect(fresh.accounts).toBe(1);
        expect(fresh.staleFolders.length).toBe(0);

        // Two days later the same folder is stale, which is what makes a search say so.
        const stale = syncStatus(db, 24, new Date('2026-08-08T13:00:00Z'));
        expect(stale.staleFolders.length).toBe(1);
        expect(stale.staleFolders[0].path).toBe('INBOX');
      } finally {
        db.close();
      }
    });
  });

  await describe('a full resync of a large folder', async () => {
    await it(
      'completes, and every read afterwards is complete',
      async () => {
        // The v2 upgrade resets every cursor, so the next sync re-fetches whole folders. On
        // gjsify's sqlite each execution leaks a GWeakRef (gjsify gap, unfixed,
        // gjsify#1838); at ~15 executions a message the old one-row-at-a-time
        // writes broke the index after ~5 400 messages, and every SELECT then returned [].
        // 6 000 fetched twice is 12 000 upserts — far past that point — in one process.
        const n = 6000;
        const db = freshDb();
        const backend = new FakeBackend();
        backend.put(
          'INBOX',
          Array.from({ length: n }, (_, i) => message(i + 1, `Betreff ${i}`, `Text ${i}`)),
        );
        try {
          const first = await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
          expect(first.added).toBe(n);
          db.exec('UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL');
          const again = await syncIndex(db, backend, { now: AT('2026-08-07T12:00:00Z') });
          expect(again.added).toBe(n);
          expect(again.errors).toBe(0);

          expect(db.prepare('SELECT uid FROM messages').all().length).toBe(n);
          expect(db.prepare('SELECT rowid FROM messages_fts').all().length).toBe(n);
          expect(searchIndex(db, { query: 'Betreff', limit: 100 }).length).toBe(100);
          expect(searchIndex(db, { query: `Text ${n - 1}`, limit: 5 }).length).toBe(1);
        } finally {
          db.close();
        }
      },
      { timeout: 300_000 },
    );
  });
};
