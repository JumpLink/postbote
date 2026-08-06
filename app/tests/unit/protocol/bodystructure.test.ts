import { describe, expect, it } from '@gjsify/unit';

import { attachmentParts, pickBodyPart, tokenizeImapList, walkBodyStructure } from '@postbote/protocol';

/** Tokenize a bare BODYSTRUCTURE literal into the nested list the walker consumes. */
function parse(structure: string) {
  return walkBodyStructure(tokenizeImapList(structure));
}

const TEXT_ONLY = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 1234 42)';

const ALTERNATIVE_WITH_PDF =
  '(' +
  '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 500 12)' +
  '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 900 20)' +
  ' "ALTERNATIVE" ("BOUNDARY" "inner") NIL NIL)' +
  '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 20000 NIL ' +
  '("ATTACHMENT" ("FILENAME" "report.pdf")) NIL)' +
  ' "MIXED" ("BOUNDARY" "outer") NIL NIL)';

export default async () => {
  await describe('section numbering (RFC 3501 §6.4.5)', async () => {
    await it('numbers a single-part message as 1, not the empty section', async () => {
      const parts = parse(TEXT_ONLY);
      expect(parts.length).toBe(1);
      expect(parts[0].section).toBe('1');
      expect(parts[0].mimeType).toBe('text/plain');
      expect(parts[0].size).toBe(1234);
      expect(parts[0].lines).toBe(42);
    });

    await it('gives a TOP-level multipart no number of its own', async () => {
      // The trap: children are `1`, `2` — never `0.1`. A container section of `""` would make
      // BODY[.1] and nothing would fetch.
      const parts = parse(ALTERNATIVE_WITH_PDF);
      const fetchable = parts.filter((p) => !p.multipart).map((p) => p.section);
      expect(fetchable).toEqualArray(['1.1', '1.2', '2']);
    });

    await it('numbers a NESTED multipart and its children', async () => {
      const parts = parse(ALTERNATIVE_WITH_PDF);
      const container = parts.find((p) => p.multipart);
      expect(container?.section).toBe('1');
      expect(container?.mimeType).toBe('multipart/alternative');
    });

    await it("numbers an encapsulated message's parts UNDER its section", async () => {
      // MESSAGE/RFC822 at 2 whose body is multipart → 2.1, 2.2 (RFC 3501's own example uses 3).
      const forwarded =
        '(' +
        '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5)' +
        '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 5000 ' +
        '("Tue, 6 Aug 2026 10:00:00 +0200" "Fwd" NIL NIL NIL NIL NIL NIL NIL NIL) ' +
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 200 8)' +
        '("APPLICATION" "PDF" ("NAME" "inner.pdf") NIL NIL "BASE64" 900 NIL) ' +
        '"MIXED" ("BOUNDARY" "b") NIL NIL) 120 NIL NIL NIL)' +
        ' "MIXED" ("BOUNDARY" "outer") NIL NIL)';
      const parts = parse(forwarded);
      expect(parts.filter((p) => !p.multipart).map((p) => p.section)).toEqualArray(['1', '2', '2.1', '2.2']);
      expect(parts.find((p) => p.section === '2.2')?.filename).toBe('inner.pdf');
    });

    await it('numbers a SINGLE-part encapsulated message as N.1, not N', async () => {
      // The subtle half of the same rule: the inner body is 2.1 even though it is not multipart.
      // Reusing the outer section would emit two parts claiming section 2.
      const forwarded =
        '(' +
        '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5)' +
        '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 900 ' +
        '("Tue, 6 Aug 2026 10:00:00 +0200" "Fwd" NIL NIL NIL NIL NIL NIL NIL NIL) ' +
        '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 300 9) 20 NIL NIL NIL)' +
        ' "MIXED" ("BOUNDARY" "outer") NIL NIL)';
      expect(
        parse(forwarded)
          .filter((p) => !p.multipart)
          .map((p) => p.section),
      ).toEqualArray(['1', '2', '2.1']);
    });

    await it('returns nothing for a non-list structure rather than throwing', async () => {
      expect(walkBodyStructure(null).length).toBe(0);
      expect(walkBodyStructure('NIL').length).toBe(0);
    });
  });

  await describe('part metadata', async () => {
    await it('reads encoding, size and the attachment filename', async () => {
      const pdf = parse(ALTERNATIVE_WITH_PDF).find((p) => p.section === '2');
      expect(pdf?.mimeType).toBe('application/pdf');
      expect(pdf?.encoding).toBe('BASE64');
      // The size is the ENCODED octet count — what a fetch actually transfers, which is what a
      // size cap has to be checked against.
      expect(pdf?.size).toBe(20000);
      expect(pdf?.disposition).toBe('attachment');
      expect(pdf?.filename).toBe('report.pdf');
    });

    await it('decodes an RFC 2231 split filename', async () => {
      const s =
        '("APPLICATION" "PDF" ("NAME*0*" "utf-8\'\'%C3%9Cberweisung%20" "NAME*1*" "Januar.pdf") ' +
        'NIL NIL "BASE64" 100 NIL NIL NIL)';
      expect(parse(s)[0].filename).toBe('Überweisung Januar.pdf');
    });

    await it('decodes an RFC 2047 encoded-word filename', async () => {
      // Illegal in a MIME parameter, but senders do it constantly.
      const s =
        '("APPLICATION" "PDF" ("NAME" "=?utf-8?Q?Rechnung_M=C3=A4rz?=.pdf") NIL NIL "BASE64" 100 NIL NIL NIL)';
      expect(parse(s)[0].filename).toBe('Rechnung März.pdf');
    });

    await it('falls back to the Content-Type name when no disposition is given', async () => {
      const s = '("IMAGE" "PNG" ("NAME" "chart.png") NIL NIL "BASE64" 4096 NIL)';
      const part = parse(s)[0];
      expect(part.filename).toBe('chart.png');
      expect(part.disposition).toBe(null);
    });
  });

  await describe('attachmentParts', async () => {
    await it('finds the attachment and ignores the body parts', async () => {
      expect(attachmentParts(parse(ALTERNATIVE_WITH_PDF)).map((p) => p.section)).toEqualArray(['2']);
    });

    await it('counts a named part with NO disposition as an attachment', async () => {
      // Common enough to matter: plenty of senders attach a PDF with only a `name` parameter,
      // and requiring `disposition === attachment` would make it invisible.
      const s = '("APPLICATION" "PDF" ("NAME" "quote.pdf") NIL NIL "BASE64" 100 NIL)';
      expect(attachmentParts(parse(s)).length).toBe(1);
    });

    await it('does NOT count an inline image as an attachment', async () => {
      const s =
        '("IMAGE" "PNG" ("NAME" "logo.png") "<logo>" NIL "BASE64" 100 NIL ("INLINE" ("FILENAME" "logo.png")) NIL)';
      expect(attachmentParts(parse(s)).length).toBe(0);
    });

    await it('never returns a multipart container', async () => {
      for (const p of attachmentParts(parse(ALTERNATIVE_WITH_PDF))) expect(p.multipart).toBe(false);
    });
  });

  await describe('pickBodyPart', async () => {
    await it('prefers text/plain over text/html', async () => {
      expect(pickBodyPart(parse(ALTERNATIVE_WITH_PDF))?.section).toBe('1.1');
    });

    await it('falls back to text/html when there is no plain part', async () => {
      const s =
        '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 900 20)' +
        '("APPLICATION" "PDF" ("NAME" "x.pdf") NIL NIL "BASE64" 100 NIL) "MIXED" ("BOUNDARY" "b") NIL NIL)';
      const body = pickBodyPart(parse(s));
      expect(body?.mimeType).toBe('text/html');
      expect(body?.section).toBe('1');
    });

    await it('never picks an attached .txt as the body', async () => {
      const s =
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5)' +
        '("TEXT" "PLAIN" ("NAME" "notes.txt") NIL NIL "7BIT" 900 30 ' +
        '("ATTACHMENT" ("FILENAME" "notes.txt")) NIL) "MIXED" ("BOUNDARY" "b") NIL NIL)';
      expect(pickBodyPart(parse(s))?.section).toBe('1');
    });

    await it('returns null when there is no text part at all', async () => {
      const s = '("APPLICATION" "PDF" ("NAME" "only.pdf") NIL NIL "BASE64" 100 NIL)';
      expect(pickBodyPart(parse(s))).toBe(null);
    });
  });
};
