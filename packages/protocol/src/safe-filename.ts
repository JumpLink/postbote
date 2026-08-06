/**
 * Turning a MIME filename into something safe to use as a file name.
 *
 * A filename out of a message is ATTACKER-CONTROLLED. It is never used as a path — this
 * produces a single path SEGMENT, and the caller still joins-and-verifies before writing.
 *
 * The ORDER below is the security-relevant part, because the dangerous constructs hide inside
 * each other:
 *   1. Strip control characters and bidi overrides FIRST. `U+202E` between two dots is the
 *      classic `…exe.txt` display spoof, and stripping it later would leave a `..` that the
 *      traversal check had already waved through.
 *   2. Normalize to NFC, so a decomposed sequence cannot smuggle a character past step 5.
 *   3. Only then take the basename — at `/` AND `\`, since the write may land on either.
 *   4. Only then reject `.` / `..`.
 */

/** Windows-reserved and shell-hostile characters, replaced rather than dropped. */
const FORBIDDEN = /[/\\:*?"<>|]/g;

/** Device names Windows refuses regardless of extension. Harmless to guard against on Linux. */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const MAX_BYTES = 200;

function stripDangerousCodePoints(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 and C1 control characters, and DEL.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    // Bidi overrides and isolates — invisible, and they reverse how the name reads.
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    // Zero-width joiners/spaces and the BOM, which make two different names look identical.
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    out += ch;
  }
  return out;
}

/** UTF-8 byte length without allocating the encoded array. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Truncate to at most `max` UTF-8 bytes, never splitting a code point. */
function truncateUtf8(value: string, max: number): string {
  if (utf8Length(value) <= max) return value;
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > max) break;
    out += ch;
    bytes += width;
  }
  return out;
}

/**
 * Sanitize a MIME filename into a single safe path segment.
 *
 * Always returns a usable name: when nothing survives, `fallback` is used, because refusing to
 * save an attachment because its name was hostile is the wrong trade — the bytes are still what
 * the user asked for.
 */
export function safeFileName(raw: string | null | undefined, fallback = 'attachment'): string {
  let name = stripDangerousCodePoints(raw ?? '');
  // NFC before the forbidden-character pass, so a decomposed form cannot slip through it.
  name = typeof name.normalize === 'function' ? name.normalize('NFC') : name;

  // Basename at BOTH separators: the name may have been produced on either platform, and only
  // stripping `/` leaves `..\..\x` intact on a Windows-hosted share.
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastSlash >= 0) name = name.slice(lastSlash + 1);

  name = name.replace(FORBIDDEN, '_');

  // Leading dots hide the file; a leading `-` makes it look like a flag to any shell tool that
  // later touches the directory. Trailing dots and spaces are silently dropped by Windows,
  // which would make two names collide.
  name = name.replace(/^[.\-\s]+/, '').replace(/[.\s]+$/, '');

  if (name === '' || name === '.' || name === '..') return fallback;

  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  if (RESERVED.has(stem.toLowerCase())) stem = `_${stem}`;

  // Truncate the STEM, not the whole name, so a long attachment keeps its extension — which is
  // what tells the user (and their file manager) what it is.
  const room = MAX_BYTES - utf8Length(ext);
  if (room > 0) stem = truncateUtf8(stem, room);
  const result = `${stem}${ext}`;

  return result === '' || result === '.' || result === '..' ? fallback : result;
}
