import { describe, expect, it } from '@gjsify/unit';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensurePrivateDir, FileSink, isInside, resolveDownloadPath } from '@postbote/store';

/** A scratch directory under the system temp dir — never inside the repository. */
function scratch(): string {
  return ensurePrivateDir(mkdtempSync(join(tmpdir(), 'postbote-test-')));
}

export default async () => {
  await describe('isInside', async () => {
    await it('accepts the directory itself and anything below it', async () => {
      expect(isInside('/data', '/data')).toBe(true);
      expect(isInside('/data', '/data/file.pdf')).toBe(true);
      expect(isInside('/data', '/data/sub/file.pdf')).toBe(true);
      expect(isInside('/data/', '/data/file.pdf')).toBe(true);
    });

    await it('rejects an escape, including a PREFIX sibling', async () => {
      expect(isInside('/data', '/etc/passwd')).toBe(false);
      expect(isInside('/data', '/data/../etc/passwd')).toBe(false);
      // The subtle one: "/data-other" starts with "/data" as a string but is a different
      // directory. A naive startsWith check without the separator lets it through.
      expect(isInside('/data', '/data-other/file.pdf')).toBe(false);
    });
  });

  await describe('resolveDownloadPath', async () => {
    await it('sanitizes the name and keeps it inside the directory', async () => {
      const dir = scratch();
      try {
        expect(resolveDownloadPath(dir, '../../etc/passwd')).toBe(join(dir, 'passwd'));
        expect(resolveDownloadPath(dir, 'Rechnung.pdf')).toBe(join(dir, 'Rechnung.pdf'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('NEVER overwrites — it counts up instead', async () => {
      // A silent overwrite is data loss caused by a stranger picking a filename.
      const dir = scratch();
      try {
        writeFileSync(join(dir, 'report.pdf'), 'first');
        expect(resolveDownloadPath(dir, 'report.pdf')).toBe(join(dir, 'report (2).pdf'));
        writeFileSync(join(dir, 'report (2).pdf'), 'second');
        expect(resolveDownloadPath(dir, 'report.pdf')).toBe(join(dir, 'report (3).pdf'));
        // The counter goes before the extension, so the file still opens.
        expect(resolveDownloadPath(dir, 'report.pdf').endsWith('.pdf')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('uses the fallback for an unusable name', async () => {
      const dir = scratch();
      try {
        expect(resolveDownloadPath(dir, null, 'part-2.bin')).toBe(join(dir, 'part-2.bin'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('ensurePrivateDir', async () => {
    await it('creates the directory 0700, and re-applies it', async () => {
      // The chmod is not redundant: gjsify's mkdirSync drops its `mode` option the same way
      // openSync drops its mode argument, so the directory came out 0755. For the index
      // directory that mode is the ONLY protection on SQLite's `-wal` companion, which SQLite
      // creates 0644 and which holds recently written message bodies.
      const base = mkdtempSync(join(tmpdir(), 'postbote-mode-'));
      try {
        const dir = join(base, 'nested', 'private');
        ensurePrivateDir(dir);
        expect(statSync(dir).mode & 0o777).toBe(0o700);

        // A directory whose mode drifted must be corrected, not left alone.
        chmodSync(dir, 0o755);
        ensurePrivateDir(dir);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  await describe('FileSink', async () => {
    await it('writes chunks in order and renames into place on close', async () => {
      const dir = scratch();
      try {
        const path = join(dir, 'out.bin');
        const sink = new FileSink(path);
        // Mid-transfer there must be NO file at the final path — only the .part.
        expect(existsSync(path)).toBe(false);
        expect(existsSync(`${path}.part`)).toBe(true);
        sink.write(new TextEncoder().encode('hello '));
        sink.write(new TextEncoder().encode('world'));
        sink.close();
        expect(readFileSync(path, 'utf8')).toBe('hello world');
        expect(existsSync(`${path}.part`)).toBe(false);
        expect(sink.bytesWritten).toBe(11);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('creates the file 0600 — an attachment is private mail', async () => {
      // Regression cover for a real leak: gjsify's openSync ignores its mode argument, so the
      // file was created 0644 and every local user could read the user's mail attachments.
      const dir = scratch();
      try {
        const path = join(dir, 'private.bin');
        const sink = new FileSink(path);
        expect(statSync(`${path}.part`).mode & 0o777).toBe(0o600);
        sink.write(new TextEncoder().encode('secret'));
        sink.close();
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('leaves NOTHING behind on abort', async () => {
      // A half-written PDF that opens and shows the first three pages is worse than no file.
      const dir = scratch();
      try {
        const path = join(dir, 'out.bin');
        const sink = new FileSink(path);
        sink.write(new TextEncoder().encode('partial'));
        sink.abort('too large');
        expect(existsSync(path)).toBe(false);
        expect(existsSync(`${path}.part`)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('tolerates a second abort', async () => {
      const dir = scratch();
      try {
        const sink = new FileSink(join(dir, 'out.bin'));
        sink.abort('first');
        sink.abort('second'); // must not throw — abort runs in a finally-ish path
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a relative path', async () => {
      expect(() => new FileSink('relative/out.bin')).toThrow('absolute');
    });

    await it('refuses to reuse a .part already in progress', async () => {
      const dir = scratch();
      try {
        const path = join(dir, 'out.bin');
        const first = new FileSink(path);
        // Two concurrent saves must not interleave into one file.
        expect(() => new FileSink(path)).toThrow();
        first.abort('cleanup');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
