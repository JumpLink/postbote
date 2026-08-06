import { describe, expect, it } from '@gjsify/unit';

import { decodeMutf7, encodeMutf7 } from '@postbote/protocol';

// The two Chinese/Japanese vectors are RFC 3501 §5.1.3's own examples; the German ones are the
// mailboxes that were actually broken before this existed — `SELECT` got a raw UTF-8 name and
// simply failed, so "Gelöschte Elemente" was unreachable.
const VECTORS: Array<[decoded: string, wire: string]> = [
  ['INBOX', 'INBOX'],
  ['~peter/mail/台北/日本語', '~peter/mail/&U,BTFw-/&ZeVnLIqe-'],
  ['Gelöschte Elemente', 'Gel&APY-schte Elemente'],
  ['Entwürfe', 'Entw&APw-rfe'],
  ['Wysłane', 'Wys&AUI-ane'],
  ['Отправленные', '&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-'],
  ['&', '&-'],
  ['a&b', 'a&-b'],
  ['R&D/Reports', 'R&-D/Reports'],
  ['', ''],
];

export default async () => {
  await describe('encodeMutf7', async () => {
    for (const [decoded, wire] of VECTORS) {
      await it(`encodes ${JSON.stringify(decoded)}`, async () => {
        expect(encodeMutf7(decoded)).toBe(wire);
      });
    }

    await it('leaves every printable ASCII character alone except &', async () => {
      const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i))
        .join('')
        .replace('&', '');
      expect(encodeMutf7(printable)).toBe(printable);
    });

    await it('coalesces a run of non-ASCII into ONE shifted sequence', async () => {
      // Not cosmetic: `&APY-&APw-` is a different byte string than `&APYA,A-`, and a server that
      // compares names literally treats them as two different mailboxes.
      //
      // This vector also pins the alphabet difference that defines MODIFIED UTF-7: plain BASE64
      // of these bytes ends `APYA/A`, and a `/` in a mailbox name would be read as a hierarchy
      // separator. RFC 3501 substitutes `,` precisely to avoid that.
      expect(encodeMutf7('öü')).toBe('&APYA,A-');
    });
  });

  await describe('decodeMutf7', async () => {
    for (const [decoded, wire] of VECTORS) {
      await it(`decodes ${JSON.stringify(wire)}`, async () => {
        expect(decodeMutf7(wire)).toBe(decoded);
      });
    }

    await it('round-trips anything encode produces', async () => {
      for (const name of [
        'INBOX/Gesendet',
        'Archiv/2025/Energieberater',
        'Ünïcödé/Ñèsted',
        '日本語',
        'emoji 📧 folder',
        '&&&',
        'Mixed &APY- literal',
      ]) {
        expect(decodeMutf7(encodeMutf7(name))).toBe(name);
      }
    });

    await it('keeps an unterminated shift verbatim rather than throwing', async () => {
      // A malformed name is still a real mailbox someone has; refusing to list it is worse than
      // listing it oddly.
      expect(decodeMutf7('Broken&APY')).toBe('Broken&APY');
    });

    await it('survives a surrogate pair', async () => {
      expect(decodeMutf7(encodeMutf7('📧'))).toBe('📧');
    });
  });
};
