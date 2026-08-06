import { describe, expect, it } from '@gjsify/unit';

import { parseFolderList, parseListLine, searchableFolders } from '@postbote/protocol';

// Synthetic responses throughout — the shapes are from RFC 3501/6154 and from what Dovecot,
// Gmail and Exchange actually send, but no real mailbox name appears here.
export default async () => {
  await describe('parseListLine', async () => {
    await it('parses attributes, delimiter and name', async () => {
      const f = parseListLine('* LIST (\\HasNoChildren \\Sent) "/" "INBOX/Sent"');
      expect(f?.path).toBe('INBOX/Sent');
      expect(f?.name).toBe('INBOX/Sent');
      expect(f?.delimiter).toBe('/');
      expect(f?.attributes).toContain('sent');
      expect(f?.attributes).toContain('hasnochildren');
      expect(f?.selectable).toBe(true);
    });

    await it('decodes a modified-UTF-7 name for display but keeps the wire form', async () => {
      // The distinction is the whole point: `path` goes back to the server in SELECT, `name` is
      // shown. Sending the display form is what made non-ASCII mailboxes unreachable before.
      const f = parseListLine('* LIST (\\HasNoChildren) "." "Gel&APY-schte Elemente"');
      expect(f?.path).toBe('Gel&APY-schte Elemente');
      expect(f?.name).toBe('Gelöschte Elemente');
    });

    await it('accepts an unquoted atom name', async () => {
      const f = parseListLine('* LIST (\\HasNoChildren) "/" INBOX');
      expect(f?.path).toBe('INBOX');
      expect(f?.role).toBe('inbox');
    });

    await it('handles a NIL delimiter (flat namespace)', async () => {
      const f = parseListLine('* LIST (\\Noinferiors) NIL "Everything"');
      expect(f?.delimiter).toBe(null);
    });

    await it('marks \\Noselect and \\NonExistent as unselectable', async () => {
      // These are grouping nodes with no messages; SELECT on one fails.
      expect(parseListLine('* LIST (\\Noselect \\HasChildren) "/" "Archive"')?.selectable).toBe(false);
      expect(parseListLine('* LIST (\\NonExistent) "/" "Ghost"')?.selectable).toBe(false);
    });

    await it('accepts LSUB and XLIST lines too', async () => {
      expect(parseListLine('* LSUB () "/" "INBOX"')?.path).toBe('INBOX');
      expect(parseListLine('* XLIST (\\Inbox) "/" "INBOX"')?.path).toBe('INBOX');
    });

    await it('returns null for anything that is not a mailbox line', async () => {
      expect(parseListLine('* OK [UIDVALIDITY 1] UIDs valid')).toBe(null);
      expect(parseListLine('a1 OK LIST completed')).toBe(null);
    });
  });

  await describe('role resolution', async () => {
    await it('prefers the RFC 6154 SPECIAL-USE attribute', async () => {
      const f = parseListLine('* LIST (\\HasNoChildren \\Trash) "/" "Weird Custom Name"');
      expect(f?.role).toBe('trash');
      expect(f?.roleSource).toBe('special-use');
    });

    await it('treats INBOX as reserved, case-insensitively and without an attribute', async () => {
      expect(parseListLine('* LIST () "/" "inbox"')?.role).toBe('inbox');
      expect(parseListLine('* LIST () "/" "INBOX"')?.roleSource).toBe('name');
    });

    await it('falls back to German and English names when no attribute is offered', async () => {
      // Plain Dovecot/MIAB without SPECIAL-USE is the common case here, and it is exactly where
      // a German mailbox would otherwise get no role at all.
      for (const [wire, role] of [
        ['Gesendet', 'sent'],
        ['Sent Items', 'sent'],
        ['Entw&APw-rfe', 'drafts'],
        ['Papierkorb', 'trash'],
        ['Deleted Items', 'trash'],
        ['Junk', 'junk'],
        ['Spam', 'junk'],
        ['Archiv', 'archive'],
      ] as const) {
        const f = parseListLine(`* LIST (\\HasNoChildren) "/" "${wire}"`);
        expect(`${wire}:${f?.role}`).toBe(`${wire}:${role}`);
        expect(f?.roleSource).toBe('heuristic');
      }
    });

    await it('matches the LEAF of a nested path, not the whole path', async () => {
      expect(parseListLine('* LIST () "/" "INBOX/Gesendet"')?.role).toBe('sent');
      expect(parseListLine('* LIST () "." "INBOX.Papierkorb"')?.role).toBe('trash');
    });

    await it('leaves an ordinary folder without a role', async () => {
      const f = parseListLine('* LIST (\\HasNoChildren) "/" "Projekte"');
      expect(f?.role).toBe(null);
      expect(f?.roleSource).toBe(null);
    });
  });

  await describe('searchableFolders', async () => {
    await it('excludes All Mail, Trash, Junk and unselectable nodes', async () => {
      const folders = parseFolderList([
        '* LIST (\\HasNoChildren) "/" "INBOX"',
        '* LIST (\\HasNoChildren \\Sent) "/" "Sent"',
        '* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"',
        '* LIST (\\HasNoChildren \\Trash) "/" "Trash"',
        '* LIST (\\HasNoChildren \\Junk) "/" "Spam"',
        '* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"',
        '* LIST (\\HasNoChildren) "/" "Projekte"',
      ]);
      expect(folders.length).toBe(7);
      // \All is the load-bearing exclusion: Gmail's All Mail holds a copy of every message in
      // every other folder, so including it duplicates every single hit.
      expect(searchableFolders(folders).map((f) => f.path)).toEqualArray(['INBOX', 'Sent', 'Projekte']);
    });

    await it('skips lines that are not mailboxes', async () => {
      const folders = parseFolderList([
        '* LIST (\\HasNoChildren) "/" "INBOX"',
        'a1 OK LIST completed',
        '* OK [UIDVALIDITY 42] ok',
      ]);
      expect(folders.length).toBe(1);
    });
  });
};
