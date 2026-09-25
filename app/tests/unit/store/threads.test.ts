import { describe, expect, it } from '@gjsify/unit';

import { buildThreads, normalizeSubject, stableId, type ThreadMember } from '@postbote/store';

// Threading without a database. Synthetic Message-IDs only.

function m(key: string, messageId: string | null, extra: Partial<ThreadMember> = {}): ThreadMember {
  return {
    key,
    accountId: 'acct',
    messageId,
    inReplyTo: null,
    references: [],
    sentAt: `2026-01-0${key}T10:00:00Z`,
    ...extra,
  };
}

function keys(threads: Array<{ members: ThreadMember[] }>): string[] {
  return threads.map((t) => t.members.map((x) => x.key).join(',')).sort();
}

export default async () => {
  await describe('buildThreads', async () => {
    await it('joins a reply chain by In-Reply-To and References', async () => {
      const threads = buildThreads([
        m('1', '<a@x>'),
        m('2', '<b@x>', { inReplyTo: '<a@x>', references: ['<a@x>'] }),
        m('3', '<c@x>', { inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] }),
        m('4', '<z@x>'),
      ]);
      expect(keys(threads)).toEqualArray(['1,2,3', '4']);
    });

    await it('holds a thread together when the middle message was never indexed', async () => {
      // <b@x> is missing (deleted, or in an unsynced folder); References still names the root.
      const threads = buildThreads([m('1', '<a@x>'), m('3', '<c@x>', { references: ['<a@x>', '<b@x>'] })]);
      expect(keys(threads)).toEqualArray(['1,3']);
    });

    await it('collapses one message filed in two folders', async () => {
      const threads = buildThreads([m('1', '<a@x>'), m('2', '<a@x>')]);
      expect(threads.length).toBe(1);
      expect(threads[0].members.length).toBe(1);
    });

    await it('never merges by subject — no shared reference, no shared thread', async () => {
      expect(buildThreads([m('1', '<a@x>'), m('2', '<b@x>')]).length).toBe(2);
    });

    await it('keeps accounts apart even for an identical Message-ID', async () => {
      const threads = buildThreads([m('1', '<a@x>'), m('2', '<a@x>', { accountId: 'other' })]);
      expect(threads.length).toBe(2);
    });

    await it('orders members oldest first and keys the thread on the earliest root', async () => {
      const [thread] = buildThreads([m('2', '<b@x>', { references: ['<a@x>'] }), m('1', '<a@x>')]);
      expect(thread.members.map((x) => x.key)).toEqualArray(['1', '2']);
      expect(thread.rootKey).toBe('<a@x>');
    });

    await it('threads a message without a Message-ID on its own', async () => {
      const threads = buildThreads([m('1', null), m('2', null)]);
      expect(threads.length).toBe(2);
    });
  });

  await describe('normalizeSubject', async () => {
    await it('strips stacked reply and forward prefixes, German ones included', async () => {
      expect(normalizeSubject('Re: AW: Fwd: Angebot')).toBe('Angebot');
      expect(normalizeSubject('WG: Re[2]: Angebot')).toBe('Angebot');
      expect(normalizeSubject('Reise nach Rom')).toBe('Reise nach Rom');
      expect(normalizeSubject(null)).toBe(null);
    });
  });

  await describe('stableId', async () => {
    await it('is deterministic, prefixed, and sensitive to every part', async () => {
      expect(stableId('c-', 'mail', 'acct', '<a@x>')).toBe(stableId('c-', 'mail', 'acct', '<a@x>'));
      expect(stableId('c-', 'mail', 'acct', '<a@x>')).toMatch(/^c-[0-9a-f]{14}$/);
      expect(stableId('c-', 'mail', 'acct', '<a@x>') === stableId('c-', 'mail', 'acct2', '<a@x>')).toBe(
        false,
      );
      // Parts are joined with a separator, so shifting a boundary changes the id.
      expect(stableId('c-', 'ab', 'c') === stableId('c-', 'a', 'bc')).toBe(false);
    });
  });
};
