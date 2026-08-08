/**
 * Writing an attachment to disk, safely.
 *
 * `safeFileName` in @postbote/protocol has already reduced a hostile MIME name to one path
 * segment. This is DEFENCE IN DEPTH on top of that, not a substitute: the resolved path is
 * checked to still be inside the target directory, so a bug or a future change in the sanitizer
 * cannot turn into a write outside it.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { type LiteralSink, safeFileName } from '@postbote/protocol';

/** True when `target` is `dir` itself or below it, after both are fully resolved. */
export function isInside(dir: string, target: string): boolean {
  const base = resolve(dir);
  const path = resolve(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Resolve a safe absolute path for a downloaded file, refusing to leave `dir`.
 *
 * Never overwrites: an existing name gains ` (2)`, ` (3)`, … A silent overwrite of a file the
 * user already has is data loss caused by a stranger choosing a filename.
 */
export function resolveDownloadPath(dir: string, rawName: string | null, fallback = 'attachment'): string {
  const name = safeFileName(rawName, fallback);
  const target = resolve(join(dir, name));
  if (!isInside(dir, target)) {
    // Unreachable via safeFileName, which returns a single segment. Kept because "unreachable"
    // is a property of today's code, and this is the check that makes it a property of any code.
    throw new Error(`refusing to write outside ${dir}`);
  }

  if (!existsSync(target)) return target;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = resolve(join(dir, `${stem} (${n})${ext}`));
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`too many files named like ${name} in ${dir}`);
}

/**
 * A sink that writes to a temporary file and renames it into place only on success.
 *
 * Two properties matter:
 *   - Mode 0600 from creation, because an attachment is private mail. Creating it 0644 and
 *     chmod-ing after leaves a window where it is world-readable.
 *   - `.part` + rename, so a failed or refused transfer leaves NO file. A half-written PDF that
 *     opens and shows the first three pages is worse than no file at all.
 */
export class FileSink implements LiteralSink {
  readonly path: string;
  private readonly tmpPath: string;
  private fd: number | null = null;
  private written = 0;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error(`FileSink needs an absolute path, got ${path}`);
    this.path = path;
    this.tmpPath = `${path}.part`;
    // gjsify gap (unfixed, draft gjsify#1035): openSync's 'wx' falls through to plain 'w' on GJS
    // (fopen(3) has no exclusive mode), so it TRUNCATES an existing .part instead of throwing
    // EEXIST — two concurrent saves would interleave into one file. This pre-check is
    // load-bearing; do NOT remove it on a version bump. Once 'wx' enforces this upstream, drop
    // the check — the flag is atomic and a check is not.
    if (existsSync(this.tmpPath)) {
      const err = new Error(`EEXIST: transfer already in progress, open '${this.tmpPath}'`);
      (err as NodeJS.ErrnoException).code = 'EEXIST';
      throw err;
    }
    this.fd = openSync(this.tmpPath, 'wx', 0o600);
    // gjsify gap (unfixed, draft gjsify#1035): openSync IGNORES its mode argument on GJS
    // (GLib.IOChannel has no mode-aware open, and the parsed `mode` is never applied), so the
    // file is created 0644 — world-readable private mail. This chmod immediately narrows it and
    // is load-bearing; do NOT remove it on a version bump. It leaves a brief window where the
    // file is not 0600, which is why the real fix belongs in the open itself.
    chmodSync(this.tmpPath, 0o600);
  }

  write(chunk: Uint8Array): void {
    if (this.fd === null) throw new Error('write after close');
    // The explicit position is not optional here. gjsify gap (unfixed, draft gjsify#1035):
    // writeSync tracks no write cursor on GJS, so `writeSync(fd, chunk)` restarts at offset 0
    // every call and a streamed download ends up holding only its LAST chunk. Passing the offset
    // is correct on Node too, so this stays valid after any upstream fix — it simply stops being
    // load-bearing.
    writeSync(this.fd, chunk, 0, chunk.length, this.written);
    this.written += chunk.length;
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
    renameSync(this.tmpPath, this.path);
  }

  abort(_reason: string): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    // Best effort: if the temp file is already gone, there is nothing to clean up.
    try {
      unlinkSync(this.tmpPath);
    } catch {
      // The failure that matters — a leftover .part — is visible and harmless; a throw here
      // would mask the real error that caused the abort.
    }
  }

  get bytesWritten(): number {
    return this.written;
  }
}

/**
 * Create a directory that will hold private mail, mode 0700.
 *
 * The chmod is not redundant. gjsify gap (unfixed, draft gjsify#1035): `mkdirSync` drops its
 * `mode` option the same way `openSync` drops its mode argument, so the directory is created
 * 0755 — and for the index directory that mode is the ONLY thing protecting SQLite's `-wal`
 * companion, which SQLite creates 0644 and which holds recently written message bodies.
 *
 * Applied on every call rather than only at creation, so a directory whose mode drifted once
 * does not stay wrong forever.
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A directory this process does not own (an odd mount, a shared drive) is not a reason to
    // refuse to work — but it IS a reason not to pretend the mode was applied.
  }
  return dir;
}
