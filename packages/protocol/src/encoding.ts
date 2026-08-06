/**
 * Pure, runtime-agnostic byte/charset helpers shared by the IMAP and MIME
 * parsers. No `gi://` imports — these run identically on Node (vitest) and GJS,
 * relying only on the WHATWG `TextDecoder` global both runtimes provide.
 */

/** Decode a base64 string (ignoring whitespace/invalid chars) to raw bytes. */
export function base64ToBytes(input: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    if (ch === '=') break;
    const value = table.indexOf(ch);
    if (value < 0) continue; // skip CR/LF/space and anything else
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Lossless 1:1 mapping of a latin1 (binary) string back to its bytes. */
export function latin1ToBytes(input: string): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff;
  return out;
}

/** Lossless 1:1 mapping of bytes to a latin1 (binary) string. */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  // Chunk to avoid blowing the call-stack on String.fromCharCode(...spread).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** Normalize a few common charset labels TextDecoder may not accept verbatim. */
function normalizeCharset(charset: string | undefined): string {
  if (!charset) return 'utf-8';
  const c = charset
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
  if (c === 'us-ascii' || c === 'ascii' || c === 'ansi_x3.4-1968') return 'utf-8';
  if (c === 'unknown-8bit' || c === '') return 'utf-8';
  return c;
}

/**
 * Decode bytes with the given charset, tolerating unknown labels and malformed
 * sequences (falls back to windows-1252, a safe western superset of latin1).
 */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
  }
}

/** Decode a quoted-printable body (handles soft line breaks and =XX escapes). */
export function quotedPrintableToBytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '=') {
      // Soft line break: "=\r\n" or "=\n".
      if (input[i + 1] === '\r' && input[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (input[i + 1] === '\n') {
        i += 1;
        continue;
      }
      const hex = input.slice(i + 1, i + 3);
      const value = Number.parseInt(hex, 16);
      if (!Number.isNaN(value) && /^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(value);
        i += 2;
        continue;
      }
      out.push(0x3d); // stray '=' kept verbatim
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
