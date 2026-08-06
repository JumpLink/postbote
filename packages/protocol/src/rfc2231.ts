/**
 * RFC 2231 parameter continuations and extended values.
 *
 * MIME parameters cannot carry non-ASCII directly and are length-limited, so a long or
 * non-ASCII filename arrives split and percent-encoded:
 *
 *   filename*0*=utf-8''%C3%9Cberweisung%20
 *   filename*1*=Januar.pdf
 *
 * Reassembling this is not cosmetic — the parts are useless separately, and a parser that only
 * understands plain `filename=` silently produces `filename*0*` as an attachment name.
 *
 * RFC 2047 encoded-words (`=?utf-8?B?…?=`) are a DIFFERENT mechanism that is technically not
 * allowed here but appears in the wild anyway; callers apply `decodeRfc2047` to whatever this
 * returns, which is harmless for correctly-encoded values.
 */

import { decodeBytes } from './encoding.ts';

/** Percent-decode an RFC 2231 extended value's octets. */
function percentDecodeToBytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%') {
      // A short or non-hex tail fails this test, so no explicit bounds check is needed.
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(value.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

/**
 * Split an extended value `charset'language'text` into its charset and text.
 * Only the first two apostrophes are separators; the text may contain more.
 */
function splitExtended(value: string): { charset: string | undefined; text: string } {
  const first = value.indexOf("'");
  if (first < 0) return { charset: undefined, text: value };
  const second = value.indexOf("'", first + 1);
  if (second < 0) return { charset: undefined, text: value };
  return { charset: value.slice(0, first) || undefined, text: value.slice(second + 1) };
}

interface Segment {
  index: number;
  value: string;
  extended: boolean;
}

/**
 * Reassemble RFC 2231 continuations in a parameter map, returning a plain map of decoded
 * values. Keys that use no continuation syntax pass through untouched.
 */
export function decodeRfc2231Params(params: Record<string, string>): Record<string, string> {
  const segments = new Map<string, Segment[]>();
  const plain: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(params)) {
    // `name`, `name*`, `name*0`, `name*0*`
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawKey);
    if (!m) {
      plain[rawKey.toLowerCase()] = value;
      continue;
    }
    const [, base, index, star] = m;
    const key = base.toLowerCase();
    if (index === undefined && !star) {
      // A plain `name=` must not clobber a reassembled `name*0*=` — the continuation wins,
      // because a sender that emits both uses the plain one as a lossy ASCII fallback.
      if (!(key in plain)) plain[key] = value;
      continue;
    }
    const list = segments.get(key) ?? [];
    list.push({ index: index === undefined ? 0 : Number.parseInt(index, 10), value, extended: !!star });
    segments.set(key, list);
  }

  for (const [key, list] of segments) {
    list.sort((a, b) => a.index - b.index);
    // The charset is declared once, on the first extended segment; later segments carry raw
    // percent-encoded octets of that same charset.
    let charset: string | undefined;
    let text = '';
    for (const seg of list) {
      let piece = seg.value;
      if (seg.extended && seg.index === list[0].index) {
        const split = splitExtended(piece);
        charset = split.charset;
        piece = split.text;
      }
      text += piece;
    }
    plain[key] = list.some((s) => s.extended) ? decodeBytes(percentDecodeToBytes(text), charset) : text;
  }

  return plain;
}
