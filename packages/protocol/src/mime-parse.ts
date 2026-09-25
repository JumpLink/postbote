/**
 * Pure, dependency-free MIME parsing (RFC 2045/2046) — no `gi://`, no Camel.
 * The GJS mail backend fetches a raw RFC 822 message over IMAP, hands the bytes
 * here as a latin1 (binary-safe) string, and gets back a plain-text body plus
 * attachment metadata. Keeping this pure makes it unit-testable on Node and
 * avoids depending on Camel's GI surface (which we cannot exercise off-GJS).
 *
 * Coverage: single-part text, multipart/alternative (prefers text/plain over a
 * stripped text/html), and multipart/mixed/related with nested parts. Exotic
 * encodings degrade gracefully rather than throwing.
 */

import { base64ToBytes, decodeBytes, latin1ToBytes, quotedPrintableToBytes } from './encoding.ts';
import { decodeRfc2047 } from './rfc2047.ts';

export interface ParsedAttachment {
  filename: string | null;
  mimeType: string;
  /** Approximate decoded size in bytes (estimated from the encoded length). */
  size: number;
}

export interface ParsedMimeMessage {
  /** Best-effort plain-text body (text/plain preferred, else stripped HTML). */
  bodyText: string | null;
  attachments: ParsedAttachment[];
}

interface ContentType {
  type: string; // lowercased "type/subtype"
  params: Record<string, string>;
}

/** Split a raw part into [headerBlock, body] at the first blank line. */
function splitHeadersBody(raw: string): [string, string] {
  const crlf = raw.indexOf('\r\n\r\n');
  if (crlf >= 0) return [raw.slice(0, crlf), raw.slice(crlf + 4)];
  const lf = raw.indexOf('\n\n');
  if (lf >= 0) return [raw.slice(0, lf), raw.slice(lf + 2)];
  return [raw, ''];
}

/**
 * Parse a header block (unfolding continuations) into a map keyed by lowercased name. A header
 * that occurs more than once has its values joined with a newline.
 */
export function parseHeaders(block: string): Map<string, string> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const map = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    map.set(name, map.has(name) ? `${map.get(name)}\n${value}` : value);
  }
  return map;
}

/** Parse a Content-Type / Content-Disposition value into type + params. */
function parseParameterized(value: string | undefined, fallback: string): ContentType {
  if (!value) return { type: fallback, params: {} };
  const segments = value.split(';');
  const type = segments[0].trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

/** Split a multipart body into its parts using the boundary delimiter. */
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  const parts: string[] = [];
  // segments[0] is the preamble; a segment starting with "--" is the closing
  // delimiter (epilogue follows).
  for (let i = 1; i < segments.length; i++) {
    let seg = segments[i];
    if (seg.startsWith('--')) break;
    seg = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    parts.push(seg);
  }
  return parts;
}

/** Decode a leaf part's body bytes per its transfer encoding. */
function decodeBody(body: string, cte: string | undefined): Uint8Array {
  const enc = (cte ?? '7bit').trim().toLowerCase();
  if (enc === 'base64') return base64ToBytes(body);
  if (enc === 'quoted-printable') return quotedPrintableToBytes(body);
  return latin1ToBytes(body);
}

/** Estimate decoded size without materializing the (possibly large) bytes. */
function estimateSize(body: string, cte: string | undefined): number {
  const enc = (cte ?? '7bit').trim().toLowerCase();
  if (enc === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    const padding = clean.match(/=+$/)?.[0].length ?? 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
  return body.length;
}

/** Minimal HTML→text fallback when no text/plain part exists. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract a filename from Content-Disposition / Content-Type params. */
function extractFilename(disposition: ContentType, contentType: ContentType): string | null {
  const raw = disposition.params.filename ?? contentType.params.name ?? null;
  return raw ? decodeRfc2047(raw) : null;
}

interface WalkState {
  plain: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}

/** Recursively walk one MIME part, accumulating body candidates + attachments. */
function walkPart(raw: string, state: WalkState): void {
  const [headerBlock, body] = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = parseParameterized(headers.get('content-type'), 'text/plain');
  const disposition = parseParameterized(headers.get('content-disposition'), 'inline');
  const cte = headers.get('content-transfer-encoding') ?? undefined;

  if (contentType.type.startsWith('multipart/') && contentType.params.boundary) {
    for (const part of splitMultipart(body, contentType.params.boundary)) {
      walkPart(part, state);
    }
    return;
  }

  const filename = extractFilename(disposition, contentType);
  const isAttachment = disposition.type === 'attachment' || filename !== null;

  if (isAttachment) {
    state.attachments.push({
      filename,
      mimeType: contentType.type,
      size: estimateSize(body, cte),
    });
    return;
  }

  if (contentType.type === 'text/plain' && state.plain === null) {
    state.plain = decodeBytes(decodeBody(body, cte), contentType.params.charset);
  } else if (contentType.type === 'text/html' && state.html === null) {
    state.html = decodeBytes(decodeBody(body, cte), contentType.params.charset);
  }
}

/**
 * Parse a raw RFC 822 message (given as a latin1/binary-safe string) into a
 * plain-text body and attachment metadata. Attachment *contents* are never
 * returned — only filename, MIME type and an estimated size.
 */
export function parseMimeMessage(rawLatin1: string): ParsedMimeMessage {
  const state: WalkState = { plain: null, html: null, attachments: [] };
  walkPart(rawLatin1, state);
  const bodyText = state.plain ?? (state.html !== null ? stripHtml(state.html) : null);
  return { bodyText, attachments: state.attachments };
}
