import { describe, expect, it } from '@gjsify/unit';

import { parseMimeMessage } from '@postbote/protocol';

// Pure MIME parsing — synthetic messages, no network/PII. Bodies use CRLF (as
// IMAP delivers) in some cases and LF in others to exercise both separators.

export default async () => {
  await describe('parseMimeMessage', async () => {
    await it('reads a single text/plain part', async () => {
      const raw = ['Subject: hi', 'Content-Type: text/plain; charset=utf-8', '', 'Hello body'].join('\r\n');
      const msg = parseMimeMessage(raw);
      expect(msg.bodyText).toBe('Hello body');
      expect(msg.attachments).toStrictEqual([]);
    });

    await it('decodes quoted-printable with a legacy charset', async () => {
      const raw = [
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Caf=E9',
      ].join('\r\n');
      expect(parseMimeMessage(raw).bodyText).toBe('Café');
    });

    await it('decodes base64 utf-8', async () => {
      const raw = [
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        'w6Q=', // "ä"
      ].join('\r\n');
      expect(parseMimeMessage(raw).bodyText).toBe('ä');
    });

    await it('prefers text/plain over text/html in multipart/alternative', async () => {
      const raw = [
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML version</p>',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain wins',
        '--b--',
      ].join('\r\n');
      expect(parseMimeMessage(raw).bodyText).toBe('Plain wins');
    });

    await it('extracts body + attachment metadata from multipart/mixed (no bytes)', async () => {
      const raw = [
        'Content-Type: multipart/mixed; boundary="m"',
        '',
        '--m',
        'Content-Type: text/plain',
        '',
        'Body text',
        '--m',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQK',
        '--m--',
      ].join('\r\n');
      const msg = parseMimeMessage(raw);
      expect(msg.bodyText).toBe('Body text');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].filename).toBe('invoice.pdf');
      expect(msg.attachments[0].mimeType).toBe('application/pdf');
      expect(msg.attachments[0].size).toBeGreaterThan(0);
    });

    await it('decodes an RFC 2047 encoded attachment filename', async () => {
      const raw = [
        'Content-Type: multipart/mixed; boundary="m"',
        '',
        '--m',
        'Content-Type: text/plain',
        '',
        'see attached',
        '--m',
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment; filename="=?UTF-8?B?w6QucGRm?="', // "ä.pdf"
        '',
        'data',
        '--m--',
      ].join('\r\n');
      expect(parseMimeMessage(raw).attachments[0].filename).toBe('ä.pdf');
    });

    await it('falls back to stripped HTML when there is no text/plain', async () => {
      const raw = ['Content-Type: text/html; charset=utf-8', '', '<p>Hello</p><p>World</p>'].join('\r\n');
      const body = parseMimeMessage(raw).bodyText ?? '';
      expect(body).toContain('Hello');
      expect(body).toContain('World');
    });
  });
};
