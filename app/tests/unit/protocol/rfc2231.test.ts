import { describe, expect, it } from '@gjsify/unit';

import { decodeRfc2231Params } from '@postbote/protocol';

// Reassembling these is not cosmetic: the segments are useless separately, and a parser that
// only knows plain `filename=` produces "filename*0*" as the attachment name.
export default async () => {
  await describe('decodeRfc2231Params', async () => {
    await it('passes ordinary parameters through', async () => {
      expect(decodeRfc2231Params({ charset: 'UTF-8', name: 'x.pdf' }).name).toBe('x.pdf');
    });

    await it('decodes a single extended value with its charset', async () => {
      expect(decodeRfc2231Params({ 'filename*': "utf-8''%C3%9Cberweisung.pdf" }).filename).toBe(
        'Überweisung.pdf',
      );
    });

    await it('honours a charset that is not UTF-8', async () => {
      // RFC 2231's own example form; latin-1 %E4 is 'ä' and would be a replacement char if the
      // charset were ignored.
      expect(decodeRfc2231Params({ 'filename*': "iso-8859-1''M%E4rz.pdf" }).filename).toBe('März.pdf');
    });

    await it('joins plain continuations in index order', async () => {
      expect(
        decodeRfc2231Params({ 'filename*0': 'a-very-', 'filename*1': 'long-', 'filename*2': 'name.pdf' })
          .filename,
      ).toBe('a-very-long-name.pdf');
    });

    await it('joins extended continuations, taking the charset from segment 0', async () => {
      expect(
        decodeRfc2231Params({ 'filename*0*': "utf-8''%C3%9Cberweisung%20", 'filename*1*': 'Januar.pdf' })
          .filename,
      ).toBe('Überweisung Januar.pdf');
    });

    await it('sorts numerically, not lexically', async () => {
      // '10' sorts before '2' as a string, which silently scrambles any name over ten segments.
      const params: Record<string, string> = {};
      for (let i = 0; i < 12; i++) params[`filename*${i}`] = String(i % 10);
      expect(decodeRfc2231Params(params).filename).toBe('012345678901');
    });

    await it('lets a continuation win over a plain fallback of the same name', async () => {
      // A sender emitting both means the plain one as a lossy ASCII substitute.
      const out = decodeRfc2231Params({
        filename: 'Uberweisung.pdf',
        'filename*0*': "utf-8''%C3%9Cberweisung.pdf",
      });
      expect(out.filename).toBe('Überweisung.pdf');
    });

    await it('lowercases keys so lookups are stable', async () => {
      expect(decodeRfc2231Params({ FILENAME: 'x.pdf' }).filename).toBe('x.pdf');
      expect(decodeRfc2231Params({ 'FileName*': "utf-8''y.pdf" }).filename).toBe('y.pdf');
    });

    await it('tolerates a malformed extended value instead of throwing', async () => {
      // Missing the language field entirely — seen in the wild, and a real attachment.
      expect(decodeRfc2231Params({ 'filename*': 'no-apostrophes.pdf' }).filename).toBe('no-apostrophes.pdf');
    });

    await it('keeps apostrophes that appear inside the value', async () => {
      expect(decodeRfc2231Params({ 'filename*': "utf-8''it%27s%20mine.pdf" }).filename).toBe("it's mine.pdf");
    });
  });
};
