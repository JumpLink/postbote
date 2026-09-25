/**
 * One connected Telegram account as a `ChatSession` — the chat driver the sync engine calls.
 *
 * Works on `TelegramApi` only, so a fake client with recorded (synthetic) dialogs and messages
 * drives it in the unit tests exactly as mtcute does in production.
 */

import type { ChatHistoryPage, ChatInfo, ChatSession } from '@postbote/protocol';
import type { TelegramApi, TgMessage } from './api.ts';
import { toChatInfo, toChatMessage } from './map.ts';

function page(
  raw: ReadonlyArray<TgMessage>,
  afterSeq: number | null,
  exhausted: boolean,
  reachedStart: boolean,
): ChatHistoryPage {
  const fresh = afterSeq === null ? raw : raw.filter((m) => m.id > afterSeq);
  const ordered = [...fresh].sort((a, b) => a.id - b.id);
  return {
    messages: ordered.map(toChatMessage).filter((m) => m !== null),
    highestSeq: ordered.length > 0 ? ordered[ordered.length - 1].id : null,
    lowestSeq: ordered.length > 0 ? ordered[0].id : null,
    exhausted,
    reachedStart,
  };
}

export class TelegramChatSession implements ChatSession {
  private readonly api: TelegramApi;

  constructor(api: TelegramApi) {
    this.api = api;
  }

  async listChats(): Promise<ChatInfo[]> {
    const chats: ChatInfo[] = [];
    // Resolving a chat later needs its access hash, which mtcute stores from this very listing —
    // so the sync engine always lists before it fetches.
    for await (const dialog of this.api.iterDialogs()) chats.push(toChatInfo(dialog));
    return chats;
  }

  async fetchHistory(chatRemoteId: string, afterSeq: number | null, limit: number): Promise<ChatHistoryPage> {
    const chatId = Number(chatRemoteId);
    if (!Number.isSafeInteger(chatId)) throw new Error(`not a Telegram chat id: ${chatRemoteId}`);
    if (afterSeq === null) {
      // The newest `limit` messages. Nothing is newer than the newest, so the chat is caught up;
      // a short page means nothing older exists either.
      const raw = await this.api.getHistory(chatId, { limit });
      return page(raw, null, true, raw.length < limit);
    }
    // Oldest first, starting AT the offset id — hence the +1, so `afterSeq` itself is excluded.
    const raw = await this.api.getHistory(chatId, {
      limit,
      offset: { id: afterSeq + 1, date: 0 },
      reverse: true,
    });
    return page(raw, afterSeq, raw.length < limit, false);
  }

  async close(): Promise<void> {
    await this.api.destroy();
  }
}
