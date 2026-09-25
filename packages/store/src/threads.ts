/**
 * Mail threading from `Message-ID`, `In-Reply-To` and `References` — pure, so it is tested
 * without a database.
 *
 * Deliberately NOT the full JWZ algorithm: there is no subject-based grouping. Two mails that
 * share "Rechnung" as a subject but no reference are two conversations; merging them would put
 * unrelated invoices into one thread, which is the worse error for a per-person view. Every id
 * a message names — its own, its parent, every ancestor in References — joins one component,
 * so a thread holds together even when the middle messages were never indexed (deleted, or in a
 * folder that is not synced).
 */

export interface ThreadMember {
  /** Unique per row, e.g. `folder/uid`. */
  key: string;
  accountId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  /** ISO-8601; orders the thread. */
  sentAt: string | null;
}

export interface Thread<T extends ThreadMember> {
  /** A stable key for the thread: the root id the earliest member names. */
  rootKey: string;
  accountId: string;
  /** Oldest first; duplicates of one Message-ID collapsed to the first row seen. */
  members: T[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = x;
    for (;;) {
      const p = this.parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    // Path compression, so a long References chain does not make every lookup linear.
    let node = x;
    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function byDate(a: ThreadMember, b: ThreadMember): number {
  const ta = a.sentAt ?? '';
  const tb = b.sentAt ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Group messages into threads. Accounts never share a thread, even for an identical Message-ID. */
export function buildThreads<T extends ThreadMember>(members: readonly T[]): Array<Thread<T>> {
  const uf = new UnionFind();
  const rowNode = (m: ThreadMember) => `row\u0000${m.accountId}\u0000${m.key}`;
  const idNode = (m: ThreadMember, id: string) => `id\u0000${m.accountId}\u0000${id}`;

  for (const m of members) {
    const row = rowNode(m);
    uf.find(row);
    for (const id of [m.messageId, m.inReplyTo, ...m.references]) {
      if (id) uf.union(row, idNode(m, id));
    }
  }

  const groups = new Map<string, T[]>();
  for (const m of members) {
    const root = uf.find(rowNode(m));
    const list = groups.get(root);
    if (list) list.push(m);
    else groups.set(root, [m]);
  }

  const threads: Array<Thread<T>> = [];
  for (const list of groups.values()) {
    list.sort(byDate);
    // The same message filed in two folders (INBOX and an archive, or a label on Gmail) is one
    // message, not two turns of the conversation.
    const seen = new Set<string>();
    const unique = list.filter((m) => {
      if (!m.messageId) return true;
      if (seen.has(m.messageId)) return false;
      seen.add(m.messageId);
      return true;
    });
    const first = unique[0];
    threads.push({
      rootKey: first.references[0] ?? first.inReplyTo ?? first.messageId ?? `row:${first.key}`,
      accountId: first.accountId,
      members: unique,
    });
  }
  return threads;
}

const REPLY_PREFIX = /^\s*((re|fwd?|aw|wg|antw|sv|vs|tr)(\[\d+\])?\s*:\s*)+/i;

/** A thread's title: the subject without the reply and forward prefixes clients stack up. */
export function normalizeSubject(subject: string | null): string | null {
  if (!subject) return null;
  const stripped = subject.replace(REPLY_PREFIX, '').trim();
  return stripped || subject.trim() || null;
}

/**
 * A short, stable id from its parts (cyrb53, 53 bits, hex). Stable across rebuilds, so an id a
 * user copied from `conversations list` still resolves after the next sync.
 *
 * Not a security boundary — nothing here needs collision resistance against an adversary, only
 * uniqueness across one person's mail.
 */
export function stableId(prefix: string, ...parts: string[]): string {
  const input = parts.join('\u0000');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${prefix}${n.toString(16).padStart(14, '0')}`;
}
