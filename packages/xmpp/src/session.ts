/**
 * One connected XMPP account as a `ChatSession` — the chat driver the sync engine calls.
 *
 * Chats are the roster's contacts (direct) and the bookmarked rooms the user joins (autojoin).
 * History comes only from the server archive (MAM): the user's own archive for direct chats,
 * each room's archive for rooms. Works on `XmppApi` only, so a fake with synthetic stanzas
 * drives it in the unit tests exactly as xmpp.js does in production.
 */

import type { ChatHistoryPage, ChatInfo, ChatSession } from '@postbote/protocol';
import { type MamPage, type MamQuery, type XmppApi, XmppQueryError } from './api.ts';
import { buildPage, type ChatContext, toChatInfo, unresolvedReferences, windowEntries } from './map.ts';
import type { ArchivedEntry } from './stanza.ts';

/** Older entries fetched to resolve a correction or retraction of a message outside the page. */
export const LOOKBACK = 100;

/** Archive queries in flight at once while listing (one per chat, for its newest entry). */
const PROBE_CONCURRENCY = 8;

interface ChatState extends ChatContext {
  /** False for a room whose archive refused us or does not exist: listed, never fetched. */
  archived: boolean;
}

async function pool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const empty = (afterSeq: number | null): ChatHistoryPage => ({
  messages: [],
  highestSeq: null,
  lowestSeq: null,
  exhausted: true,
  reachedStart: afterSeq === null,
  highestCursor: null,
  edits: [],
  retracted: [],
});

export class XmppChatSession implements ChatSession {
  private readonly api: XmppApi;
  private readonly chats = new Map<string, ChatState>();

  constructor(api: XmppApi) {
    this.api = api;
  }

  private query(chat: ChatState, rest: Omit<MamQuery, 'archive' | 'with'>): Promise<MamPage> {
    return this.api.mam(
      chat.kind === 'group'
        ? { archive: chat.chatJid, ...rest }
        : { archive: null, with: chat.chatJid, ...rest },
    );
  }

  async listChats(): Promise<ChatInfo[]> {
    const self = this.api.jid;
    const [roster, bookmarks] = await Promise.all([this.api.roster(), this.api.bookmarks()]);
    const states: ChatState[] = [];
    const seen = new Set<string>();
    for (const room of bookmarks) {
      if (!room.autojoin || seen.has(room.jid)) continue;
      seen.add(room.jid);
      states.push({
        kind: 'group',
        chatJid: room.jid,
        selfJid: self,
        selfNick: room.nick,
        name: room.name,
        archived: true,
      });
    }
    for (const contact of roster) {
      // A roster entry without a local part is a server or gateway, not a person to chat with.
      if (contact.jid === self || seen.has(contact.jid) || !contact.jid.includes('@')) continue;
      seen.add(contact.jid);
      states.push({
        kind: 'direct',
        chatJid: contact.jid,
        selfJid: self,
        selfNick: null,
        name: contact.name,
        archived: true,
      });
    }

    const newest = await pool(states, PROBE_CONCURRENCY, async (chat): Promise<ArchivedEntry | null> => {
      try {
        const page = await this.query(chat, { before: '', max: 1 });
        return page.entries.at(-1) ?? null;
      } catch (err) {
        // A room may keep no archive, or keep it for occupants only: list it, fetch nothing.
        // The user's own archive failing is not that — it fails the account.
        if (chat.kind === 'group' && err instanceof XmppQueryError) {
          chat.archived = false;
          return null;
        }
        throw err;
      }
    });

    this.chats.clear();
    for (const chat of states) this.chats.set(chat.chatJid, chat);
    // Most recently active first, like every other chat list.
    return states
      .map((chat, i) => ({ info: toChatInfo(chat, newest[i]), at: newest[i]?.stampMs ?? -1 }))
      .sort((a, b) => b.at - a.at)
      .map((c) => c.info);
  }

  async fetchHistory(
    chatRemoteId: string,
    afterSeq: number | null,
    limit: number,
    afterCursor?: string | null,
  ): Promise<ChatHistoryPage> {
    const chat = this.chats.get(chatRemoteId);
    if (!chat) throw new Error(`unknown XMPP chat ${chatRemoteId} — list the chats first`);
    if (!chat.archived) return empty(afterSeq);

    let entries: ArchivedEntry[];
    let exhausted: boolean;
    let reachedStart = false;
    if (afterSeq === null) {
      // The newest `limit` entries — the last page, which MAM returns oldest first — plus one
      // older entry that shows where the window may start (see `windowEntries`).
      const page = await this.query(chat, { before: '', max: limit + 1 });
      ({ entries, reachedStart } = windowEntries(page.entries, limit, page.complete));
      exhausted = true;
    } else {
      const page = await this.forward(chat, afterSeq, limit, afterCursor ?? null);
      entries = page.entries;
      exhausted = page.complete;
    }

    const context: ChatContext = chat;
    let lookback: ArchivedEntry[] = [];
    if (entries.length > 0 && unresolvedReferences(context, entries).length > 0) {
      // A correction or retraction of something older than the page: one bounded look back.
      // What is not found there stays as it was stored.
      const older = await this.query(chat, { before: entries[0].archiveId, max: LOOKBACK });
      lookback = older.entries;
    }
    return buildPage(context, entries, { afterSeq, exhausted, reachedStart }, lookback);
  }

  /**
   * The page after the stored archive id. An archive that no longer knows the id (expired or
   * purged: `item-not-found`) — or a cursor from before ids were stored — resumes by time from
   * the stored seq instead. Entries it returns twice are the same rows: harmless.
   */
  private async forward(
    chat: ChatState,
    afterSeq: number,
    limit: number,
    afterCursor: string | null,
  ): Promise<MamPage> {
    if (afterCursor) {
      try {
        return await this.query(chat, { after: afterCursor, max: limit });
      } catch (err) {
        if (!(err instanceof XmppQueryError) || err.condition !== 'item-not-found') throw err;
      }
    }
    return this.query(chat, { start: new Date(afterSeq).toISOString(), max: limit });
  }

  async close(): Promise<void> {
    await this.api.close();
  }
}
