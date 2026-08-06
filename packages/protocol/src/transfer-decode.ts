/**
 * Streaming Content-Transfer-Encoding decoders.
 *
 * `BODY.PEEK[<section>]` returns a part exactly as encoded on the wire, so a fetched PDF is
 * base64 text, not a PDF. Decoding has to happen WHILE streaming — buffering a 20 MB attachment
 * to decode it in one go gives back the memory cost that streaming exists to avoid.
 *
 * The interesting part is that chunk boundaries fall anywhere: a base64 quantum can be split
 * across two reads, and a quoted-printable `=3D` can arrive as `=` then `3D`. Each decoder is
 * therefore a small state machine that carries the incomplete tail forward.
 */

import type { LiteralSink } from './sink.ts';

const B64_INVALID = -1;

function b64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 97 + 26; // a-z
  if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9
  if (code === 43) return 62; // +
  if (code === 47) return 63; // /
  return B64_INVALID; // whitespace, '=', anything else
}

/** Streaming base64 decoder. Ignores whitespace and stops at the first padding. */
class Base64Decoder {
  private quantum = 0;
  private count = 0;
  private done = false;

  push(chunk: Uint8Array, emit: (bytes: Uint8Array) => void): void {
    if (this.done) return;
    // Worst case 3 bytes out per 4 in, plus the carried quantum.
    const out = new Uint8Array(Math.ceil((chunk.length + 3) * 0.75));
    let n = 0;
    for (const code of chunk) {
      if (code === 61) {
        // '=' — padding. Everything after it is padding or trailing whitespace.
        this.done = true;
        break;
      }
      const value = b64Value(code);
      if (value === B64_INVALID) continue; // CR, LF, spaces
      this.quantum = (this.quantum << 6) | value;
      this.count++;
      if (this.count === 4) {
        out[n++] = (this.quantum >> 16) & 0xff;
        out[n++] = (this.quantum >> 8) & 0xff;
        out[n++] = this.quantum & 0xff;
        this.quantum = 0;
        this.count = 0;
      }
    }
    if (n > 0) emit(out.subarray(0, n));
  }

  /** Emit the bytes of a final, unpadded partial quantum. */
  flush(emit: (bytes: Uint8Array) => void): void {
    // 2 leftover characters encode 1 byte, 3 encode 2. A single leftover character carries no
    // whole byte and is discarded — that input was malformed either way.
    if (this.count === 2) {
      emit(Uint8Array.of((this.quantum >> 4) & 0xff));
    } else if (this.count === 3) {
      emit(Uint8Array.of((this.quantum >> 10) & 0xff, (this.quantum >> 2) & 0xff));
    }
    this.quantum = 0;
    this.count = 0;
  }
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/** Streaming quoted-printable decoder, carrying an incomplete `=XX` across chunks. */
class QuotedPrintableDecoder {
  /** Bytes seen after a `=` that has not yet resolved (0–2 of them). */
  private pending: number[] = [];

  push(chunk: Uint8Array, emit: (bytes: Uint8Array) => void): void {
    const out = new Uint8Array(chunk.length + 2);
    let n = 0;
    for (const code of chunk) {
      if (this.pending.length === 0) {
        if (code === 61)
          this.pending.push(code); // '='
        else out[n++] = code;
        continue;
      }
      this.pending.push(code);
      if (this.pending.length === 2) {
        // "=\n" is a soft line break: it and the newline vanish.
        if (code === 10) this.pending = [];
        // "=\r" needs one more byte to tell "=\r\n" from a malformed sequence.
        continue;
      }
      // Three bytes: "=XX", "=\r\n", or malformed.
      const [, a, b] = this.pending;
      if (a === 13 && b === 10) {
        this.pending = []; // soft break
        continue;
      }
      const hi = hexValue(a);
      const lo = hexValue(b);
      if (hi >= 0 && lo >= 0) {
        out[n++] = (hi << 4) | lo;
      } else {
        // Malformed: keep the bytes verbatim rather than dropping data.
        out[n++] = 61;
        out[n++] = a;
        out[n++] = b;
      }
      this.pending = [];
    }
    if (n > 0) emit(out.subarray(0, n));
  }

  flush(emit: (bytes: Uint8Array) => void): void {
    if (this.pending.length > 0) emit(Uint8Array.from(this.pending));
    this.pending = [];
  }
}

/**
 * Wrap a sink so bytes are transfer-decoded on the way through.
 *
 * `7bit`, `8bit`, `binary` and anything unrecognised pass through untouched — an unknown
 * encoding is far more likely to be an identity one than a reason to fail the download.
 */
export function decodingSink(encoding: string, inner: LiteralSink): LiteralSink {
  const enc = encoding.trim().toLowerCase();

  if (enc === 'base64' || enc === 'quoted-printable') {
    const decoder = enc === 'base64' ? new Base64Decoder() : new QuotedPrintableDecoder();
    // Chunks are written synchronously into `pending` and awaited in order, so the inner sink
    // still sees strictly ordered writes.
    let chain: Promise<void> = Promise.resolve();
    const emit = (bytes: Uint8Array) => {
      const copy = bytes.slice();
      chain = chain.then(() => inner.write(copy));
    };
    return {
      write(chunk: Uint8Array) {
        decoder.push(chunk, emit);
        return chain;
      },
      async close() {
        decoder.flush(emit);
        await chain;
        await inner.close();
      },
      async abort(reason: string) {
        await inner.abort(reason);
      },
    };
  }

  return inner;
}
