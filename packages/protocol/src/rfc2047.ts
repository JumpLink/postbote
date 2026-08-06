/**
 * RFC 2047 MIME "encoded-word" decoding — pure, no I/O.
 *
 * Extracted from imap-parse.ts: both the IMAP ENVELOPE parser (subjects, display
 * names) and the MIME walker (attachment filenames) need this, and having
 * mime-parse.ts reach into imap-parse.ts for it made the two modules mutually
 * dependent. Header decoding belongs to neither — it is its own RFC.
 */

import { base64ToBytes, decodeBytes } from './encoding.ts';

/**
 * Decode RFC 2047 MIME "encoded-words" (`=?charset?B/Q?text?=`) in a header
 * value. Whitespace separating two adjacent encoded-words is dropped per spec.
 */
export function decodeRfc2047(input: string): string {
  if (!input || !input.includes('=?')) return input;
  const tokenRe = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let result = '';
  let lastIndex = 0;
  let prevWasEncoded = false;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(input)) !== null) {
    const between = input.slice(lastIndex, match.index);
    // Collapse whitespace between two encoded-words; keep it otherwise.
    if (!(prevWasEncoded && between.trim() === '')) result += between;
    const charset = match[1].split('*')[0]; // strip optional language tag
    const enc = match[2].toUpperCase();
    const text = match[3];
    const bytes = enc === 'B' ? base64ToBytes(text) : qEncodedWordToBytes(text);
    result += decodeBytes(bytes, charset);
    lastIndex = tokenRe.lastIndex;
    prevWasEncoded = true;
  }
  result += input.slice(lastIndex);
  return result;
}

/** Q-encoding used inside RFC 2047 words: '_' is space, '=XX' is a hex byte. */
function qEncodedWordToBytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '_') {
      out.push(0x20);
    } else if (ch === '=') {
      const hex = input.slice(i + 1, i + 3);
      out.push(Number.parseInt(hex, 16) & 0xff);
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
