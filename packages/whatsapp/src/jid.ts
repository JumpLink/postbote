/**
 * WhatsApp addresses (JIDs) and the one identity postbote files a person under.
 *
 * A WhatsApp user has two addresses: the phone-number JID (`<digits>@s.whatsapp.net`) and the
 * LID (`<digits>@lid`), a privacy id that hides the number. The server uses either, and newer
 * clients mostly the LID — so the same person, and the same direct chat, can arrive under both.
 * Filing them under two ids would split one chat into two conversations. The resolver files
 * every user under the LID when it knows one, else under the phone number, and learns the pairs
 * from everything that carries both (history sync, contacts, message keys, the mapping Baileys
 * keeps in the auth state).
 *
 * Pure: no Baileys import, so every rule is tested with synthetic ids.
 */

import type { ChatInfo, ChatPeer, ParticipantAddress } from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';

export interface Jid {
  user: string;
  device: number | null;
  server: string;
}

/** `user[:device]@server`, or null. The agent suffix (`user_1`) of old ids is kept in `user`. */
export function parseJid(raw: string | null | undefined): Jid | null {
  const m = /^([^@:]+)(?::(\d+))?@([a-z.]+)$/i.exec(raw?.trim() ?? '');
  if (!m) return null;
  return { user: m[1], device: m[2] === undefined ? null : Number(m[2]), server: m[3].toLowerCase() };
}

const PN_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);
const LID_SERVERS = new Set(['lid', 'hosted.lid']);

export function isPnJid(jid: Jid | null): boolean {
  return jid !== null && PN_SERVERS.has(jid.server) && /^\d+$/.test(jid.user);
}

export function isLidJid(jid: Jid | null): boolean {
  return jid !== null && LID_SERVERS.has(jid.server) && /^\d+$/.test(jid.user);
}

/** Stories: other people's status updates, not a chat. Never stored. */
export const STATUS_BROADCAST = 'status@broadcast';

/** What kind of chat a chat JID names. */
export function chatKindOf(jid: Jid): ChatInfo['kind'] {
  if (jid.server === 'g.us') return 'group';
  // Channels are one-way; so are broadcast lists, from the recipient's side.
  if (jid.server === 'newsletter' || jid.server === 'broadcast') return 'broadcast';
  return 'direct';
}

/**
 * Where the resolver looks up pairs it has not seen in this run: Baileys' own LID mapping,
 * kept in the auth state (`lid-mapping` keys: `<pn>` → `<lid>`, `<lid>_reverse` → `<pn>`).
 */
export interface LidLookup {
  lidForPn(pnUser: string): string | null;
  pnForLid(lidUser: string): string | null;
}

export const NO_LOOKUP: LidLookup = { lidForPn: () => null, pnForLid: () => null };

export class JidResolver {
  private readonly pnToLid = new Map<string, string>();
  private readonly lidToPn = new Map<string, string>();
  private readonly lookup: LidLookup;
  /** Pairs learned since the last `takeLearned()`: each may join two chats filed apart so far. */
  private learned: Array<{ pn: string; lid: string }> = [];

  constructor(lookup: LidLookup = NO_LOOKUP) {
    this.lookup = lookup;
  }

  /** Record that two addresses are one user. Either order; anything else is ignored. */
  learn(a: string | null | undefined, b: string | null | undefined): void {
    const x = parseJid(a);
    const y = parseJid(b);
    const pn = isPnJid(x) ? x : isPnJid(y) ? y : null;
    const lid = isLidJid(x) ? x : isLidJid(y) ? y : null;
    if (!pn || !lid) return;
    this.pair(pn.user, lid.user);
  }

  private pair(pnUser: string, lidUser: string): void {
    if (this.pnToLid.get(pnUser) === lidUser) return;
    this.pnToLid.set(pnUser, lidUser);
    this.lidToPn.set(lidUser, pnUser);
    this.learned.push({ pn: pnUser, lid: lidUser });
  }

  /**
   * The pairs learned since the last call. A chat filed under the phone number before its LID
   * was known must now be merged into the LID chat — the caller turns these into merge events.
   * A pair found through the stored mapping counts too: an earlier run may have filed the chat
   * under the number before Baileys stored the pair.
   */
  takeLearned(): Array<{ pn: string; lid: string }> {
    const learned = this.learned;
    this.learned = [];
    return learned;
  }

  private lidOf(pnUser: string): string | null {
    const known = this.pnToLid.get(pnUser);
    if (known) return known;
    const stored = this.lookup.lidForPn(pnUser);
    if (stored) this.pair(pnUser, stored);
    return stored;
  }

  private pnOf(lidUser: string): string | null {
    const known = this.lidToPn.get(lidUser);
    if (known) return known;
    const stored = this.lookup.pnForLid(lidUser);
    if (stored) this.pair(stored, lidUser);
    return stored;
  }

  /**
   * The user behind a JID (plus its alternative, when the key carried one): the id it is filed
   * under and every address known for it. Null for a JID that is not a user.
   */
  user(
    raw: string | null | undefined,
    alt?: string | null,
  ): { id: string; addresses: ParticipantAddress[] } | null {
    this.learn(raw, alt);
    const jid = parseJid(raw);
    const other = parseJid(alt);
    const pnUser = isPnJid(jid) ? jid!.user : isPnJid(other) ? other!.user : null;
    const lidUser = isLidJid(jid) ? jid!.user : isLidJid(other) ? other!.user : null;
    const lid = lidUser ?? (pnUser ? this.lidOf(pnUser) : null);
    const pn = pnUser ?? (lidUser ? this.pnOf(lidUser) : null);
    if (!lid && !pn) return null;
    const addresses: ParticipantAddress[] = [];
    const add = (kind: ParticipantAddress['kind'], value: string) => {
      const normalized = normalizeAddress(kind, value);
      if (normalized) addresses.push({ kind, value: normalized });
    };
    if (lid) add('whatsapp', `${lid}@lid`);
    if (pn) {
      add('whatsapp', `${pn}@s.whatsapp.net`);
      // A WhatsApp number is always international: the JID user is the E.164 number without `+`.
      add('phone', `+${pn}`);
    }
    return { id: lid ? `${lid}@lid` : `${pn}@s.whatsapp.net`, addresses };
  }

  /** The id a chat is filed under: a direct chat under its user's id, every other chat as sent. */
  chatId(raw: string | null | undefined, alt?: string | null): string | null {
    const jid = parseJid(raw);
    if (!jid) return null;
    if (chatKindOf(jid) !== 'direct') return `${jid.user}@${jid.server}`;
    return this.user(raw, alt)?.id ?? null;
  }

  /** A peer for a user JID, or null when the JID is not a user. */
  peer(
    raw: string | null | undefined,
    alt: string | null | undefined,
    displayName: string | null,
  ): ChatPeer | null {
    const user = this.user(raw, alt);
    if (!user) return null;
    return {
      remoteId: user.id,
      displayName: displayName?.trim() || null,
      addresses: user.addresses,
      bot: false,
    };
  }
}
