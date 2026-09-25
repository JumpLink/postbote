/**
 * Matrix events → the network-neutral chat driver types of `@postbote/protocol`.
 *
 * Pure: it reads the structural shapes in `api.ts`, so every rule here is tested against
 * synthetic events on both runtimes.
 *
 * The sequence number. The chat port walks each chat along a per-chat monotonic number;
 * Matrix has none a client can see (pagination tokens are opaque). `origin_server_ts` is used
 * instead: monotonic in timeline order in practice, and what every client sorts by. Two costs,
 * both accepted and handled where they bite: equal timestamps (a page is never cut between two
 * events of the same millisecond, see `session.ts`), and an event federated in late with an
 * older timestamp than the cursor, which an incremental run skips and the next full scan finds.
 *
 * In SECONDS, not milliseconds — see `seqOf`.
 */

import type { ChatInfo, ChatMessage, ChatPeer, ChatEdit } from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import type { MxEvent, MxRoom } from './api.ts';

/**
 * The chat sequence of an event: its `origin_server_ts` in whole seconds.
 *
 * gjsify gap (unfixed, no upstream issue yet): gjsify's libgda-backed `node:sqlite` returns an
 * EMPTY result for any SELECT that reads an INTEGER above 2^31-1 (0.49.0; repro: insert
 * 2147483648, `SELECT seq FROM t` gives `[]`), so a millisecond timestamp in `remote_seq` makes
 * the whole chat vanish from every query on GJS while Node shows it. Seconds fit until 2038.
 * Events of one second are never split across pages (`session.ts`), so the coarser sequence
 * costs no message. Switch to milliseconds once the store round-trips 64-bit integers.
 */
export function seqOf(ts: number): number {
  return Math.floor(ts / 1000);
}

/** What an encrypted message this device holds no key for is stored as. Never the ciphertext. */
export const UNDECRYPTABLE_TEXT = '[encrypted message: this device has no key for it]';

/** Message types that carry a file. */
const FILE_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video']);

type Content = Readonly<Record<string, unknown>>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function relatesTo(content: Content): Record<string, unknown> | null {
  const rel = content['m.relates_to'];
  return rel && typeof rel === 'object' ? (rel as Record<string, unknown>) : null;
}

export function toChatPeer(userId: string, displayName: string | null): ChatPeer {
  const value = normalizeAddress('matrix', userId);
  return {
    remoteId: userId,
    displayName,
    addresses: value ? [{ kind: 'matrix', value }] : [],
    // Matrix has no bot flag; bridges and bots are ordinary users to the protocol.
    bot: false,
  };
}

export function toChatInfo(room: MxRoom): ChatInfo {
  return {
    remoteId: room.roomId,
    kind: room.direct ? 'direct' : 'group',
    title: room.name,
    // Like Telegram: a direct chat names the other person; a group's members join through the
    // messages they write (lazy-loaded rooms do not list every member up front).
    members: room.direct ? room.members.map((m) => toChatPeer(m.userId, m.displayName)) : [],
    lastSeq: room.lastEventTs === null ? null : seqOf(room.lastEventTs),
    readInboxSeq: room.readUpToTs === null ? null : seqOf(room.readUpToTs),
    readOutboxSeq: room.peerReadUpToTs === null ? null : seqOf(room.peerReadUpToTs),
  };
}

/**
 * Strip the rich-reply fallback (`> <@a:b> quoted…` lines and a blank line) that older clients
 * put in front of a reply's body. The quote belongs to the replied-to message, not this one.
 */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i < lines.length && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

/** The text a person wrote, or null for a bare file. */
export function messageText(content: Content, reply: boolean): string | null {
  const body = str(content.body);
  if (body === null) return null;
  const msgtype = str(content.msgtype);
  if (msgtype && FILE_MSGTYPES.has(msgtype)) {
    // Since v1.10 a file's `body` is its caption when a separate `filename` is given; before,
    // `body` is the file name — not something the person wrote.
    const filename = str(content.filename);
    return filename !== null && filename !== body ? body : null;
  }
  return reply ? stripReplyFallback(body) : body;
}

/** An edit: the event replaces an earlier one's content. */
export function editOf(event: MxEvent): { target: string; text: string | null } | null {
  if (event.type !== 'm.room.message' || event.redacted || event.undecryptable !== null) return null;
  const rel = relatesTo(event.content);
  if (rel?.rel_type !== 'm.replace') return null;
  const target = str(rel.event_id);
  const fresh = event.content['m.new_content'];
  if (!target || !fresh || typeof fresh !== 'object') return null;
  return { target, text: messageText(fresh as Content, false) };
}

/** The event a redaction removes, or null when the event is not a redaction. */
export function redactionTarget(event: MxEvent): string | null {
  if (event.type !== 'm.room.redaction') return null;
  return event.redacts ?? str(event.content.redacts);
}

/**
 * One event as a chat message, or null for everything that is not something a person wrote:
 * state (joins, names, power levels), reactions, redactions, edits (applied to their target
 * instead), and an event whose content the server already stripped.
 */
export function toChatMessage(
  event: MxEvent,
  selfUserId: string,
  displayNames: ReadonlyMap<string, string>,
): ChatMessage | null {
  if (event.stateKey !== undefined || event.redacted) return null;
  // matrix-js-sdk dresses a failed decryption up as an `m.room.message` (`m.bad.encrypted`);
  // either way, nothing of the ciphertext is kept.
  const encrypted = event.type === 'm.room.encrypted' || event.undecryptable !== null;
  if (!encrypted && event.type !== 'm.room.message' && event.type !== 'm.sticker') return null;
  if (!encrypted && editOf(event)) return null;

  const rel = relatesTo(event.content);
  const inReply = rel?.['m.in_reply_to'];
  // In a thread the reply relation is only a fallback for clients without threads.
  const replyTo =
    rel?.is_falling_back !== true && inReply && typeof inReply === 'object'
      ? str((inReply as Record<string, unknown>).event_id)
      : null;
  const fromSelf = event.sender === selfUserId;
  const msgtype = str(event.content.msgtype);
  return {
    remoteId: event.eventId,
    seq: seqOf(event.ts),
    sentAt: new Date(event.ts).toISOString(),
    editedAt: null,
    sender: fromSelf ? null : toChatPeer(event.sender, displayNames.get(event.sender) ?? null),
    fromSelf,
    text: encrypted ? UNDECRYPTABLE_TEXT : messageText(event.content, replyTo !== null),
    hasAttachments:
      !encrypted && (event.type === 'm.sticker' || (msgtype !== null && FILE_MSGTYPES.has(msgtype))),
    replyToRemoteId: replyTo,
    threadRemoteId: rel?.rel_type === 'm.thread' ? str(rel.event_id) : null,
  };
}

/** A page of events, sorted into what the chat engine writes. */
export interface MappedEvents {
  /** Oldest first, edits within the page already applied. */
  messages: ChatMessage[];
  /** Edits of messages NOT on this page — earlier ones, already stored. */
  edits: ChatEdit[];
  /** Messages the network reports removed (redacted). */
  deletedRemoteIds: string[];
}

/**
 * Map a run of events (oldest first). An edit is applied to its target when the target is on the
 * page — the newest edit by the ORIGINAL sender wins; an edit by anyone else is ignored, as the
 * spec requires — and otherwise handed on as a `ChatEdit` for the stored message.
 */
export function mapEvents(
  events: ReadonlyArray<MxEvent>,
  selfUserId: string,
  displayNames: ReadonlyMap<string, string>,
): MappedEvents {
  const messages: ChatMessage[] = [];
  const byId = new Map<string, { message: ChatMessage; sender: string }>();
  const edits = new Map<string, ChatEdit>();
  const deleted: string[] = [];
  for (const event of events) {
    const removed = redactionTarget(event);
    if (removed) {
      deleted.push(removed);
      continue;
    }
    const edit = editOf(event);
    if (edit) {
      const editedAt = new Date(event.ts).toISOString();
      const own = byId.get(edit.target);
      if (own) {
        if (own.sender === event.sender) {
          own.message.text = edit.text;
          own.message.editedAt = editedAt;
        }
      } else {
        // Per target AND sender: a later edit by someone else must not displace the real one —
        // the store decides which sender counts, since only it knows the original's.
        const key = `${edit.target}\u0000${event.sender}`;
        const previous = edits.get(key);
        if (!previous || (previous.editedAt ?? '') <= editedAt) {
          edits.set(key, {
            remoteId: edit.target,
            text: edit.text,
            editedAt,
            senderRemoteId: event.sender === selfUserId ? null : event.sender,
          });
        }
      }
      continue;
    }
    const message = toChatMessage(event, selfUserId, displayNames);
    if (!message) continue;
    messages.push(message);
    byId.set(message.remoteId, { message, sender: event.sender });
  }
  const gone = new Set(deleted);
  return {
    messages: messages.filter((m) => !gone.has(m.remoteId)),
    edits: [...edits.values()].filter((e) => !gone.has(e.remoteId)),
    deletedRemoteIds: deleted,
  };
}
