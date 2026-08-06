/**
 * Walking a `BODYSTRUCTURE` into a flat list of fetchable parts (RFC 3501 §7.4.2, §6.4.5).
 *
 * BODYSTRUCTURE is exactly the nested parenthesized list `tokenizeImapList` already parses, so
 * there is nothing to add to the lexer — this only interprets the shape and, crucially, assigns
 * each part its SECTION NUMBER, which is what `BODY.PEEK[<section>]` needs.
 *
 * The numbering has three traps, all of them in RFC 3501 §6.4.5's example:
 *   - A multipart at the TOP has no number of its own; its children are `1`, `2` — not `0.1`.
 *   - A multipart NESTED at `2` does have `2`, and its children are `2.1`, `2.2`.
 *   - A MESSAGE/RFC822 at `3` encapsulates a whole message, whose body parts are `3.1`, `3.2`
 *     — including when that body is a single part, which is `3.1` and not `3`.
 */

import { decodeRfc2047 } from './rfc2047.ts';
import { decodeRfc2231Params } from './rfc2231.ts';
import type { ImapValue } from './imap-parse.ts';

export interface BodyPart {
  /** IMAP section for `BODY.PEEK[<section>]`, e.g. `"1"`, `"2.1"`. */
  section: string;
  /** Lowercased `type/subtype`, e.g. `"application/pdf"`. */
  mimeType: string;
  /** Content-Type parameters, lowercased keys, RFC 2231 reassembled. */
  params: Record<string, string>;
  /** Content-ID, without angle brackets, or null. */
  id: string | null;
  /** Transfer encoding, uppercased: `BASE64`, `QUOTED-PRINTABLE`, `7BIT`, … */
  encoding: string;
  /** Size in octets AS ENCODED on the wire — what a fetch actually transfers. */
  size: number;
  /** Line count for text parts, else null. */
  lines: number | null;
  /** `attachment` / `inline`, lowercased, or null when not declared. */
  disposition: string | null;
  /** Best available filename, RFC 2047/2231 decoded. Never use this as a path — see safeFileName. */
  filename: string | null;
  /** True for the multipart containers themselves, which cannot be fetched as a part. */
  multipart: boolean;
}

/** A BODYSTRUCTURE node is multipart iff its first element is itself a list (a child part). */
function isMultipart(node: ImapValue[]): boolean {
  return Array.isArray(node[0]);
}

/** The leading child-part lists of a multipart node. */
function childrenOf(node: ImapValue[]): ImapValue[][] {
  const children: ImapValue[][] = [];
  for (const item of node) {
    if (!Array.isArray(item)) break; // the subtype string ends the child run
    children.push(item);
  }
  return children;
}

function str(value: ImapValue): string | null {
  return typeof value === 'string' ? value : null;
}

/** A `("KEY" "value" "KEY2" "value2")` parameter list → a lowercased-key map. */
function paramList(value: ImapValue): Record<string, string> {
  const raw: Record<string, string> = {};
  if (!Array.isArray(value)) return raw;
  for (let i = 0; i + 1 < value.length; i += 2) {
    const key = str(value[i]);
    const val = str(value[i + 1]);
    if (key !== null && val !== null) raw[key.toLowerCase()] = val;
  }
  return decodeRfc2231Params(raw);
}

/** A `("attachment" ("filename" "x.pdf"))` disposition tuple. */
function parseDisposition(value: ImapValue): { type: string | null; params: Record<string, string> } {
  if (!Array.isArray(value)) return { type: null, params: {} };
  return { type: str(value[0])?.toLowerCase() ?? null, params: paramList(value[1]) };
}

/**
 * Index of the extension fields, which sit at different offsets per type: TEXT carries a line
 * count, MESSAGE/RFC822 carries an envelope + a nested structure + a line count, everything
 * else carries neither.
 */
function extensionOffset(mimeType: string): number {
  if (mimeType.startsWith('text/')) return 8; // …encoding, size, LINES, md5, disposition
  if (mimeType === 'message/rfc822') return 10; // …size, envelope, body, LINES, md5, disposition
  return 7; // …encoding, size, md5, disposition
}

function leafPart(node: ImapValue[], section: string): BodyPart {
  const type = (str(node[0]) ?? 'application').toLowerCase();
  const subtype = (str(node[1]) ?? 'octet-stream').toLowerCase();
  const mimeType = `${type}/${subtype}`;
  const params = paramList(node[2]);
  const sizeRaw = str(node[6]);
  const dispIndex = extensionOffset(mimeType) + 1; // md5 sits directly before it

  const disposition = parseDisposition(node[dispIndex]);
  const rawName = disposition.params.filename ?? params.name ?? null;

  const linesIndex = mimeType === 'message/rfc822' ? 9 : 7;
  const linesRaw =
    mimeType.startsWith('text/') || mimeType === 'message/rfc822' ? str(node[linesIndex]) : null;

  return {
    section,
    mimeType,
    params,
    id: str(node[3])?.replace(/^<|>$/g, '') ?? null,
    encoding: (str(node[5]) ?? '7BIT').toUpperCase(),
    size: sizeRaw ? (Number.parseInt(sizeRaw, 10) ?? 0) : 0,
    lines: linesRaw ? Number.parseInt(linesRaw, 10) : null,
    disposition: disposition.type,
    // RFC 2231 reassembly happens in paramList; an RFC 2047 encoded-word is illegal here but
    // common in the wild, and decoding a value that has none is a no-op.
    filename: rawName ? decodeRfc2047(rawName) : null,
    multipart: false,
  };
}

function containerPart(node: ImapValue[], section: string): BodyPart {
  const children = childrenOf(node);
  const subtype = (str(node[children.length]) ?? 'mixed').toLowerCase();
  return {
    section,
    mimeType: `multipart/${subtype}`,
    params: paramList(node[children.length + 1]),
    id: null,
    encoding: '7BIT',
    size: 0,
    lines: null,
    disposition: parseDisposition(node[children.length + 3]).type,
    filename: null,
    multipart: true,
  };
}

function walkNode(node: ImapValue[], section: string, out: BodyPart[]): void {
  if (isMultipart(node)) {
    out.push(containerPart(node, section));
    childrenOf(node).forEach((child, i) => walkNode(child, `${section}.${i + 1}`, out));
    return;
  }

  const part = leafPart(node, section);
  out.push(part);

  // An encapsulated message's parts are numbered UNDER this section — and a single-part body
  // is `3.1`, not `3`, which is why this cannot just recurse with the same section.
  if (part.mimeType === 'message/rfc822') {
    const inner = node[8];
    if (Array.isArray(inner)) {
      if (isMultipart(inner)) {
        childrenOf(inner).forEach((child, i) => walkNode(child, `${section}.${i + 1}`, out));
      } else {
        walkNode(inner, `${section}.1`, out);
      }
    }
  }
}

/** Flatten a BODYSTRUCTURE into every part it contains, each with its fetchable section. */
export function walkBodyStructure(structure: ImapValue): BodyPart[] {
  const out: BodyPart[] = [];
  if (!Array.isArray(structure)) return out;
  if (isMultipart(structure)) {
    // The top-level multipart has no section of its own; only its children are fetchable.
    childrenOf(structure).forEach((child, i) => walkNode(child, `${i + 1}`, out));
  } else {
    walkNode(structure, '1', out);
  }
  return out;
}

/**
 * The parts a user would call "attachments".
 *
 * `disposition === 'attachment'` alone is not enough — plenty of senders attach a PDF with no
 * disposition at all and only a `name` parameter — so a filename counts too. Multipart
 * containers and the message's own text never do.
 */
export function attachmentParts(parts: BodyPart[]): BodyPart[] {
  return parts.filter(
    (p) =>
      !p.multipart && (p.disposition === 'attachment' || (p.filename !== null && p.disposition !== 'inline')),
  );
}

/**
 * Pick the part to use as the message body: the first text/plain, else the first text/html.
 * Attachments are skipped even when they are text — an attached .txt is not the body.
 */
export function pickBodyPart(parts: BodyPart[]): BodyPart | null {
  const candidates = parts.filter(
    (p) => !p.multipart && p.disposition !== 'attachment' && p.filename === null,
  );
  return (
    candidates.find((p) => p.mimeType === 'text/plain') ??
    candidates.find((p) => p.mimeType === 'text/html') ??
    null
  );
}
