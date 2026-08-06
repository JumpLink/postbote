/**
 * Parsing of `LIST` / `XLIST` responses and mailbox role resolution.
 *
 * A response line looks like:
 *   * LIST (\HasNoChildren \Sent) "/" "INBOX/Sent"
 *   * LIST (\HasChildren) "." "Gel&APY-schte Elemente"
 *
 * The mailbox name may be an atom, a quoted string, or a literal — the tokenizer already
 * handles all three, so this only has to interpret the shape.
 */

import { decodeMutf7 } from './mutf7.ts';
import { tokenizeImapList } from './imap-parse.ts';

/** What a mailbox is *for*, once resolved. */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';

/** How the role was determined — surfaced so the CLI can say why it thinks so. */
export type RoleSource = 'name' | 'special-use' | 'heuristic';

export interface FolderInfo {
  /**
   * The WIRE name, in modified UTF-7. This is what goes back to the server in SELECT/EXAMINE,
   * and what the index stores as the stable key. Never display this.
   */
  path: string;
  /** The decoded display name. Never send this to a server. */
  name: string;
  /** Hierarchy delimiter, or null for a flat namespace. */
  delimiter: string | null;
  /** Raw `\`-prefixed attributes, lowercased without the backslash. */
  attributes: string[];
  /** False for `\Noselect` / `\NonExistent` — a grouping node with no messages. */
  selectable: boolean;
  role: FolderRole | null;
  roleSource: RoleSource | null;
}

/** RFC 6154 SPECIAL-USE attributes → role. */
const SPECIAL_USE: Record<string, FolderRole> = {
  sent: 'sent',
  drafts: 'drafts',
  trash: 'trash',
  junk: 'junk',
  archive: 'archive',
  all: 'all',
  flagged: 'flagged',
};

/**
 * Last-resort name matching, German and English. Only consulted when the server advertises no
 * SPECIAL-USE attribute — which is common on plain Dovecot/MIAB setups without the extension
 * enabled, and is exactly where a German mailbox would otherwise get no role at all.
 */
const NAME_HEURISTICS: Array<{ role: FolderRole; names: string[] }> = [
  {
    role: 'sent',
    names: [
      'sent',
      'sent items',
      'sent messages',
      'sent mail',
      'gesendet',
      'gesendete elemente',
      'gesendete objekte',
    ],
  },
  { role: 'drafts', names: ['drafts', 'draft', 'entwürfe', 'entwuerfe'] },
  {
    role: 'trash',
    names: [
      'trash',
      'deleted',
      'deleted items',
      'deleted messages',
      'papierkorb',
      'gelöschte elemente',
      'geloeschte elemente',
      'müll',
      'muell',
    ],
  },
  {
    role: 'junk',
    names: ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail', 'unerwünscht', 'unerwuenscht'],
  },
  { role: 'archive', names: ['archive', 'archives', 'archiv'] },
  { role: 'all', names: ['all mail', 'all', 'alle nachrichten'] },
];

/** The leaf of a possibly-nested path, for heuristic matching. */
function leafName(name: string, delimiter: string | null): string {
  if (!delimiter) return name;
  const idx = name.lastIndexOf(delimiter);
  return idx < 0 ? name : name.slice(idx + delimiter.length);
}

function resolveRole(
  displayName: string,
  attributes: string[],
  delimiter: string | null,
): { role: FolderRole | null; roleSource: RoleSource | null } {
  // INBOX is case-insensitively reserved by RFC 3501 — it needs no attribute and no guessing.
  if (displayName.toUpperCase() === 'INBOX') return { role: 'inbox', roleSource: 'name' };

  for (const attr of attributes) {
    const role = SPECIAL_USE[attr];
    if (role) return { role, roleSource: 'special-use' };
  }

  const leaf = leafName(displayName, delimiter).toLowerCase().trim();
  for (const { role, names } of NAME_HEURISTICS) {
    if (names.includes(leaf)) return { role, roleSource: 'heuristic' };
  }
  return { role: null, roleSource: null };
}

/** Parse one `* LIST …` / `* XLIST …` / `* LSUB …` line. Returns null if it is not one. */
export function parseListLine(line: string, literals: string[] = []): FolderInfo | null {
  const m = /^\*\s+(LIST|XLIST|LSUB)\s+/i.exec(line);
  if (!m) return null;

  const rest = line.slice(m[0].length);
  // The attribute list is the leading parenthesized group; tokenizing from the first '(' gives
  // exactly it, and `next` would need re-deriving, so scan the remainder by hand afterwards.
  const attrs = tokenizeImapList(rest, literals)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.replace(/^\\/, '').toLowerCase());

  const close = rest.indexOf(')');
  if (close < 0) return null;
  const tail = rest.slice(close + 1).trim();

  // tail is: <delimiter> SP <mailbox>. The delimiter is `NIL` or a quoted char (often `"/"`,
  // and `"\\"` on some servers where the escape matters).
  const values = tokenizeImapList(`(${tail})`, literals);
  const delimiterValue = values[0];
  const nameValue = values[1];
  if (typeof nameValue !== 'string') return null;

  const delimiter = typeof delimiterValue === 'string' && delimiterValue.length > 0 ? delimiterValue : null;
  const path = nameValue;
  const name = decodeMutf7(path);
  const selectable = !attrs.includes('noselect') && !attrs.includes('nonexistent');

  return { path, name, delimiter, attributes: attrs, selectable, ...resolveRole(name, attrs, delimiter) };
}

/** Parse every mailbox out of a LIST response's lines. */
export function parseFolderList(lines: string[], literals: string[] = []): FolderInfo[] {
  const folders: FolderInfo[] = [];
  for (const line of lines) {
    const folder = parseListLine(line, literals);
    if (folder) folders.push(folder);
  }
  return folders;
}

/**
 * Roles excluded from a cross-folder search by default.
 *
 * `all` is the important one: Gmail's All Mail contains a copy of every message in every other
 * folder, so including it duplicates every single hit. `trash` and `junk` are excluded because
 * "search my mail" does not usually mean "search what I threw away".
 */
export const CROSS_SEARCH_EXCLUDED_ROLES: readonly FolderRole[] = ['all', 'trash', 'junk'];

/** The folders a cross-folder search should actually visit. */
export function searchableFolders(folders: FolderInfo[]): FolderInfo[] {
  return folders.filter((f) => f.selectable && !(f.role && CROSS_SEARCH_EXCLUDED_ROLES.includes(f.role)));
}

/**
 * Resolve what a user typed into an actual mailbox.
 *
 * Accepts the wire name, the display name, a role (`sent`, `trash`), or just the leaf of a
 * nested path — because `--folder Gesendet` is what someone types, while the server wants
 * `INBOX/Gesendet` and the index stores `INBOX/Gesendet` in modified UTF-7.
 *
 * Exact matches win over case-insensitive ones, and both win over a role, so a mailbox that
 * happens to be *named* "Archive" is preferred over whichever one carries `\Archive`.
 */
export function resolveFolder(folders: FolderInfo[], spec: string): FolderInfo | null {
  const want = spec.trim();
  if (!want) return null;
  const lower = want.toLowerCase();

  return (
    folders.find((f) => f.path === want) ??
    folders.find((f) => f.name === want) ??
    folders.find((f) => f.path.toLowerCase() === lower) ??
    folders.find((f) => f.name.toLowerCase() === lower) ??
    folders.find((f) => f.role === lower) ??
    folders.find((f) => leafName(f.name, f.delimiter).toLowerCase() === lower) ??
    null
  );
}
