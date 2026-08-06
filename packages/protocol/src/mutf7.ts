/**
 * Modified UTF-7 for IMAP mailbox names (RFC 3501 §5.1.3).
 *
 * IMAP mailbox names are 7-bit. Anything outside printable US-ASCII is carried as modified
 * BASE64 of the name's UTF-16BE bytes, wrapped in `&` … `-`. Two deviations from RFC 2152 UTF-7
 * matter: the alphabet uses `,` where BASE64 uses `/` (because `/` is a common hierarchy
 * delimiter), and the padding `=` is omitted.
 *
 * Without this, `SELECT` is handed a raw UTF-8 name and every non-ASCII mailbox — `Gelöschte
 * Elemente`, `Entwürfe`, `Wysłane` — simply fails.
 *
 * Written by hand rather than through `gi://Camel`: the IMAP stack here is deliberately
 * Camel-free so it stays testable on Node. `Camel.utf7_utf8()` is introspectable, though, and
 * makes a good differential oracle on GJS for cases handwritten tests would not think of.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';

/** Printable US-ASCII, the range that represents itself (RFC 3501: 0x20–0x7e). */
function isDirectlyRepresentable(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

/** Modified BASE64 of a run of UTF-16 code units (big-endian, unpadded, `,` for `/`). */
function encodeRun(units: number[]): string {
  const bytes: number[] = [];
  for (const unit of units) {
    bytes.push((unit >> 8) & 0xff, unit & 0xff);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64[b2 & 0x3f];
  }
  return out;
}

/** Decode modified BASE64 back into a string of UTF-16 code units. */
function decodeRun(encoded: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of encoded) {
    const value = B64.indexOf(ch);
    if (value < 0) continue; // tolerate stray characters rather than throwing on a real mailbox
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  let out = '';
  // Pairs of bytes are UTF-16BE code units. Surrogate pairs need no special handling: emitting
  // both halves as code units recombines them, which is exactly how JS stores them anyway.
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}

/** Encode a display name to the wire form IMAP commands must use. */
export function encodeMutf7(name: string): string {
  let out = '';
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out += `&${encodeRun(run)}-`;
    run = [];
  };
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (isDirectlyRepresentable(code)) {
      flush();
      // `&` is the shift character, so a literal one is escaped as the empty run `&-`.
      out += code === 0x26 ? '&-' : name[i];
    } else {
      run.push(code);
    }
  }
  flush();
  return out;
}

/** Decode a wire mailbox name to its display form. */
export function decodeMutf7(name: string): string {
  let out = '';
  let i = 0;
  while (i < name.length) {
    if (name[i] !== '&') {
      out += name[i];
      i++;
      continue;
    }
    const end = name.indexOf('-', i + 1);
    if (end < 0) {
      // Unterminated shift — a malformed name. Keep the rest verbatim rather than throwing:
      // this is a real mailbox someone has, and refusing to list it is worse than showing it oddly.
      out += name.slice(i);
      break;
    }
    const run = name.slice(i + 1, end);
    out += run.length === 0 ? '&' : decodeRun(run);
    i = end + 1;
  }
  return out;
}
