/**
 * The write-ahead journal of the receive path.
 *
 * Baileys acknowledges a message to WhatsApp BEFORE it emits it (Socket/messages-recv.ts: the
 * `sendReceipt` in `handleMessage` runs before `upsertMessage`), and WhatsApp deletes what was
 * acknowledged. Between that event and the index transaction that stores it, the message
 * exists only in this process — a crash, a SIGKILL, an OOM there would lose it for good. So the
 * event handler appends every mapped event here, synchronously and fsync'ed, before it returns
 * to Baileys; the store engine's next `nextBatch()` call (its acknowledgement that the previous
 * batch is committed) drops that batch from the journal; and a session that finds a journal
 * left by a crash replays it into the store before anything new.
 *
 * Format: one JSON-serialized `DeliveryEvent` per line. A torn last line (the crash hit the
 * write) is skipped — its event never finished reaching the disk, so nothing that WAS written
 * is lost with it. Replaying an event the store already has is harmless: every write is keyed
 * (a message row by chat and id), so recovery yields each message exactly once.
 *
 * Where: `<account id>.journal` next to the account's session file, in the backend's secrets
 * directory (0700; the file 0600). It holds message content, so it needs at least the index's
 * protection, and the secrets tier gives more (encrypted in backups). It is also the only
 * directory a backend is handed (`BackendContext.secretsDir`) — the index location is the
 * store's business. The file is empty whenever no sync is running or the last one ended well.
 */

import type { DeliveryEvent } from '@postbote/protocol';
import { ensurePrivateDir } from '@postbote/store';
import { Buffer } from 'node:buffer';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** What the receiver needs from a journal — a test can hand in one that fails on purpose. */
export interface EventJournal {
  /** Events a crashed run left behind, to be written before anything new. */
  readonly recovered: readonly DeliveryEvent[];
  /** Append durably: returns only once the events are on disk. */
  append(events: readonly DeliveryEvent[]): void;
  /** Bytes written so far — the mark a handed-out batch ends at. */
  size(): number;
  /** Drop everything before `mark`: that batch is committed to the index. */
  release(mark: number): void;
  close(): void;
}

export class FileJournal implements EventJournal {
  readonly path: string;
  readonly recovered: DeliveryEvent[];
  private fd: number;
  private bytes: number;

  private constructor(path: string, recovered: DeliveryEvent[], bytes: number) {
    this.path = path;
    this.recovered = recovered;
    this.bytes = bytes;
    this.fd = FileJournal.openAppend(path);
  }

  private static openAppend(path: string): number {
    const fd = openSync(path, 'a', 0o600);
    // Again after open: a file restored from elsewhere may carry another mode.
    chmodSync(path, 0o600);
    return fd;
  }

  static open(path: string): FileJournal {
    ensurePrivateDir(dirname(path));
    if (!existsSync(path)) return new FileJournal(path, [], 0);
    const text = readFileSync(path, 'utf8');
    const recovered: DeliveryEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        recovered.push(JSON.parse(line) as DeliveryEvent);
      } catch {
        // The torn tail of a write the crash interrupted: that event never fully reached the disk.
      }
    }
    return new FileJournal(path, recovered, Buffer.byteLength(text));
  }

  append(events: readonly DeliveryEvent[]): void {
    if (events.length === 0) return;
    const chunk = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeSync(this.fd, chunk);
    fsyncSync(this.fd);
    this.bytes += Buffer.byteLength(chunk);
  }

  size(): number {
    return this.bytes;
  }

  release(mark: number): void {
    if (mark <= 0) return;
    if (mark >= this.bytes) {
      ftruncateSync(this.fd, 0);
      fsyncSync(this.fd);
      this.bytes = 0;
      return;
    }
    // Events arrived after the released batch: keep them, atomically (write, fsync, rename).
    const rest = readFileSync(this.path).subarray(mark);
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, rest);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    closeSync(this.fd);
    renameSync(tmp, this.path);
    this.fd = FileJournal.openAppend(this.path);
    this.bytes = rest.length;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Where an account's journal lives: next to its session file. */
export function journalPath(sessionFile: string): string {
  return sessionFile.replace(/\.db$/, '.journal');
}
