/**
 * Archived XMPP stanzas → the network-neutral chat driver types of `@postbote/protocol`.
 *
 * Pure: every rule here is tested against synthetic entries on both runtimes.
 *
 * Sequence numbers. The chat engine orders a chat by a monotonic number, and an XMPP archive
 * has none — its ids are opaque (a UUID on Prosody, a timestamp on ejabberd). The ARCHIVE ID is
 * the resume cursor (`highestCursor`); the number is only the order, derived from the archive
 * time: an entry's seq is its stamp in milliseconds, or one more than the entry before it when
 * that is larger. Deterministic as long as a walk sees every entry of a millisecond from its
 * start — which a forward walk does, and a window does after `windowEntries` — so a
 * message keeps its number whether a forward walk or a full-scan window met it. (Servers that
 * stamp whole seconds give each entry of one second its own millisecond; a second with more
 * than 1 000 entries would spill into the next.)
 */

import type {
  ChatEdit,
  ChatHistoryPage,
  ChatInfo,
  ChatMessage,
  ChatPeer,
  ParticipantAddress,
} from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import { type ArchivedEntry, bareJid, resourceOf } from './stanza.ts';

/** What the mapping needs to know about the chat an entry belongs to. */
export interface ChatContext {
  kind: 'direct' | 'group';
  /** The other person's bare JID, or the room's. */
  chatJid: string;
  /** The user's own bare JID. */
  selfJid: string;
  /** The user's nick in a room, from the bookmark. */
  selfNick: string | null;
  /** The name the roster (or bookmark) gives the chat. */
  name: string | null;
}

function jidAddresses(jid: string | null): ParticipantAddress[] {
  const value = jid ? normalizeAddress('jid', jid) : null;
  return value ? [{ kind: 'jid', value }] : [];
}

/** The ChatInfo of a roster contact or a bookmarked room, with its archive's newest entry. */
export function toChatInfo(context: ChatContext, newest: ArchivedEntry | null): ChatInfo {
  const direct = context.kind === 'direct';
  return {
    remoteId: context.chatJid,
    kind: context.kind,
    title: context.name ?? (direct ? context.chatJid : null),
    members: direct ? [directPeer(context)] : [],
    lastSeq: newest?.stampMs ?? null,
    // Markers the user sent from another client are archived by some servers only; without
    // them there is nothing reliable to say.
    readInboxSeq: null,
    readOutboxSeq: null,
    lastCursor: newest?.archiveId ?? null,
  };
}

function directPeer(context: ChatContext): ChatPeer {
  return {
    remoteId: context.chatJid,
    displayName: context.name,
    addresses: jidAddresses(context.chatJid),
    bot: false,
  };
}

/** Who wrote an entry, as far as permission checks go: bare JID, or the occupant in a room. */
function authorKey(context: ChatContext, entry: ArchivedEntry): string | null {
  if (!entry.from) return null;
  if (context.kind === 'direct') return bareJid(entry.from);
  return entry.occupantJid ?? entry.from;
}

export function isFromSelf(context: ChatContext, entry: ArchivedEntry): boolean {
  if (!entry.from) return false;
  if (context.kind === 'direct') return bareJid(entry.from) === context.selfJid;
  if (entry.occupantJid) return entry.occupantJid === context.selfJid;
  return context.selfNick !== null && resourceOf(entry.from) === context.selfNick;
}

function senderOf(context: ChatContext, entry: ArchivedEntry): ChatPeer | null {
  if (!entry.from) return null;
  if (context.kind === 'direct') return directPeer(context);
  const nick = resourceOf(entry.from);
  // A room that hides real JIDs (semi-anonymous) leaves the occupant: the nick is all there is,
  // and it names nobody outside this room.
  return {
    remoteId: entry.occupantJid ?? entry.from,
    displayName: nick,
    addresses: jidAddresses(entry.occupantJid),
    bot: false,
  };
}

/**
 * The ids other messages use to point at this one: in a room the room's stanza-id (the MUC
 * archive id), in a direct chat the sender's own id or origin-id (XEP-0308, XEP-0424 and
 * XEP-0461 all follow this rule; Dino resolves them the same way).
 */
export function referenceKeys(context: ChatContext, entry: ArchivedEntry): string[] {
  const keys = [entry.id, entry.originId];
  if (context.kind === 'group') keys.unshift(entry.archiveId);
  return keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/** References an entry makes that the page itself cannot resolve — what a lookback must find. */
export function unresolvedReferences(context: ChatContext, entries: readonly ArchivedEntry[]): string[] {
  const known = new Set(entries.flatMap((e) => referenceKeys(context, e)));
  const wanted = entries.flatMap((e) => [e.replaceId, e.retract?.id ?? null, e.replyToId]);
  return [...new Set(wanted.filter((id): id is string => id !== null && !known.has(id)))];
}

/**
 * The window of a first sync, from a page asked for `limit + 1` entries: the extra, oldest one
 * is a sentinel that shows whether the window starts at a millisecond boundary. Entries that
 * share the sentinel's stamp are dropped with it — the window would have cut that millisecond,
 * and their seqs would differ from a forward walk's. A server that returned fewer entries than
 * asked without reaching the start (it caps page sizes) leaves no sentinel, so the first
 * millisecond is dropped instead. Nothing is dropped when that would leave nothing.
 */
export function windowEntries(
  entries: readonly ArchivedEntry[],
  limit: number,
  complete: boolean,
): { entries: ArchivedEntry[]; reachedStart: boolean } {
  if (entries.length <= limit && complete) return { entries: [...entries], reachedStart: true };
  const sentinel = entries.length > limit ? entries[0] : null;
  const candidates = sentinel ? entries.slice(1) : [...entries];
  const cut = sentinel ? sentinel.stampMs : (candidates[0]?.stampMs ?? null);
  if (cut === null) return { entries: candidates, reachedStart: false };
  const whole = candidates.findIndex((e) => e.stampMs !== cut);
  // Every entry shares one millisecond: keep them rather than return nothing.
  return { entries: whole === -1 ? candidates : candidates.slice(whole), reachedStart: false };
}

/** The seq of every entry, in order, continuing after `afterSeq`. */
export function assignSeqs(entries: readonly ArchivedEntry[], afterSeq: number | null): number[] {
  const seqs: number[] = [];
  let previous = afterSeq ?? Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const seq = Math.max(entry.stampMs ?? previous + 1, previous + 1);
    seqs.push(seq);
    previous = seq;
  }
  return seqs;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export interface PageOptions {
  afterSeq: number | null;
  exhausted: boolean;
  reachedStart: boolean;
}

/**
 * One page of history. `entries` are the page, oldest first; `lookback` are older entries of the
 * same chat, fetched only to resolve what the page references (a correction of a message synced
 * in an earlier run). Corrections and retractions become `edits`/`retracted` when their target
 * is outside the page, and are applied in place when it is inside. Either is honoured only from
 * the target's own author — or, for a retraction in a room, from the room's moderation.
 */
export function buildPage(
  context: ChatContext,
  entries: readonly ArchivedEntry[],
  options: PageOptions,
  lookback: readonly ArchivedEntry[] = [],
): ChatHistoryPage {
  const seqs = assignSeqs(entries, options.afterSeq);
  const messages = new Map<string, ChatMessage>();
  const edits = new Map<string, ChatEdit>();
  const retracted = new Set<string>();

  const byReference = new Map<string, ArchivedEntry>();
  for (const entry of [...lookback, ...entries]) {
    for (const key of referenceKeys(context, entry)) byReference.set(key, entry);
  }
  const target = (id: string | null, from: ArchivedEntry): ArchivedEntry | null => {
    const found = id === null ? undefined : byReference.get(id);
    if (!found || found === from) return null;
    return found;
  };

  entries.forEach((entry, index) => {
    if (entry.tombstone) {
      // The archive keeps only the fact that something was here; whatever was stored goes.
      retracted.add(entry.archiveId);
      return;
    }
    if (entry.retract) {
      const original = target(entry.retract.id, entry);
      if (!original) return;
      const byModerator =
        entry.retract.moderated &&
        context.kind === 'group' &&
        entry.from !== null &&
        bareJid(entry.from) === context.chatJid &&
        resourceOf(entry.from) === null;
      if (!byModerator && authorKey(context, entry) !== authorKey(context, original)) return;
      if (!messages.delete(original.archiveId)) retracted.add(original.archiveId);
      edits.delete(original.archiveId);
      return;
    }
    if (entry.replaceId) {
      const original = target(entry.replaceId, entry);
      if (!original || authorKey(context, entry) !== authorKey(context, original)) return;
      const text = entry.encrypted ? null : entry.body;
      const editedAt = iso(entry.stampMs);
      const inPage = messages.get(original.archiveId);
      if (inPage) messages.set(original.archiveId, { ...inPage, text, editedAt });
      else if (!retracted.has(original.archiveId)) {
        edits.set(original.archiveId, { remoteId: original.archiveId, text, editedAt });
      }
      return;
    }
    const hasContent = entry.body !== null || entry.attachmentUrls.length > 0 || entry.encrypted;
    // Markers, receipts, reactions, chat states: entries of the archive, not messages.
    if (!hasContent) return;
    const fromSelf = isFromSelf(context, entry);
    const reply = target(entry.replyToId, entry);
    messages.set(entry.archiveId, {
      remoteId: entry.archiveId,
      seq: seqs[index],
      sentAt: iso(entry.stampMs),
      editedAt: null,
      sender: fromSelf ? null : senderOf(context, entry),
      fromSelf,
      // An encrypted message's body is the sender's "this message is encrypted" fallback, not
      // what they wrote: postbote cannot decrypt (no OMEMO yet), so it indexes no text.
      text: entry.encrypted ? null : entry.body,
      hasAttachments: entry.attachmentUrls.length > 0,
      replyToRemoteId: reply ? reply.archiveId : null,
      threadRemoteId: null,
    });
  });

  const last = entries.length - 1;
  return {
    messages: [...messages.values()],
    highestSeq: last >= 0 ? seqs[last] : null,
    lowestSeq: last >= 0 ? seqs[0] : null,
    exhausted: options.exhausted,
    reachedStart: options.reachedStart,
    highestCursor: last >= 0 ? entries[last].archiveId : null,
    edits: [...edits.values()],
    retracted: [...retracted],
  };
}
