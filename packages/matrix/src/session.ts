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

import type { ChatHistoryPage, ChatInfo, ChatSession } from '@postbote/protocol';
import type { MatrixApi, MxEvent } from './api.ts';
import { mapEvents, seqOf, toChatInfo, toChatMessage } from './map.ts';

/** Events per `/messages` request. */
export const MESSAGES_PAGE = 100;

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

  constructor(api: MatrixApi) {
    this.api = api;
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
    const mapped = mapEvents(taken, this.api.userId, walk.displayNames);
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
    const mapped = mapEvents([...covered].reverse(), this.api.userId, walk.displayNames);
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
    await this.api.close();
  }
}
