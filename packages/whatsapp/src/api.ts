/**
 * The slice of Baileys postbote uses — and nothing else.
 *
 * Structural on purpose: Baileys' own objects (`WAMessage`, `Chat`, `Contact`, the event map)
 * satisfy these shapes, and so does a plain object in a test. That is what lets the mapping and
 * the receive path be unit-tested on Node and GJS against synthetic events, with no network, no
 * phone and no account.
 *
 * Read-only by construction: nothing here can send a message, a read receipt or a presence.
 * (Baileys itself still acknowledges each delivered message with a `delivery`/`inactive`
 * receipt — every linked device does, it is how the server knows it may forget the message.
 * That is the grey double tick, never the blue one; see `client.ts`.)
 */

/** A protobuf `Long`, as protobufjs decodes 64-bit fields. */
export interface WaLong {
  toString(): string;
}

export type WaNumber = number | WaLong | null | undefined;

export interface WaMessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
  /** The same chat under its other addressing (phone number ↔ LID), when the server sent it. */
  remoteJidAlt?: string;
  participantAlt?: string;
}

export interface WaContextInfo {
  stanzaId?: string | null;
}

/** A media message: every one of them may carry a caption and a reply context. */
export interface WaMedia {
  caption?: string | null;
  fileName?: string | null;
  contextInfo?: WaContextInfo | null;
}

export interface WaProtocolMessage {
  key?: WaMessageKey | null;
  /** 0 = REVOKE, 14 = MESSAGE_EDIT; the other types are protocol housekeeping. */
  type?: number | null;
  editedMessage?: WaMessageContent | null;
  timestampMs?: WaNumber;
}

/** `proto.IMessage`, reduced to the fields that carry what a person wrote. */
export interface WaMessageContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null; contextInfo?: WaContextInfo | null } | null;
  imageMessage?: WaMedia | null;
  videoMessage?: WaMedia | null;
  ptvMessage?: WaMedia | null;
  audioMessage?: WaMedia | null;
  documentMessage?: WaMedia | null;
  stickerMessage?: WaMedia | null;
  contactMessage?: { displayName?: string | null; contextInfo?: WaContextInfo | null } | null;
  contactsArrayMessage?: { displayName?: string | null } | null;
  locationMessage?: {
    name?: string | null;
    address?: string | null;
    degreesLatitude?: number | null;
    degreesLongitude?: number | null;
  } | null;
  pollCreationMessage?: { name?: string | null } | null;
  pollCreationMessageV2?: { name?: string | null } | null;
  pollCreationMessageV3?: { name?: string | null } | null;
  protocolMessage?: WaProtocolMessage | null;
  reactionMessage?: unknown;
  // Wrappers around the actual content.
  ephemeralMessage?: { message?: WaMessageContent | null } | null;
  viewOnceMessage?: { message?: WaMessageContent | null } | null;
  viewOnceMessageV2?: { message?: WaMessageContent | null } | null;
  viewOnceMessageV2Extension?: { message?: WaMessageContent | null } | null;
  documentWithCaptionMessage?: { message?: WaMessageContent | null } | null;
  editedMessage?: { message?: WaMessageContent | null } | null;
  deviceSentMessage?: { message?: WaMessageContent | null } | null;
}

export interface WaMessage {
  key: WaMessageKey;
  message?: WaMessageContent | null;
  /** Seconds since the epoch. */
  messageTimestamp?: WaNumber;
  pushName?: string | null;
  /** Set on notices (joins, "this message was deleted"); such a row carries no content. */
  messageStubType?: number | null;
  /** 4 = READ, 5 = PLAYED: for the user's own messages, the other side has seen them. */
  status?: number | null;
}

/** `Chat` (`proto.IConversation` plus Baileys' fields), as history sync and chat events carry it. */
export interface WaChat {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  /** Absolute in a history sync; 0 in an update means "read on another device", -1 "marked unread". */
  unreadCount?: number | null;
  pnJid?: string | null;
  lidJid?: string | null;
}

export interface WaContact {
  id: string;
  lid?: string;
  phoneNumber?: string;
  /** The name the user saved in their address book. */
  name?: string;
  /** The name the contact set for themselves. */
  notify?: string;
  verifiedName?: string;
}

export interface WaGroup {
  id?: string;
  subject?: string;
  participants?: Array<{ id: string; lid?: string | null; phoneNumber?: string | null }>;
}

export interface WaLidMapping {
  lid: string;
  pn: string;
}

export interface WaConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  lastDisconnect?: { error?: unknown; date?: Date };
  qr?: string;
  receivedPendingNotifications?: boolean;
  isNewLogin?: boolean;
}

/** The events postbote listens to — a subset of Baileys' `BaileysEventMap`. */
export interface WaEventMap {
  'connection.update': WaConnectionUpdate;
  'creds.update': { accountSyncCounter?: number } & Record<string, unknown>;
  'messaging-history.set': {
    chats: WaChat[];
    contacts: WaContact[];
    messages: WaMessage[];
    lidPnMappings?: WaLidMapping[];
    isLatest?: boolean;
    progress?: number | null;
    syncType?: number | null;
  };
  'messaging-history.status': { syncType: number; status: 'complete' | 'paused'; explicit: boolean };
  'messages.upsert': { messages: WaMessage[]; type: 'notify' | 'append' };
  'messages.update': Array<{ key: WaMessageKey; update: { status?: number | null } }>;
  'messages.delete': { keys: WaMessageKey[] } | { jid: string; all: true };
  'message-receipt.update': Array<{
    key: WaMessageKey;
    receipt: { readTimestamp?: WaNumber; playedTimestamp?: WaNumber };
  }>;
  'chats.upsert': WaChat[];
  'chats.update': WaChat[];
  'chats.delete': string[];
  'contacts.upsert': WaContact[];
  'contacts.update': Array<Partial<WaContact>>;
  'groups.upsert': WaGroup[];
  'groups.update': Array<Partial<WaGroup>>;
  'lid-mapping.update': WaLidMapping;
}

export type WaEventName = keyof WaEventMap;

export interface WaEventEmitter {
  on<E extends WaEventName>(event: E, listener: (data: WaEventMap[E]) => void): void;
  off<E extends WaEventName>(event: E, listener: (data: WaEventMap[E]) => void): void;
}

/**
 * One socket: its events, the pairing-code request, and ending it. What a `SocketFactory`
 * returns. No send method is part of this shape, so nothing in postbote can call one.
 */
export interface WaSocketHandle {
  readonly ev: WaEventEmitter;
  /** Ask for an 8-character code to type on the phone instead of scanning a QR code. */
  requestPairingCode(phoneNumber: string): Promise<string>;
  /**
   * Close the connection: first emit every event Baileys still buffers, then close, then emit
   * `connection.update` `close`. Never logs the device out.
   */
  end(): void;
}

/** Baileys' status code for "this device was logged out" (DisconnectReason.loggedOut). */
export const LOGGED_OUT = 401;
/** Baileys' status code for "reconnect now" — sent once right after pairing (restartRequired). */
export const RESTART_REQUIRED = 515;

/** The HTTP-style status of a disconnect error (a Boom), or null. */
export function disconnectStatus(update: WaConnectionUpdate): number | null {
  const error = update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined;
  const code = error?.output?.statusCode;
  return typeof code === 'number' ? code : null;
}

/** A disconnect reason fit for a message: the status and the error's own text, never data. */
export function disconnectReason(update: WaConnectionUpdate): string {
  const code = disconnectStatus(update);
  const error = update.lastDisconnect?.error;
  const text = error instanceof Error ? error.message : null;
  return [code !== null ? `status ${code}` : null, text].filter(Boolean).join(': ') || 'connection closed';
}

export function toNumber(value: WaNumber): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(n) ? n : null;
}
