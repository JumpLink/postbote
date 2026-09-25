/**
 * The slice of Matrix postbote uses — and nothing else.
 *
 * Structural on purpose: `client.ts` fills these shapes from matrix-js-sdk, and a plain object
 * with synthetic events fills them in a test. That is what lets the mapping and the session be
 * unit-tested on Node and GJS with no homeserver, no account and no WASM.
 *
 * Read-only by construction: nothing here can send, join, redact or mark anything read.
 */

/**
 * One timeline event as the CLIENT sees it: already decrypted where a key was available, so
 * `type`/`content` are the clear ones (`m.room.message`, not `m.room.encrypted`).
 */
export interface MxEvent {
  readonly eventId: string;
  readonly type: string;
  readonly sender: string;
  /** `origin_server_ts`, ms since the epoch. */
  readonly ts: number;
  /** State events carry a state key (even an empty one); timeline messages do not. */
  readonly stateKey?: string;
  readonly content: Readonly<Record<string, unknown>>;
  /** `m.room.redaction` only: the event it removes (top-level before room v11, in content after). */
  readonly redacts?: string;
  /** The server already stripped this event's content: it was redacted. */
  readonly redacted: boolean;
  /** Set when the event is encrypted and this device holds no key for it. */
  readonly undecryptable: string | null;
}

/** One joined room, as the list of chats needs it. */
export interface MxRoom {
  readonly roomId: string;
  readonly name: string | null;
  /** Listed in the user's `m.direct` account data. */
  readonly direct: boolean;
  /** The other members worth naming: for a direct chat, the other person. */
  readonly members: ReadonlyArray<{ readonly userId: string; readonly displayName: string | null }>;
  /** `origin_server_ts` of the newest event the server reported, or null for an empty room. */
  readonly lastEventTs: number | null;
  /** How far the user has read, as a timestamp (null: unknown). */
  readonly readUpToTs: number | null;
  /** How far the other side has read the user's messages, as a timestamp (null: unknown). */
  readonly peerReadUpToTs: number | null;
}

/** One page of `/messages`, newest first (it is always requested backwards). */
export interface MxMessagesPage {
  readonly events: ReadonlyArray<MxEvent>;
  /** Token for the next, older page; null when the room's start was reached. */
  readonly end: string | null;
  /** Display names of the senders on this page (lazy-loaded member state). */
  readonly displayNames: ReadonlyMap<string, string>;
}

export interface MatrixApi {
  /** The logged-in user, `@local:server`. */
  readonly userId: string;
  /** Every room the user has JOINED. Invites are not accepted here: postbote only reads. */
  listRooms(): Promise<MxRoom[]>;
  /** One page backwards from `from` (null: from the newest event). */
  messages(roomId: string, from: string | null, limit: number): Promise<MxMessagesPage>;
  /**
   * One event by id, decrypted when a key is available now; null when the server no longer
   * returns it (deleted, or the user lost access).
   */
  fetchEvent(roomId: string, eventId: string): Promise<MxEvent | null>;
  /** Stop syncing and persist the crypto store. Throws when the store could not be saved. */
  close(): Promise<void>;
}

/** What the password login needs from the user. */
export interface MatrixLoginPrompts {
  /** A homeserver URL (`https://…`) or a server name to discover it for (`example.org`). */
  homeserver(): Promise<string>;
  /** The user: `@local:server` or just the localpart. */
  user(): Promise<string>;
  password(): Promise<string>;
  /** Progress for the user. Never carries a secret. */
  notify(message: string): void;
}

/**
 * Which stored messages could not be decrypted, per room — so a later run can try them again once
 * a key has arrived. Kept in the account's secret file next to the crypto store it depends on:
 * the list only means something together with THAT store (a new device has other keys), and it
 * holds event and room ids only, never ciphertext.
 */
export interface UndecryptableLedger {
  load(): Map<string, string[]>;
  save(ledger: ReadonlyMap<string, readonly string[]>): void;
}
