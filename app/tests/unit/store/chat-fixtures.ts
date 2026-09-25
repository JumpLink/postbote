import { type BackendManifest, PLUGIN_API_VERSION } from '@postbote/protocol';
import type {
  BackendAccount,
  ChatBackend,
  ChatHistoryPage,
  ChatInfo,
  ChatMessage,
  ChatPeer,
  ChatSession,
} from '@postbote/protocol';

/**
 * A scriptable fake chat network behind the `ChatBackend` port: accounts, chats, messages with
 * per-chat sequences, read markers, and injectable failures. The chat sync engine and the
 * conversation rebuild run against it on Node and GJS with no network and no account.
 *
 * It follows the port's contract to the letter (newest window for `afterSeq` null, strictly
 * newer and oldest first otherwise) so a test that passes here is a test of the ENGINE.
 *
 * All content is synthetic.
 */

export const ANNA: ChatPeer = {
  remoteId: '1001',
  displayName: 'Anna Example',
  addresses: [
    { kind: 'telegram', value: '1001' },
    { kind: 'telegram', value: 'anna_example' },
    { kind: 'phone', value: '+491510000000' },
  ],
  bot: false,
};

export const BEN: ChatPeer = {
  remoteId: '1002',
  displayName: 'Ben Example',
  addresses: [{ kind: 'telegram', value: '1002' }],
  bot: false,
};

export const HELPER_BOT: ChatPeer = {
  remoteId: '1003',
  displayName: 'Helper Bot',
  addresses: [
    { kind: 'telegram', value: '1003' },
    { kind: 'telegram', value: 'helper_bot' },
  ],
  bot: true,
};

export const NEWS: ChatPeer = {
  remoteId: '-1005000',
  displayName: 'Example News',
  addresses: [{ kind: 'telegram', value: 'example_news' }],
  bot: false,
};

interface FakeChat {
  info: Omit<ChatInfo, 'lastSeq'>;
  messages: ChatMessage[];
}

export function chatMessage(
  chatId: string,
  seq: number,
  sender: ChatPeer | 'me',
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    remoteId: `${chatId}/${seq}`,
    seq,
    sentAt: new Date(Date.UTC(2026, 7, 1, 10, 0, seq)).toISOString(),
    editedAt: null,
    sender: sender === 'me' ? null : sender,
    fromSelf: sender === 'me',
    text,
    hasAttachments: false,
    replyToRemoteId: null,
    threadRemoteId: null,
    ...extra,
  };
}

/** Named `telegram` so ids match what the real backend produces; otherwise a plain chat manifest. */
export const FAKE_CHAT_MANIFEST: BackendManifest = {
  name: 'telegram',
  displayName: 'Fake chat network',
  pluginApi: PLUGIN_API_VERSION,
  capabilities: {
    edits: true,
    reactions: true,
    threads: true,
    readReceipts: true,
    groups: true,
    e2ee: false,
    subject: false,
    folders: false,
    attachments: true,
  },
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['telegram', 'phone'],
  terms: null,
};

export class FakeChatBackend implements ChatBackend {
  readonly manifest = FAKE_CHAT_MANIFEST;
  readonly kind = 'chat' as const;
  readonly accounts: BackendAccount[] = [
    { id: 'telegram-42', identity: '@me_example', provider: 'Telegram' },
  ];
  readonly chats = new Map<string, FakeChat>();
  /** Every fetchHistory call, as `chat:afterSeq:limit`. */
  readonly calls: string[] = [];
  /** Chats whose fetch throws. */
  readonly failing = new Set<string>();
  connectError: Error | null = null;
  closed = 0;

  addChat(info: Omit<ChatInfo, 'lastSeq' | 'readInboxSeq' | 'readOutboxSeq'> & Partial<ChatInfo>): void {
    this.chats.set(info.remoteId, {
      info: { readInboxSeq: null, readOutboxSeq: null, ...info },
      messages: [],
    });
  }

  post(chatId: string, ...messages: ChatMessage[]): void {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`no fake chat ${chatId}`);
    chat.messages.push(...messages);
    chat.messages.sort((a, b) => a.seq - b.seq);
  }

  markRead(chatId: string, inbox: number | null, outbox: number | null = null): void {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`no fake chat ${chatId}`);
    chat.info.readInboxSeq = inbox;
    chat.info.readOutboxSeq = outbox;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return this.accounts;
  }

  async connect(_accountId: string): Promise<ChatSession> {
    if (this.connectError) throw this.connectError;
    return {
      listChats: async (): Promise<ChatInfo[]> => {
        return [...this.chats.values()]
          .map((c) => ({ ...c.info, lastSeq: c.messages.at(-1)?.seq ?? null }))
          .sort((a, b) => (b.lastSeq ?? 0) - (a.lastSeq ?? 0));
      },
      fetchHistory: async (
        chatId: string,
        afterSeq: number | null,
        limit: number,
      ): Promise<ChatHistoryPage> => {
        this.calls.push(`${chatId}:${afterSeq}:${limit}`);
        if (this.failing.has(chatId)) throw new Error('synthetic network failure');
        const all = this.chats.get(chatId)?.messages ?? [];
        const slice =
          afterSeq === null
            ? all.slice(Math.max(0, all.length - limit))
            : all.filter((m) => m.seq > afterSeq).slice(0, limit);
        return {
          messages: slice,
          highestSeq: slice.at(-1)?.seq ?? null,
          exhausted: afterSeq === null || slice.length < limit,
        };
      },
      close: async (): Promise<void> => {
        this.closed++;
      },
    };
  }
}

/** A fake Telegram account with a direct chat (Anna), a group (Anna, Ben, a bot) and a channel. */
export function telegramFixture(): FakeChatBackend {
  const backend = new FakeChatBackend();
  backend.addChat({ remoteId: '1001', kind: 'direct', title: 'Anna Example', members: [ANNA] });
  backend.addChat({ remoteId: '-4001', kind: 'group', title: 'Sommerfest Orga', members: [] });
  backend.addChat({ remoteId: '-1005000', kind: 'broadcast', title: 'Example News', members: [] });
  backend.post(
    '1001',
    chatMessage('1001', 1, ANNA, 'Kommst du am Samstag?'),
    chatMessage('1001', 2, 'me', 'Ja, gerne'),
    chatMessage('1001', 3, ANNA, 'Super, bis dann', { hasAttachments: true }),
  );
  backend.post(
    '-4001',
    chatMessage('-4001', 10, BEN, 'Wer bringt Salat mit?'),
    chatMessage('-4001', 11, HELPER_BOT, 'Umfrage gestartet'),
    chatMessage('-4001', 12, ANNA, 'Ich', { replyToRemoteId: '-4001/10' }),
  );
  backend.post('-1005000', chatMessage('-1005000', 500, NEWS, 'Neue Ausgabe erschienen'));
  backend.markRead('1001', 2, 2);
  return backend;
}
