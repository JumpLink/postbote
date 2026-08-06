import { describe, expect, it } from '@gjsify/unit';

import { safeFileName } from '@postbote/protocol';

// A filename out of a message is attacker-controlled. Every case here is a way a hostile name
// escapes its directory or lies about what it is.
export default async () => {
  await describe('safeFileName — traversal', async () => {
    await it('takes the basename at / AND \\', async () => {
      expect(safeFileName('../../etc/passwd')).toBe('passwd');
      expect(safeFileName('/etc/shadow')).toBe('shadow');
      // Only stripping `/` leaves a Windows-style traversal intact on a mounted share.
      expect(safeFileName('..\\..\\Windows\\System32\\x.dll')).toBe('x.dll');
      expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    });

    await it('never returns . or ..', async () => {
      expect(safeFileName('..')).toBe('attachment');
      expect(safeFileName('.')).toBe('attachment');
      expect(safeFileName('../..')).toBe('attachment');
      expect(safeFileName('....//....//x')).toBe('x');
    });

    await it('strips a bidi override BEFORE checking for traversal', async () => {
      // Order matters: stripping U+202E afterwards would leave a `..` the traversal check had
      // already waved through.
      expect(safeFileName('.\u202e./.\u202e./etc/passwd')).toBe('passwd');
    });
  });

  await describe('safeFileName — spoofing', async () => {
    await it('removes the U+202E right-to-left override', async () => {
      // The classic display spoof: "report\u202Egpj.exe" renders as "reportexe.jpg".
      expect(safeFileName('report\u202egpj.exe')).toBe('reportgpj.exe');
    });

    await it('removes bidi isolates and zero-width characters', async () => {
      expect(safeFileName('in\u2066voi\u2069ce.pdf')).toBe('invoice.pdf');
      expect(safeFileName('in\u200bvoice.pdf')).toBe('invoice.pdf');
      expect(safeFileName('\ufeffinvoice.pdf')).toBe('invoice.pdf');
    });

    await it('removes control characters, including a newline', async () => {
      // A newline in a filename can forge a second line in any log that prints it.
      expect(safeFileName('inv\noice\t.pdf')).toBe('invoice.pdf');
      expect(safeFileName('a\u0000b.pdf')).toBe('ab.pdf');
      expect(safeFileName('a\u007fb.pdf')).toBe('ab.pdf');
    });
  });

  await describe('safeFileName — hostile shapes', async () => {
    await it('replaces characters that are illegal or shell-hostile', async () => {
      expect(safeFileName('a:b*c?d"e<f>g|h.pdf')).toBe('a_b_c_d_e_f_g_h.pdf');
    });

    await it('drops a leading dash, so the name cannot read as a flag', async () => {
      expect(safeFileName('--force.pdf')).toBe('force.pdf');
    });

    await it('drops leading dots, so the file is not hidden', async () => {
      expect(safeFileName('.hidden.pdf')).toBe('hidden.pdf');
    });

    await it('drops trailing dots and spaces that Windows would silently eat', async () => {
      // Left in place, "report.pdf." and "report.pdf" become the same file after a copy.
      expect(safeFileName('report.pdf. ')).toBe('report.pdf');
      expect(safeFileName('report.pdf   ')).toBe('report.pdf');
    });

    await it('escapes reserved device names', async () => {
      expect(safeFileName('CON')).toBe('_CON');
      expect(safeFileName('nul.txt')).toBe('_nul.txt');
      expect(safeFileName('LPT1.pdf')).toBe('_LPT1.pdf');
    });
  });

  await describe('safeFileName — ordinary names', async () => {
    await it('leaves a sensible name untouched', async () => {
      expect(safeFileName('Rechnung 2025-08.pdf')).toBe('Rechnung 2025-08.pdf');
      expect(safeFileName('Energieausweis_Bei-der-Kirche.pdf')).toBe('Energieausweis_Bei-der-Kirche.pdf');
    });

    await it('keeps non-ASCII, normalized to NFC', async () => {
      expect(safeFileName('Überweisung.pdf')).toBe('Überweisung.pdf');
      // Decomposed "U + combining diaeresis" must land on the same name as the composed form,
      // or the same attachment saves twice under two names that look identical.
      expect(safeFileName('U\u0308berweisung.pdf')).toBe('Überweisung.pdf');
    });

    await it('falls back rather than refusing to save', async () => {
      // The bytes are still what the user asked for; a hostile name is no reason to lose them.
      expect(safeFileName(null)).toBe('attachment');
      expect(safeFileName('')).toBe('attachment');
      expect(safeFileName('///')).toBe('attachment');
      expect(safeFileName(undefined, 'part-2.bin')).toBe('part-2.bin');
    });
  });

  await describe('safeFileName — length', async () => {
    await it('caps at 200 UTF-8 bytes but KEEPS the extension', async () => {
      const name = `${'a'.repeat(500)}.pdf`;
      const out = safeFileName(name);
      expect(out.endsWith('.pdf')).toBe(true);
      expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
    });

    await it('counts BYTES, not characters, and never splits a code point', async () => {
      // 'ä' is two UTF-8 bytes, so 150 of them exceed the cap even though the string is short.
      const out = safeFileName(`${'ä'.repeat(150)}.pdf`);
      expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
      expect(out.includes('\ufffd')).toBe(false);
      expect(out.endsWith('.pdf')).toBe(true);
    });
  });
};
