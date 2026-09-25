/**
 * Telegram's objects → the network-neutral chat driver types of `@postbote/protocol`.
 *
 * Pure: it reads the structural shapes in `api.ts`, so every rule here is tested against
 * synthetic objects on both runtimes.
 */

import type { ChatInfo, ChatMessage, ChatPeer, ParticipantAddress } from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import type { TgDialog, TgMessage, TgPeer } from './api.ts';

/** Media that is a file a person sent. A link preview (`webpage`), a poll or a dice roll is not. */
const FILE_MEDIA = new Set(['photo', 'video', 'audio', 'voice', 'document', 'sticker', 'paid']);

function address(kind: ParticipantAddress['kind'], raw: string | null): ParticipantAddress | null {
  if (!raw) return null;
  const value = normalizeAddress(kind, raw);
  return value ? { kind, value } : null;
}

/**
 * A peer's addresses, the stable one first: the numeric user id never changes, a username can.
 * The phone number is only there when the user shares it with you (or is your contact) —
 * Telegram reports it as bare digits, always international, so it gains its `+` here.
 */
export function peerAddresses(peer: TgPeer): ParticipantAddress[] {
  const found: Array<ParticipantAddress | null> =
    peer.type === 'user'
      ? [
          address('telegram', String(peer.id)),
          address('telegram', peer.username),
          address('phone', peer.phoneNumber ? `+${peer.phoneNumber.replace(/^\+/, '')}` : null),
        ]
      : // A group or channel has no user id to address; a public one has a handle.
        [address('telegram', peer.username)];
  return found.filter((a): a is ParticipantAddress => a !== null);
}

export function toChatPeer(peer: TgPeer): ChatPeer {
  return {
    remoteId: String(peer.id),
    displayName: peer.displayName || null,
    addresses: peerAddresses(peer),
    bot: peer.type === 'user' && peer.isBot,
  };
}

export function chatKind(peer: TgPeer): ChatInfo['kind'] {
  if (peer.type === 'user') return 'direct';
  // A channel is one-way; every other chat type (group, supergroup, gigagroup, forum) is a group.
  return peer.chatType === 'channel' ? 'broadcast' : 'group';
}

export function toChatInfo(dialog: TgDialog): ChatInfo {
  const peer = dialog.peer;
  const direct = peer.type === 'user';
  return {
    remoteId: String(peer.id),
    kind: chatKind(peer),
    // A direct chat has no title of its own; the other person's name is what a list shows.
    title: peer.displayName || null,
    // The "Saved Messages" chat is with yourself: nobody else is in it.
    members: direct && !peer.isSelf ? [toChatPeer(peer)] : [],
    lastSeq: dialog.lastMessage?.id ?? null,
    readInboxSeq: dialog.lastReadIngoing || null,
    readOutboxSeq: dialog.lastReadOutgoing || null,
  };
}

/**
 * The network message id, unique within the account: Telegram's message ids are unique only
 * within a chat for channels and supergroups, so the chat is part of it.
 */
export function remoteMessageId(chatId: number | string, messageId: number): string {
  return `${chatId}/${messageId}`;
}

/** One message, or null for a service notice (joins, pins, title changes). */
export function toChatMessage(message: TgMessage): ChatMessage | null {
  if (message.isService) return null;
  const chatId = message.chat.id;
  const sender = message.sender.type === 'anonymous' ? null : message.sender;
  const reply = message.replyToMessage;
  return {
    remoteId: remoteMessageId(chatId, message.id),
    seq: message.id,
    sentAt: message.date.toISOString(),
    editedAt: message.editDate ? message.editDate.toISOString() : null,
    sender: message.isOutgoing || !sender ? null : toChatPeer(sender),
    fromSelf: message.isOutgoing,
    text: message.text || null,
    hasAttachments: message.media !== null && FILE_MEDIA.has(message.media.type),
    replyToRemoteId: reply?.id ? remoteMessageId(chatId, reply.id) : null,
    threadRemoteId:
      message.isTopicMessage && reply?.threadId ? remoteMessageId(chatId, reply.threadId) : null,
  };
}
