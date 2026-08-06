import { describe, expect, it } from '@gjsify/unit';

import {
  decodeRfc2047,
  formatImapDate,
  hasFlag,
  imapLiteralPlaceholder,
  parseEnvelope,
  parseFetchAttributes,
  parseSearchUids,
  quoteImapString,
  tokenizeImapList,
} from '@postbote/protocol';

// Pure IMAP-grammar tests — no network, no GJS, no PII (all synthetic data).

const FETCH_LINE =
  '* 12 FETCH (UID 999 FLAGS (\\Seen \\Flagged) RFC822.SIZE 4321 ENVELOPE ' +
  '("Sat, 14 Jun 2026 10:00:00 +0200" "Hello =?UTF-8?B?V29ybGQ=?=" ' +
  '(("Alice Example" NIL "alice" "example.com")) NIL NIL ' +
  '(("Bob" NIL "bob" "example.org")) (("Carol" NIL "carol" "example.net")) ' +
  'NIL NIL "<msgid@example.com>"))';

export default async () => {
  await describe('decodeRfc2047', async () => {
    await it('decodes base64 (B) encoded-words with their charset', async () => {
      expect(decodeRfc2047('=?UTF-8?B?w6TDtsO8?=')).toBe('äöü');
    });

    await it('decodes quoted (Q) encoded-words with a legacy charset', async () => {
      expect(decodeRfc2047('=?ISO-8859-1?Q?Caf=E9?=')).toBe('Café');
    });

    await it('collapses whitespace between adjacent encoded-words', async () => {
      expect(decodeRfc2047('=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?V29ybGQ=?=')).toBe('HelloWorld');
    });

    await it('keeps surrounding plain text and the space before a word', async () => {
      expect(decodeRfc2047('Re: =?UTF-8?B?V29ybGQ=?=')).toBe('Re: World');
    });

    await it('passes through text without encoded-words unchanged', async () => {
      expect(decodeRfc2047('plain subject')).toBe('plain subject');
    });
  });

  await describe('tokenizeImapList', async () => {
    await it('parses nested lists, quoted strings and NIL', async () => {
      expect(tokenizeImapList('(A "b c" NIL (D 1))')).toStrictEqual(['A', 'b c', null, ['D', '1']]);
    });

    await it('resolves literal placeholders against the literals array', async () => {
      expect(tokenizeImapList('(\x000\x00 "x")', ['literal value'])).toStrictEqual(['literal value', 'x']);
    });

    await it('unescapes quoted strings', async () => {
      expect(tokenizeImapList('("a\\"b\\\\c")')).toStrictEqual(['a"b\\c']);
    });
  });

  await describe('parseFetchAttributes + parseEnvelope', async () => {
    const items = tokenizeImapList(FETCH_LINE);
    const fetch = parseFetchAttributes(items);

    await it('extracts uid, flags and size', async () => {
      expect(fetch.uid).toBe('999');
      expect(fetch.flags).toStrictEqual(['\\Seen', '\\Flagged']);
      expect(fetch.size).toBe(4321);
    });

    await it('maps the ENVELOPE to subject/addresses/date/message-id', async () => {
      const env = parseEnvelope(fetch.envelope);
      expect(env.subject).toBe('Hello World');
      expect(env.from).toStrictEqual([{ name: 'Alice Example', email: 'alice@example.com' }]);
      expect(env.to).toStrictEqual([{ name: 'Bob', email: 'bob@example.org' }]);
      expect(env.cc).toStrictEqual([{ name: 'Carol', email: 'carol@example.net' }]);
      expect(env.date).toBe('2026-06-14T08:00:00.000Z');
      expect(env.messageId).toBe('<msgid@example.com>');
    });
  });

  await describe('helpers', async () => {
    await it('hasFlag is case-insensitive', async () => {
      expect(hasFlag(['\\Seen'], '\\seen')).toBe(true);
      expect(hasFlag(['\\Seen'], '\\Flagged')).toBe(false);
    });

    await it('parseSearchUids reads the SEARCH untagged response', async () => {
      expect(parseSearchUids('* SEARCH 1 2 3 42\na1 OK SEARCH completed')).toStrictEqual([1, 2, 3, 42]);
      expect(parseSearchUids('* SEARCH\na1 OK')).toStrictEqual([]);
    });

    await it('formatImapDate renders the IMAP date form', async () => {
      expect(formatImapDate('2026-06-14')).toBe('14-Jun-2026');
    });

    await it('quoteImapString escapes backslashes and quotes', async () => {
      expect(quoteImapString('a"b\\c')).toBe('"a\\"b\\\\c"');
    });
  });

  await describe('imapLiteralPlaceholder', async () => {
    await it('round-trips with the tokenizer (writer ↔ reader share one marker)', async () => {
      const input = `(${imapLiteralPlaceholder(0)} ${imapLiteralPlaceholder(1)})`;
      expect(tokenizeImapList(input, ['first', 'second'])).toStrictEqual(['first', 'second']);
    });
  });
};
