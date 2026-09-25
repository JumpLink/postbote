/**
 * One connected Matrix account as a `ChatSession` — the chat driver the sync engine calls.
 *
 * Works on `MatrixApi` only, so a fake with synthetic rooms and events drives it in the unit
 * tests exactly as matrix-js-sdk does in production.
 *
 * History is read with `/messages`, BACKWARDS from the newest event: that needs no stored
 * pagination token (the forward tokens of `/sync` are only valid with the sync state that issued
 * them, which a run-and-exit client does not keep). A forward call — "everything newer than the
 * cursor" — walks back until it passes the cursor and hands out the part above it oldest first.
 * The walk is cached per room for the session, so the engine's page-by-page loop over one chat
 * costs one walk, not one per page.
 *
 * The sequence is `origin_server_ts` in seconds (`seqOf` in `map.ts`). A page is never cut
 * between two events of the same second: the engine asks for "strictly newer than the cursor",
 * and a cut there would lose the second one for good.
 */

import type { ChatEdit, ChatHistoryPage, ChatInfo, ChatRevision, ChatSession } from '@postbote/protocol';
import type { MatrixApi, MxEvent, UndecryptableLedger } from './api.ts';
import {
  editOf,
  type MappedEvents,
  mapEvents,
  seqOf,
  toChatInfo,
  toChatMessage,
  UNDECRYPTABLE_TEXT,
} from './map.ts';

/** Events per `/messages` request. */
export const MESSAGES_PAGE = 100;

/**
 * Undecryptable messages retried per run, across all rooms (one `/event` request each). The rest
 * wait for the next run, oldest room entries first; the ledger keeps them.
 */
export const RETRY_PER_RUN = 200;

/** A ledger that remembers nothing — for a caller that does not retry. */
export const NO_LEDGER: UndecryptableLedger = { load: () => new Map(), save: () => {} };

interface Walk {
  /** Newest first, in timeline order. */
  events: MxEvent[];
  end: string | null;
  started: boolean;
  reachedStart: boolean;
  displayNames: Map<string, string>;
}

export class MatrixChatSession implements ChatSession {
  private readonly api: MatrixApi;
  private readonly walks = new Map<string, Walk>();
  private readonly ledgerStore: UndecryptableLedger;
  /** Room → event ids of stored placeholders that are still undecryptable. */
  private readonly ledger: Map<string, Set<string>>;
  /** Placeholders handed out by THIS run: not retried in the same run (no key can have come). */
  private readonly fresh = new Set<string>();
  private ledgerChanged = false;

  constructor(api: MatrixApi, ledger: UndecryptableLedger = NO_LEDGER) {
    this.api = api;
    this.ledgerStore = ledger;
    this.ledger = new Map([...ledger.load()].map(([room, ids]) => [room, new Set(ids)]));
  }

  /** Remember the placeholders of a page, and forget ids the page shows decrypted or deleted. */
  private track(roomId: string, mapped: MappedEvents): MappedEvents {
    let ids = this.ledger.get(roomId);
    for (const m of mapped.messages) {
      if (m.text === UNDECRYPTABLE_TEXT) {
        if (!ids) {
          ids = new Set();
          this.ledger.set(roomId, ids);
        }
        if (!ids.has(m.remoteId)) this.ledgerChanged = true;
        ids.add(m.remoteId);
        this.fresh.add(m.remoteId);
      } else if (ids?.delete(m.remoteId)) {
        this.ledgerChanged = true;
      }
    }
    for (const id of mapped.deletedRemoteIds) if (ids?.delete(id)) this.ledgerChanged = true;
    return mapped;
  }

  /**
   * Try every remembered placeholder again. A message that decrypts now becomes an edit of its
   * stored row (same sender, the real text); one that turns out to be an edit or a reaction
   * removes the placeholder (and an edit is applied to its target); one the server no longer
   * returns is dropped from the ledger — and from the index, since the server lost it.
   */
  async revisions(): Promise<ChatRevision[]> {
    const revisions: ChatRevision[] = [];
    let budget = RETRY_PER_RUN;
    for (const [roomId, ids] of this.ledger) {
      if (budget <= 0) break;
      const edits: ChatEdit[] = [];
      const deleted: string[] = [];
      for (const eventId of [...ids]) {
        if (budget <= 0) break;
        if (this.fresh.has(eventId)) continue;
        budget--;
        const event = await this.api.fetchEvent(roomId, eventId);
        if (event?.undecryptable) continue;
        ids.delete(eventId);
        this.ledgerChanged = true;
        const message = event ? toChatMessage(event, this.api.userId, new Map()) : null;
        if (event && message) {
          edits.push({
            remoteId: eventId,
            text: message.text,
            // Not an edit by a person: the text was there all along, only unreadable.
            editedAt: null,
            senderRemoteId: message.fromSelf ? null : event.sender,
          });
          continue;
        }
        deleted.push(eventId);
        const edit = event ? editOf(event) : null;
        if (event && edit) {
          edits.push({
            remoteId: edit.target,
            text: edit.text,
            editedAt: new Date(event.ts).toISOString(),
            senderRemoteId: event.sender === this.api.userId ? null : event.sender,
          });
        }
      }
      if (ids.size === 0) this.ledger.delete(roomId);
      if (edits.length > 0 || deleted.length > 0) {
        revisions.push({ chatRemoteId: roomId, edits, deletedRemoteIds: deleted });
      }
    }
    return revisions;
  }

  async listChats(): Promise<ChatInfo[]> {
    const rooms = await this.api.listRooms();
    return rooms.sort((a, b) => (b.lastEventTs ?? 0) - (a.lastEventTs ?? 0)).map(toChatInfo);
  }

  private walk(roomId: string): Walk {
    let walk = this.walks.get(roomId);
    if (!walk) {
      walk = { events: [], end: null, started: false, reachedStart: false, displayNames: new Map() };
      this.walks.set(roomId, walk);
    }
    return walk;
  }

  /** Page backwards until `enough` holds or the room's first event is reached. */
  private async walkUntil(roomId: string, walk: Walk, enough: () => boolean): Promise<void> {
    while (!walk.reachedStart && !enough()) {
      const page = await this.api.messages(roomId, walk.started ? walk.end : null, MESSAGES_PAGE);
      walk.started = true;
      walk.events.push(...page.events);
      for (const [id, name] of page.displayNames) walk.displayNames.set(id, name);
      walk.end = page.end;
      if (page.end === null || page.events.length === 0) walk.reachedStart = true;
    }
  }

  private isMessage(event: MxEvent): boolean {
    return toChatMessage(event, this.api.userId, new Map()) !== null;
  }

  async fetchHistory(chatRemoteId: string, afterSeq: number | null, limit: number): Promise<ChatHistoryPage> {
    const walk = this.walk(chatRemoteId);
    if (afterSeq === null) return this.window(chatRemoteId, walk, limit);

    await this.walkUntil(
      chatRemoteId,
      walk,
      () => walk.events.length > 0 && seqOf(walk.events[walk.events.length - 1].ts) <= afterSeq,
    );
    const newer = walk.events.filter((e) => seqOf(e.ts) > afterSeq).reverse();
    if (newer.length === 0) {
      return { messages: [], highestSeq: null, lowestSeq: null, exhausted: true, reachedStart: false };
    }
    // The oldest `limit` messages above the cursor, and every event up to the last one of them —
    // extended through events of the same second.
    let cut = newer.length;
    let count = 0;
    for (let i = 0; i < newer.length; i++) {
      if (this.isMessage(newer[i]) && ++count === limit) {
        cut = i + 1;
        while (cut < newer.length && seqOf(newer[cut].ts) === seqOf(newer[i].ts)) cut++;
        break;
      }
    }
    const taken = newer.slice(0, cut);
    const exhausted = cut === newer.length;
    const mapped = this.track(chatRemoteId, mapEvents(taken, this.api.userId, walk.displayNames));
    return {
      messages: mapped.messages,
      edits: mapped.edits,
      deletedRemoteIds: mapped.deletedRemoteIds,
      highestSeq: Math.max(...taken.map((e) => seqOf(e.ts))),
      lowestSeq: Math.min(...taken.map((e) => seqOf(e.ts))),
      exhausted,
      reachedStart: false,
    };
  }

  /** The newest `limit` messages — the first sync of a chat, and every full scan. */
  private async window(roomId: string, walk: Walk, limit: number): Promise<ChatHistoryPage> {
    let messages = 0;
    let counted = 0;
    const countTo = (): number => {
      for (; counted < walk.events.length; counted++) {
        if (this.isMessage(walk.events[counted])) messages++;
        if (messages >= limit) return counted + 1;
      }
      return -1;
    };
    await this.walkUntil(roomId, walk, () => countTo() !== -1);
    // Asked again: a walk that reached the room's start stopped without asking.
    const found = countTo();
    let cut = found === -1 ? walk.events.length : found;
    // Never between two events of the same second (see the file comment).
    while (
      cut > 0 &&
      cut < walk.events.length &&
      seqOf(walk.events[cut].ts) === seqOf(walk.events[cut - 1].ts)
    )
      cut++;
    const covered = walk.events.slice(0, cut);
    const reachedStart = walk.reachedStart && cut === walk.events.length;
    if (covered.length === 0) {
      return { messages: [], highestSeq: null, lowestSeq: null, exhausted: true, reachedStart };
    }
    const mapped = this.track(roomId, mapEvents([...covered].reverse(), this.api.userId, walk.displayNames));
    const lowest = Math.min(...covered.map((e) => seqOf(e.ts)));
    return {
      messages: mapped.messages,
      edits: mapped.edits,
      deletedRemoteIds: mapped.deletedRemoteIds,
      highestSeq: Math.max(...covered.map((e) => seqOf(e.ts))),
      // Unless the page reaches the room's start, an older, unfetched event may share the lowest
      // second; the range that proves a deletion therefore starts one above it.
      lowestSeq: reachedStart ? lowest : lowest + 1,
      exhausted: true,
      reachedStart,
    };
  }

  async close(): Promise<void> {
    try {
      if (this.ledgerChanged) {
        this.ledgerStore.save(new Map([...this.ledger].map(([room, ids]) => [room, [...ids]])));
      }
    } finally {
      await this.api.close();
    }
  }
}
