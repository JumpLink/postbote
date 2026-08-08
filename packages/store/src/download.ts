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
    // 'wx' is doing two jobs: it creates the file 0600 from the start — never a moment where
    // private mail is world-readable — and it fails with EEXIST rather than truncating, so two
    // concurrent saves cannot interleave into one file. Both are atomic in the open; a check
    // beforehand and a chmod afterwards, which is what this used to do, are neither.
    this.fd = openSync(this.tmpPath, 'wx', 0o600);
  }

  write(chunk: Uint8Array): void {
    if (this.fd === null) throw new Error('write after close');
    writeSync(this.fd, chunk);
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
 * `mkdirSync` applies the mode at creation, so the chmod is not there to compensate for it. It
 * runs on EVERY call, which is the point: a directory whose mode drifted — created by an older
 * build, or widened by hand — is narrowed again rather than staying wrong forever. For the index
 * directory that mode is the ONLY thing protecting SQLite's `-wal` companion, which SQLite
 * creates 0644 and which holds recently written message bodies.
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
