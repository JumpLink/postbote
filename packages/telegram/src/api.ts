/**
 * The slice of mtcute's `TelegramClient` postbote uses — and nothing else.
 *
 * Structural on purpose: mtcute's own classes (`User`, `Chat`, `Dialog`, `Message`) satisfy these
 * shapes, and so does a plain object in a test. That is what lets the mapping and the session be
 * unit-tested on Node and GJS against recorded, synthetic data, with no network and no account.
 *
 * Read-only by construction: no method here can send, edit, delete or mark anything read.
 */

export interface TgUser {
  readonly type: 'user';
  /** The user id (positive). */
  readonly id: number;
  readonly username: string | null;
  /** Digits without `+`, as Telegram reports it — only when the user shares it with you. */
  readonly phoneNumber: string | null;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly isSelf: boolean;
}

export interface TgChat {
  readonly type: 'chat';
  /** The MARKED id (negative for groups and channels). */
  readonly id: number;
  readonly chatType: string;
  readonly displayName: string;
  readonly username: string | null;
}

export type TgPeer = TgUser | TgChat;

export interface TgRepliedMessage {
  readonly id: number | null;
  readonly threadId: number | null;
}

export interface TgMessage {
  readonly id: number;
  readonly date: Date;
  readonly editDate: Date | null;
  readonly sender: TgPeer | { readonly type: 'anonymous' };
  readonly chat: TgPeer;
  readonly isOutgoing: boolean;
  /** Joins, pins, title changes — notices, not something a person wrote. */
  readonly isService: boolean;
  readonly text: string;
  readonly media: { readonly type: string } | null;
  readonly replyToMessage: TgRepliedMessage | null;
  readonly isTopicMessage: boolean;
}

export interface TgDialog {
  readonly peer: TgPeer;
  readonly lastMessage: TgMessage | null;
  /** Everything at or below this id was read by the user. */
  readonly lastReadIngoing: number;
  /** Everything the user sent at or below this id was read by the other side. */
  readonly lastReadOutgoing: number;
}

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  /** Every dialog, most recently active first. */
  iterDialogs(): AsyncIterable<TgDialog>;
  /**
   * mtcute's `getHistory`: newest first by default; with `reverse` oldest first, starting AT
   * `offset.id` (inclusive).
   */
  getHistory(
    chatId: number,
    params: { limit: number; offset?: { id: number; date: number }; reverse?: boolean },
  ): Promise<ReadonlyArray<TgMessage>>;
  destroy(): Promise<void>;
}

/** What the interactive login asks the user for. Each is called only when Telegram needs it. */
export interface LoginPrompts {
  phone(): Promise<string>;
  code(): Promise<string>;
  /** Only asked for an account with two-step verification. */
  password(): Promise<string>;
  /** Progress for the user ("code sent via the Telegram app"). Never carries a secret. */
  notify(message: string): void;
}

/** A full client: the read API plus connecting and logging in. What a `ClientFactory` returns. */
export interface TelegramClientHandle extends TelegramApi {
  connect(): Promise<void>;
  /** Log in (phone → code → optional 2FA password) and return the logged-in user. */
  login(prompts: LoginPrompts): Promise<TgUser>;
}
