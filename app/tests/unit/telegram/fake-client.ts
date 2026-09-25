import type {
  ClientOptions,
  LoginPrompts,
  TelegramClientHandle,
  TgChat,
  TgDialog,
  TgMessage,
  TgPeer,
  TgUser,
} from '@postbote/telegram';

/**
 * A fake mtcute client: recorded, SYNTHETIC dialogs and messages in the exact shapes mtcute's
 * classes have (`api.ts`), a scripted login, and the storage it was handed — so a test can check
 * what the backend asked mtcute to persist.
 *
 * `getHistory` implements mtcute's semantics, not a simplification of them: newest first by
 * default, and with `reverse` oldest first starting AT `offset.id`, inclusive.
 */

export function user(id: number, displayName: string, extra: Partial<TgUser> = {}): TgUser {
  return {
    type: 'user',
    id,
    username: null,
    phoneNumber: null,
    displayName,
    isBot: false,
    isSelf: false,
    ...extra,
  };
}

export function group(
  id: number,
  displayName: string,
  chatType = 'supergroup',
  username: string | null = null,
): TgChat {
  return { type: 'chat', id, chatType, displayName, username };
}

export function tgMessage(
  chat: TgPeer,
  id: number,
  sender: TgPeer | 'me',
  text: string,
  extra: Partial<TgMessage> = {},
): TgMessage {
  return {
    id,
    date: new Date(Date.UTC(2026, 7, 1, 9, 0, id)),
    editDate: null,
    sender: sender === 'me' ? ME : sender,
    chat,
    isOutgoing: sender === 'me',
    isService: false,
    text,
    media: null,
    replyToMessage: null,
    isTopicMessage: false,
    ...extra,
  };
}

export const ME = user(42, 'Me Example', {
  username: 'me_example',
  isSelf: true,
  phoneNumber: '49170000000',
});

export interface FakeScript {
  dialogs?: TgDialog[];
  history?: Map<number, TgMessage[]>;
  /** What `login` resolves with, after asking every prompt in order. */
  loginAs?: TgUser;
  /** Thrown by `connect`/`getMe` to simulate a revoked session. */
  unauthorized?: boolean;
}

export class FakeClient implements TelegramClientHandle {
  readonly storage: ClientOptions['storage'];
  readonly script: FakeScript;
  readonly calls: string[] = [];
  destroyed = 0;

  constructor(options: ClientOptions, script: FakeScript) {
    this.storage = options.storage;
    this.script = script;
  }

  async connect(): Promise<void> {
    this.calls.push('connect');
    await this.storage.driver.load?.();
  }

  async getMe(): Promise<TgUser> {
    this.calls.push('getMe');
    if (this.script.unauthorized) throw new Error('AUTH_KEY_UNREGISTERED');
    return ME;
  }

  async *iterDialogs(): AsyncIterable<TgDialog> {
    this.calls.push('iterDialogs');
    for (const dialog of this.script.dialogs ?? []) yield dialog;
  }

  async getHistory(
    chatId: number,
    params: { limit: number; offset?: { id: number; date: number }; reverse?: boolean },
  ): Promise<ReadonlyArray<TgMessage>> {
    this.calls.push(
      `getHistory:${chatId}:${params.reverse ? `rev@${params.offset?.id}` : 'newest'}:${params.limit}`,
    );
    const all = [...(this.script.history?.get(chatId) ?? [])].sort((a, b) => a.id - b.id);
    if (params.reverse) {
      const from = params.offset?.id ?? 1;
      return all.filter((m) => m.id >= from).slice(0, params.limit);
    }
    return all.reverse().slice(0, params.limit);
  }

  async login(prompts: LoginPrompts): Promise<TgUser> {
    this.calls.push('login');
    await this.storage.driver.load?.();
    const phone = await prompts.phone();
    const code = await prompts.code();
    if (!phone || !code) throw new Error('PHONE_CODE_EMPTY');
    const password = await prompts.password();
    if (password !== 'correct horse') throw new Error('PASSWORD_HASH_INVALID');
    // What a real login leaves behind: an auth key for the home DC and the session's own state.
    await this.storage.authKeys.set(2, new Uint8Array([1, 2, 3, 4, 250, 251]));
    await this.storage.kv.set('dc', new Uint8Array([2]));
    return this.script.loginAs ?? ME;
  }

  async destroy(): Promise<void> {
    this.destroyed++;
    await this.storage.driver.save?.();
  }
}

/** A factory that records every client it made. */
export function fakeFactory(script: FakeScript): {
  clients: FakeClient[];
  create: (o: ClientOptions) => FakeClient;
} {
  const clients: FakeClient[] = [];
  return {
    clients,
    create: (options) => {
      const client = new FakeClient(options, script);
      clients.push(client);
      return client;
    },
  };
}
