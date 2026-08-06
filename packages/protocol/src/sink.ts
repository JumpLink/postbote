/**
 * The port a streamed transfer writes through.
 *
 * Declared here, in the pure package, so the IMAP layer can stream an attachment without
 * knowing whether the other end is a file, a buffer or a test double — and so the file-writing
 * implementation can live in `@postbote/store` with `node:fs`, keeping the write path free of
 * `gi://` and testable on Node.
 */

export interface LiteralSink {
  /** Called repeatedly with chunks in order. May be async; the caller awaits. */
  write(chunk: Uint8Array): void | Promise<void>;
  /** Called once after the last chunk, on success only. */
  close(): void | Promise<void>;
  /**
   * Called instead of close() when the transfer fails or is refused. Implementations must leave
   * no partial artefact behind — a half-written PDF that looks complete is worse than none.
   */
  abort(reason: string): void | Promise<void>;
}

/** An in-memory sink. For tests and for callers that genuinely want the bytes. */
export class BufferSink implements LiteralSink {
  private chunks: Uint8Array[] = [];
  private length = 0;
  aborted: string | null = null;
  closed = false;

  write(chunk: Uint8Array): void {
    // Copy: the reader hands out a view over its own buffer, which it reuses.
    this.chunks.push(chunk.slice());
    this.length += chunk.length;
  }

  close(): void {
    this.closed = true;
  }

  abort(reason: string): void {
    this.aborted = reason;
    this.chunks = [];
    this.length = 0;
  }

  /** The bytes written so far, concatenated. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
