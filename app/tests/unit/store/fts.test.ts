import { describe, expect, it } from '@gjsify/unit';

import {
  migrate,
  openIndexDb,
  probeFts5,
  toFts5ColumnMatch,
  toFts5Match,
  withTransaction,
} from '@postbote/store';

/**
 * THE gate for the whole index design.
 *
 * gjsify's `node:sqlite` is a libgda wrapper, not a sqlite3 binding, so "SQLite has FTS5" is a
 * claim about a different library than the one this actually runs on. Everything below runs
 * against the real bundled wrapper on BOTH runtimes; if FTS5 were unavailable or its tokenizer
 * inactive, the index would answer "no results" to everything and look like an empty mailbox
 * rather than a broken build.
 *
 * All fixture text is synthetic.
 */
export default async () => {
  await describe('FTS5 availability', async () => {
    await it('has a working FTS5 module with diacritic folding', async () => {
      const db = openIndexDb(':memory:');
      try {
        probeFts5(db); // throws with a specific message if not
      } finally {
        db.close();
      }
    });
  });

  await describe('schema migration', async () => {
    await it('creates the schema and records its version', async () => {
      const db = openIndexDb(':memory:');
      try {
        migrate(db);
        const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(Number.parseInt(row.value, 10)).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });

    await it('is idempotent — a second migrate changes nothing', async () => {
      const db = openIndexDb(':memory:');
      try {
        migrate(db);
        migrate(db);
        migrate(db);
        const tables = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
          .all() as Array<{ name: string }>;
        const names = tables.map((t) => t.name);
        for (const want of ['accounts', 'folders', 'messages', 'messages_fts', 'sync_log']) {
          expect(`${want}:${names.includes(want)}`).toBe(`${want}:true`);
        }
      } finally {
        db.close();
      }
    });
  });

  await describe('indexing and searching', async () => {
    /** Insert one message + its searchable text, the way the sync engine does. */
    function insert(
      db: ReturnType<typeof openIndexDb>,
      row: { uid: number; subject: string; sender: string; recipients: string; body: string; date: string },
    ): number {
      return withTransaction(db, () => {
        db.prepare(
          `INSERT INTO messages
             (account_id, folder_path, uid, subject, sender, recipients, date, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('acct', 'INBOX', row.uid, row.subject, row.sender, row.recipients, row.date, '2026-08-06');
        const { id } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
        db.prepare(
          `INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)`,
        ).run(id, row.subject, row.sender, row.recipients, row.body);
        return id;
      });
    }

    function seed(db: ReturnType<typeof openIndexDb>): void {
      migrate(db);
      insert(db, {
        uid: 1,
        subject: 'Energieberatung Bestandsaufnahme',
        sender: 'Beispiel Beratung <kontakt@example.org>',
        recipients: 'me@example.com',
        body: 'Anbei die Unterlagen zur Sanierung. Der Termin im März passt.',
        date: '2026-03-02T09:00:00.000Z',
      });
      insert(db, {
        uid: 2,
        subject: 'Re: Angebot Wärmepumpe',
        sender: 'Heizung GmbH <info@example.net>',
        recipients: 'me@example.com',
        body: 'Das Angebot für die Wärmepumpe liegt bei. Grüße aus Hannover.',
        date: '2026-04-11T10:30:00.000Z',
      });
      insert(db, {
        uid: 3,
        subject: 'Rechnung 2025-08',
        sender: 'Beispiel Beratung <kontakt@example.org>',
        recipients: 'me@example.com',
        body: 'Rechnung anbei, zahlbar innerhalb von 14 Tagen.',
        date: '2026-08-01T08:00:00.000Z',
      });
    }

    /** Run a MATCH the way the query layer does: narrow FTS query, then an ordinary hydration. */
    function search(db: ReturnType<typeof openIndexDb>, match: string): number[] {
      const hits = db
        .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 50`)
        .all(match) as Array<{ rowid: number }>;
      if (hits.length === 0) return [];
      const ids = hits.map((h) => h.rowid);
      const rows = db
        .prepare(`SELECT uid FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY date DESC`)
        .all(...ids) as Array<{ uid: number }>;
      return rows.map((r) => r.uid);
    }

    await it('finds a message by a word in its body', async () => {
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        expect(search(db, toFts5Match('Sanierung') ?? '')).toEqualArray([1]);
        expect(search(db, toFts5Match('Wärmepumpe') ?? '')).toEqualArray([2]);
      } finally {
        db.close();
      }
    });

    await it('folds diacritics, so an ASCII query finds an umlaut', async () => {
      // The reason for `remove_diacritics 2`, and the difference between a usable German index
      // and one that only works if you type the umlaut.
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        expect(search(db, toFts5Match('marz') ?? '')).toEqualArray([1]);
        expect(search(db, toFts5Match('Warmepumpe') ?? '')).toEqualArray([2]);
        expect(search(db, toFts5Match('WARMEPUMPE') ?? '')).toEqualArray([2]);
      } finally {
        db.close();
      }
    });

    await it('does NOT fold ß to ss — a real limit of the tokenizer', async () => {
      // `remove_diacritics` folds DIACRITICS: ü→u, ä→a, é→e. ß is not a diacritic, it is its own
      // letter, so "Grüße" indexes as "gruße" and typing "grusse" finds nothing. Pinned because
      // it looks like a bug from the outside and is worth knowing before someone "fixes" the
      // tokenizer; matching both spellings would need a custom tokenizer or a normalized copy.
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        expect(search(db, toFts5Match('gruße') ?? '')).toEqualArray([2]);
        expect(search(db, toFts5Match('grusse') ?? '')).toEqualArray([]);
      } finally {
        db.close();
      }
    });

    await it('ANDs multiple terms', async () => {
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        expect(search(db, toFts5Match('Angebot Wärmepumpe') ?? '')).toEqualArray([2]);
        expect(search(db, toFts5Match('Angebot Sanierung') ?? '')).toEqualArray([]);
      } finally {
        db.close();
      }
    });

    await it('supports a quoted phrase', async () => {
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        expect(search(db, toFts5Match('"14 Tagen"') ?? '')).toEqualArray([3]);
      } finally {
        db.close();
      }
    });

    await it('searches one column when asked', async () => {
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        // "Rechnung" is in message 3's subject AND its body; scoping to the subject still finds
        // it, while a word that only appears in a body does not.
        expect(search(db, toFts5ColumnMatch('subject', 'Rechnung') ?? '')).toEqualArray([3]);
        expect(search(db, toFts5ColumnMatch('subject', 'Sanierung') ?? '')).toEqualArray([]);
        expect(search(db, toFts5ColumnMatch('sender', 'kontakt') ?? '').sort()).toEqualArray([1, 3]);
      } finally {
        db.close();
      }
    });

    await it('survives punctuation that is FTS5 SYNTAX', async () => {
      // The hazard this whole sanitizer exists for: libgda's all() swallows exceptions and
      // returns [], so a syntax error is indistinguishable from "nothing matched". Each of
      // these is a syntax error if passed through raw.
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        // Every token below genuinely occurs in message 2, so a correct build FINDS it — which
        // is the only way to tell a working query from a syntax error, since both would
        // otherwise present as [].
        for (const raw of [
          're: Angebot', // ':' after a bare word
          'Angebot (Wärmepumpe)', // parentheses are FTS5 grouping
          'Angebot "Wärmepumpe', // an unterminated quote
          'Angebot*', // '*' is prefix syntax
          '^Angebot', // '^' anchors to a column start
          'Angebot -Wärmepumpe', // '-' is NOT
          'Angebot: Wärmepumpe.', // ':' is a column qualifier
        ]) {
          const match = toFts5Match(raw);
          expect(`${raw} -> built`).toBe(match ? `${raw} -> built` : `${raw} -> null`);
          expect(`${raw}:${search(db, match ?? '').includes(2)}`).toBe(`${raw}:true`);
        }
      } finally {
        db.close();
      }
    });

    await it('treats AND / OR / NOT as ordinary words, not operators', async () => {
      // The deliberate rule: EVERY token is a literal term and they are all ANDed. Honouring
      // the operators would mean interpreting user text as a query language, and getting it
      // wrong is invisible — libgda returns [] for a syntax error, so a mis-parsed boolean
      // reads as "nothing matched". Predictable beats clever when the failure is silent.
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        // "AND" itself is not in the message, so requiring it literally finds nothing …
        expect(search(db, toFts5Match('Angebot AND Wärmepumpe') ?? '')).toEqualArray([]);
        // … while the plain two-word form does exactly what the user meant.
        expect(search(db, toFts5Match('Angebot Wärmepumpe') ?? '')).toEqualArray([2]);
      } finally {
        db.close();
      }
    });

    await it('treats a hyphenated term as literal, not as NOT', async () => {
      // Raw, `Rechnung-2025` means "Rechnung NOT 2025" in FTS5 and would miss the message.
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        expect(search(db, toFts5Match('2025-08') ?? '')).toEqualArray([3]);
      } finally {
        db.close();
      }
    });

    await it('returns null for an empty query rather than an empty result', async () => {
      // Callers must read this as "no full-text filter". An empty MATCH is a syntax error, and
      // therefore — see above — silently zero results.
      expect(toFts5Match('')).toBe(null);
      expect(toFts5Match('   ')).toBe(null);
      expect(toFts5Match(null)).toBe(null);
      expect(toFts5ColumnMatch('subject', '""')).toBe(null);
    });

    await it('rejects a non-literal column name', async () => {
      expect(() => toFts5ColumnMatch('subject; DROP TABLE messages', 'x')).toThrow('invalid FTS column');
    });

    await it('deletes cleanly from both tables', async () => {
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        const { id } = db.prepare(`SELECT id FROM messages WHERE uid = 2`).get() as { id: number };
        withTransaction(db, () => {
          db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
          db.prepare('DELETE FROM messages WHERE id = ?').run(id);
        });
        expect(search(db, toFts5Match('Wärmepumpe') ?? '')).toEqualArray([]);
        expect(search(db, toFts5Match('Sanierung') ?? '')).toEqualArray([1]);
      } finally {
        db.close();
      }
    });

    await it('updates flags WITHOUT touching the FTS row', async () => {
      // The reason the FTS table is maintained by application code rather than a trigger: an
      // AFTER UPDATE trigger would rewrite the whole FTS row — body included — every time a
      // \Seen flag changed.
      const db = openIndexDb(':memory:');
      try {
        seed(db);
        db.prepare('UPDATE messages SET seen = 1 WHERE uid = 1').run();
        expect(search(db, toFts5Match('Sanierung') ?? '')).toEqualArray([1]);
        const row = db.prepare('SELECT seen FROM messages WHERE uid = 1').get() as { seen: number };
        expect(row.seen).toBe(1);
      } finally {
        db.close();
      }
    });
  });
};
