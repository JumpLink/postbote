import { describe, expect, it } from '@gjsify/unit';

import {
  extractHeaderFields,
  imapLiteralPlaceholder,
  parseEnvelope,
  parseFetchAttributes,
  parseMessageIdList,
  parseThreadHeaders,
  threadHeaderFetchItem,
  tokenizeImapList,
} from '@postbote/protocol';

// Threading and classification headers. Synthetic data only.

const HEADER_BLOCK =
  'References: <a1@example.org>\r\n <a2@example.org>\r\n' +
  "In-Reply-To: <a2@example.org> (Anna's message of Monday)\r\n" +
  'List-Id: =?UTF-8?Q?Verein_M=C3=BCnster?= <verein.example.org>\r\n' +
  'Precedence: bulk\r\n\r\n';

export default async () => {
  await describe('tokenizeImapList: FETCH sections with spaces', async () => {
    await it('keeps BODY[HEADER.FIELDS (…)] as ONE key, so later pairs stay aligned', async () => {
      // Split at its spaces, the key became three tokens and every following key/value pair
      // shifted by one — the UID would have been read as a value.
      const line = `* 3 FETCH (BODY[HEADER.FIELDS (REFERENCES LIST-ID)] ${imapLiteralPlaceholder(0)} UID 42 FLAGS (\\Seen))`;
      const items = tokenizeImapList(line, [HEADER_BLOCK]);
      expect(items.length).toBe(6);
      expect(items[0]).toBe('BODY[HEADER.FIELDS (REFERENCES LIST-ID)]');
      expect(parseFetchAttributes(items).uid).toBe('42');
      expect(extractHeaderFields(items)).toBe(HEADER_BLOCK);
    });

    await it('leaves a bracketed mailbox atom alone', async () => {
      // Only BODY/BINARY sections are special; `[Gmail]/Sent` is an ordinary atom.
      expect(tokenizeImapList('("/" [Gmail]/Sent)')).toEqualArray(['/', '[Gmail]/Sent']);
    });

    await it('asks for the headers with PEEK, so a sync never sets \\Seen', async () => {
      expect(threadHeaderFetchItem().startsWith('BODY.PEEK[HEADER.FIELDS (')).toBe(true);
      expect(threadHeaderFetchItem()).toContain('REFERENCES');
      expect(threadHeaderFetchItem()).toContain('LIST-UNSUBSCRIBE');
    });
  });

  await describe('parseMessageIdList', async () => {
    await it('returns bracketed ids in order, without duplicates or prose', async () => {
      expect(parseMessageIdList('<a@x> <b@x>\t<a@x> (a comment)')).toEqualArray(['<a@x>', '<b@x>']);
    });

    await it('ignores bare, unbracketed tokens rather than guessing', async () => {
      expect(parseMessageIdList('a@x')).toEqualArray([]);
      expect(parseMessageIdList(null)).toEqualArray([]);
    });
  });

  await describe('parseThreadHeaders', async () => {
    await it('unfolds References and takes the id out of a chatty In-Reply-To', async () => {
      const parsed = parseThreadHeaders(HEADER_BLOCK);
      expect(parsed.references).toEqualArray(['<a1@example.org>', '<a2@example.org>']);
      expect(parsed.inReplyTo).toBe('<a2@example.org>');
    });

    await it('decodes the automation headers and reports absent ones as null', async () => {
      const { automation } = parseThreadHeaders(HEADER_BLOCK);
      expect(automation.listId).toBe('Verein Münster <verein.example.org>');
      expect(automation.precedence).toBe('bulk');
      expect(automation.listUnsubscribe).toBe(null);
      expect(automation.autoSubmitted).toBe(null);
    });

    await it('yields empty threading for an empty block', async () => {
      const parsed = parseThreadHeaders('');
      expect(parsed.references.length).toBe(0);
      expect(parsed.inReplyTo).toBe(null);
    });
  });

  await describe('parseEnvelope in-reply-to', async () => {
    await it('reads the ENVELOPE in-reply-to field as the fallback source', async () => {
      const env = tokenizeImapList(
        '(NIL "Re: Hi" NIL NIL NIL NIL NIL NIL "<parent@example.org>" "<child@example.org>")',
      );
      expect(parseEnvelope(env).inReplyTo).toBe('<parent@example.org>');
      expect(parseEnvelope(tokenizeImapList('(NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL)')).inReplyTo).toBe(
        null,
      );
    });
  });
};
