/**
 * Baileys' events → the network-neutral `DeliveryEvent`s of `@postbote/protocol`.
 *
 * Pure: it reads the structural shapes in `api.ts` and keeps only a `JidResolver`, so every rule
 * here is tested against synthetic events on both runtimes.
 *
 * What is kept: what a person wrote (text, captions, a poll's question, a shared contact's or
 * place's name), that a file came with it, the reply it answers, edits and deletions, who read
 * what. What is dropped: notices (joins, "this message was deleted" placeholders), reactions,
 * protocol housekeeping, and status updates (`status@broadcast`: other people's stories).
 */

import type { ChatMessage, DeliveryEvent } from '@postbote/protocol';
import type {
  WaChat,
  WaContact,
  WaEventMap,
  WaGroup,
  WaMessage,
  WaMessageContent,
  WaMessageKey,
} from './api.ts';
import { toNumber } from './api.ts';
import { chatKindOf, JidResolver, parseJid, STATUS_BROADCAST } from './jid.ts';

const REVOKE = 0;
const MESSAGE_EDIT = 14;
const STATUS_READ = 4;

/** Peel the wrappers (disappearing, view-once, captioned document, edit, own-device copy) off. */
export function unwrapContent(content: WaMessageContent | null | undefined): WaMessageContent | null {
  let current = content ?? null;
  for (let depth = 0; current && depth < 8; depth++) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message ??
      current.deviceSentMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current;
}

export interface ExtractedContent {
  text: string | null;
  hasAttachments: boolean;
  /** The id of the message this one replies to, within the same chat. */
  replyTo: string | null;
}

const MEDIA = [
  'imageMessage',
  'videoMessage',
  'ptvMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

/** What a person wrote, or null for content that is not a message (a reaction, housekeeping). */
export function extractContent(content: WaMessageContent | null): ExtractedContent | null {
  if (!content) return null;
  let text: string | null = content.conversation ?? content.extendedTextMessage?.text ?? null;
  let replyTo = content.extendedTextMessage?.contextInfo?.stanzaId ?? null;
  let hasAttachments = false;
  for (const kind of MEDIA) {
    const media = content[kind];
    if (!media) continue;
    hasAttachments = true;
    // A document's file name is what a list shows when there is no caption.
    text ??= media.caption ?? (kind === 'documentMessage' ? (media.fileName ?? null) : null);
    replyTo ??= media.contextInfo?.stanzaId ?? null;
  }
  if (content.contactMessage) {
    // A shared contact card (vCard) is a file in all but name.
    hasAttachments = true;
    text ??= content.contactMessage.displayName ?? null;
    replyTo ??= content.contactMessage.contextInfo?.stanzaId ?? null;
  }
  if (content.contactsArrayMessage) {
    hasAttachments = true;
    text ??= content.contactsArrayMessage.displayName ?? null;
  }
  const location = content.locationMessage;
  if (location) {
    const place = [location.name, location.address].filter(Boolean).join(', ');
    const geo =
      typeof location.degreesLatitude === 'number' && typeof location.degreesLongitude === 'number'
        ? `geo:${location.degreesLatitude},${location.degreesLongitude}`
        : null;
    text ??= place || geo;
  }
  const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
  if (poll) text ??= poll.name ?? null;
  if (!text?.trim() && !hasAttachments) return null;
  return { text: text?.trim() ? text : null, hasAttachments, replyTo: replyTo || null };
}

function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * The network message id. WhatsApp's id alone — not prefixed with the chat — so that a chat
 * merged from its phone-number id into its LID keeps its messages' ids; the store keys a row by
 * chat AND id, so two chats cannot collide.
 */
export function remoteMessageId(messageId: string): string {
  return messageId;
}

/** Turns Baileys' events into delivery events, learning JID pairs as it goes. */
export class WhatsAppMapper {
  readonly resolver: JidResolver;

  constructor(resolver: JidResolver = new JidResolver()) {
    this.resolver = resolver;
  }

  /**
   * A `chat-merged` event for every LID ↔ phone pair learned since the last call: the direct
   * chat filed under the number (before the LID was known) joins the one under the LID. The
   * store ignores a merge whose source chat it does not have, so most of these cost nothing.
   */
  takeMerges(): DeliveryEvent[] {
    return this.resolver.takeLearned().map(({ pn, lid }) => ({
      type: 'chat-merged',
      from: `${pn}@s.whatsapp.net`,
      into: `${lid}@lid`,
    }));
  }

  /** The chat a key belongs to, or null for status updates and ids that are no chat. */
  private chatOf(key: WaMessageKey): string | null {
    if (!key.remoteJid || key.remoteJid === STATUS_BROADCAST) return null;
    return this.resolver.chatId(key.remoteJid, key.remoteJidAlt);
  }

  /**
   * One message as the events it amounts to: a `message`, or an `edit` / `delete` when it is a
   * protocol message about another one, or nothing.
   */
  message(raw: WaMessage, seen: boolean): DeliveryEvent[] {
    const key = raw.key;
    const chatId = this.chatOf(key);
    const chatJid = parseJid(key.remoteJid);
    if (!chatId || !chatJid || !key.id) return [];
    const content = unwrapContent(raw.message);
    const protocol = content?.protocolMessage;
    if (protocol) {
      const target = protocol.key?.id;
      if (!target) return [];
      if (protocol.type === REVOKE)
        return [{ type: 'delete', chatRemoteId: chatId, remoteId: remoteMessageId(target) }];
      if (protocol.type === MESSAGE_EDIT) {
        const edited = extractContent(unwrapContent(protocol.editedMessage));
        const ms = toNumber(protocol.timestampMs);
        const at = ms !== null ? new Date(ms).toISOString() : iso(toNumber(raw.messageTimestamp));
        return [
          {
            type: 'edit',
            chatRemoteId: chatId,
            remoteId: remoteMessageId(target),
            text: edited?.text ?? null,
            editedAt: at,
          },
        ];
      }
      return [];
    }
    if (raw.messageStubType) return [];
    const extracted = extractContent(content);
    if (!extracted) return [];

    const kind = chatKindOf(chatJid);
    const fromSelf = key.fromMe === true;
    const sender = fromSelf
      ? null
      : kind === 'direct'
        ? this.resolver.peer(key.remoteJid, key.remoteJidAlt, raw.pushName ?? null)
        : key.participant
          ? this.resolver.peer(key.participant, key.participantAlt, raw.pushName ?? null)
          : null;
    const seconds = toNumber(raw.messageTimestamp);
    const message: ChatMessage = {
      remoteId: remoteMessageId(key.id),
      seq: seconds ?? 0,
      sentAt: iso(seconds),
      editedAt: null,
      sender,
      fromSelf,
      text: extracted.text,
      hasAttachments: extracted.hasAttachments,
      replyToRemoteId: extracted.replyTo ? remoteMessageId(extracted.replyTo) : null,
      threadRemoteId: null,
    };
    const events: DeliveryEvent[] = [
      { type: 'message', chatRemoteId: chatId, chatKind: kind, message, seen: fromSelf || seen },
    ];
    if (fromSelf && (raw.status ?? 0) >= STATUS_READ) {
      events.push({ type: 'peer-read', chatRemoteId: chatId, remoteIds: [message.remoteId] });
    }
    return events;
  }

  /** A chat report. `unreadCount` is honoured only when `absolute` (a history sync). */
  chat(raw: WaChat, absolute: boolean): DeliveryEvent[] {
    this.resolver.learn(raw.pnJid, raw.lidJid);
    this.resolver.learn(raw.id, raw.lidJid ?? raw.pnJid);
    const jid = parseJid(raw.id);
    if (!jid || raw.id === STATUS_BROADCAST) return [];
    const chatId = this.resolver.chatId(raw.id, raw.lidJid ?? raw.pnJid);
    if (!chatId) return [];
    const kind = chatKindOf(jid);
    const title = raw.name?.trim() || raw.displayName?.trim() || null;
    const peer = kind === 'direct' ? this.resolver.peer(raw.id, raw.lidJid ?? raw.pnJid, title) : null;
    const events: DeliveryEvent[] = [
      { type: 'chat', chat: { remoteId: chatId, kind, title, members: peer ? [peer] : null } },
    ];
    const unread = raw.unreadCount;
    // In an update, 0 is "read on another device"; a positive count is an increment Baileys
    // computed itself and -1 "marked as unread" — neither is a read state to copy.
    if (typeof unread === 'number' && unread >= 0 && (absolute || unread === 0)) {
      events.push({ type: 'chat-read', chatRemoteId: chatId, unreadCount: unread });
    }
    return events;
  }

  contact(raw: Partial<WaContact>): DeliveryEvent[] {
    this.resolver.learn(raw.id, raw.lid ?? raw.phoneNumber);
    if (raw.lid && raw.phoneNumber) this.resolver.learn(raw.lid, raw.phoneNumber);
    const name = raw.name?.trim() || raw.notify?.trim() || raw.verifiedName?.trim() || null;
    const peer = this.resolver.peer(raw.id, raw.lid ?? raw.phoneNumber, name);
    return peer ? [{ type: 'peer', peer }] : [];
  }

  group(raw: Partial<WaGroup>): DeliveryEvent[] {
    const jid = parseJid(raw.id);
    if (!jid || !raw.id) return [];
    const members = raw.participants
      ?.map((p) => this.resolver.peer(p.id, p.lid ?? p.phoneNumber ?? null, null))
      .filter((p) => p !== null);
    if (raw.subject === undefined && !members) return [];
    return [
      {
        type: 'chat',
        chat: {
          remoteId: `${jid.user}@${jid.server}`,
          kind: chatKindOf(jid),
          title: raw.subject?.trim() || null,
          members: members ?? null,
        },
      },
    ];
  }

  /** A history-sync chunk: pairs and contacts first, so the messages resolve to one identity. */
  history(set: WaEventMap['messaging-history.set']): DeliveryEvent[] {
    for (const m of set.lidPnMappings ?? []) this.resolver.learn(m.lid, m.pn);
    const events: DeliveryEvent[] = [];
    for (const c of set.contacts) events.push(...this.contact(c));
    const reads: DeliveryEvent[] = [];
    for (const chat of set.chats) {
      for (const e of this.chat(chat, true)) (e.type === 'chat-read' ? reads : events).push(e);
    }
    // History arrives newest first; stored oldest first reads better in a log and changes nothing else.
    for (const m of [...set.messages].reverse()) events.push(...this.message(m, true));
    // The read state last: it counts the messages just written.
    events.push(...reads);
    return events;
  }

  /** Receipts on the user's own messages: the other side read (or played) them. */
  receipts(updates: WaEventMap['messages.update']): DeliveryEvent[] {
    const events: DeliveryEvent[] = [];
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id || (update.status ?? 0) < STATUS_READ) continue;
      const chatId = this.chatOf(key);
      if (chatId)
        events.push({
          type: 'peer-read',
          chatRemoteId: chatId,
          remoteIds: [remoteMessageId(key.id)],
        });
    }
    return events;
  }

  userReceipts(updates: WaEventMap['message-receipt.update']): DeliveryEvent[] {
    const events: DeliveryEvent[] = [];
    for (const { key, receipt } of updates) {
      if (!key.fromMe || !key.id) continue;
      if (toNumber(receipt.readTimestamp) === null && toNumber(receipt.playedTimestamp) === null) continue;
      const chatId = this.chatOf(key);
      if (chatId)
        events.push({
          type: 'peer-read',
          chatRemoteId: chatId,
          remoteIds: [remoteMessageId(key.id)],
        });
    }
    return events;
  }

  /** "Delete for me" on another device, or "clear chat". */
  deletion(data: WaEventMap['messages.delete']): DeliveryEvent[] {
    if ('all' in data) {
      const chatId = this.chatOf({ remoteJid: data.jid });
      return chatId ? [{ type: 'chat-cleared', chatRemoteId: chatId }] : [];
    }
    const events: DeliveryEvent[] = [];
    for (const key of data.keys) {
      const chatId = this.chatOf(key);
      if (chatId && key.id)
        events.push({ type: 'delete', chatRemoteId: chatId, remoteId: remoteMessageId(key.id) });
    }
    return events;
  }

  chatDeletion(ids: string[]): DeliveryEvent[] {
    const events: DeliveryEvent[] = [];
    for (const id of ids) {
      const chatId = this.chatOf({ remoteJid: id });
      if (chatId) events.push({ type: 'chat-deleted', chatRemoteId: chatId });
    }
    return events;
  }
}
