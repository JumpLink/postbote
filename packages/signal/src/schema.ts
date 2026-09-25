/**
 * The Signal messages postbote reads, decoded from the wire into plain objects — and encoded back,
 * for the linking request (`DeviceName`) and for tests that build synthetic envelopes.
 *
 * Field numbers are Signal's, from Signal-Desktop `protos/SignalService.proto`,
 * `protos/DeviceMessages.proto` and `protos/DeviceName.proto` (Copyright Signal Messenger, LLC,
 * AGPL-3.0-only). Only the fields a read-only client needs are here; every other field is skipped.
 * Pure: no libsignal, no I/O.
 */

import {
  bigintField,
  boolField,
  bytesField,
  decodeFields,
  type Fields,
  messageField,
  numberField,
  ProtoWriter,
  repeatedMessages,
  repeatedNumbers,
  stringField,
} from './proto.ts';

// ── service ids ─────────────────────────────────────────────────────────

/** 16 bytes → the canonical lower-case UUID string. */
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error(`a UUID has 16 bytes, got ${bytes.length}`);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidToBytes(uuid: string): Uint8Array<ArrayBuffer> {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('not a UUID');
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/**
 * A service id as a string: an ACI is the bare UUID, a PNI `PNI:<uuid>` (Signal's own spelling).
 * The binary form is 16 bytes for an ACI, or a type byte (1 = PNI) and 16 bytes.
 */
export function serviceIdFromBinary(bytes: Uint8Array): string | null {
  if (bytes.length === 16) return uuidFromBytes(bytes);
  if (bytes.length === 17 && bytes[0] === 0) return uuidFromBytes(bytes.subarray(1));
  if (bytes.length === 17 && bytes[0] === 1) return `PNI:${uuidFromBytes(bytes.subarray(1))}`;
  return null;
}

/** Normalise a string service id: lower-case UUID, `PNI:` prefix kept. Null when malformed. */
export function normalizeServiceId(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(PNI:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw.trim());
  if (!m) return null;
  return `${m[1] ? 'PNI:' : ''}${m[2].toLowerCase()}`;
}

/** The binary field wins when present (newer clients send only that), else the string one. */
function serviceId(fields: Fields, stringNo: number, binaryNo: number): string | null {
  const binary = bytesField(fields, binaryNo);
  if (binary && binary.length > 0) return serviceIdFromBinary(binary);
  return normalizeServiceId(stringField(fields, stringNo));
}

export function isAci(serviceId: string | null): serviceId is string {
  return !!serviceId && !serviceId.startsWith('PNI:');
}

// ── Envelope ────────────────────────────────────────────────────────────

export const EnvelopeType = {
  DOUBLE_RATCHET: 1,
  PREKEY_MESSAGE: 3,
  SERVER_DELIVERY_RECEIPT: 5,
  UNIDENTIFIED_SENDER: 6,
  PLAINTEXT_CONTENT: 8,
} as const;

export interface Envelope {
  type: number;
  sourceServiceId: string | null;
  sourceDevice: number | null;
  destinationServiceId: string | null;
  /** The sender's timestamp — the message's identity together with its author. */
  clientTimestamp: number | null;
  content: Uint8Array | null;
  serverGuid: string | null;
  serverTimestamp: number | null;
  story: boolean;
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const f = decodeFields(bytes);
  const guidBinary = bytesField(f, 21);
  return {
    type: numberField(f, 1) ?? 0,
    sourceServiceId: serviceId(f, 11, 19),
    sourceDevice: numberField(f, 7),
    destinationServiceId: serviceId(f, 13, 20),
    clientTimestamp: numberField(f, 5),
    content: bytesField(f, 8),
    serverGuid: guidBinary?.length === 16 ? uuidFromBytes(guidBinary) : stringField(f, 9),
    serverTimestamp: numberField(f, 10),
    story: boolField(f, 16) ?? false,
  };
}

export function encodeEnvelope(e: Partial<Envelope> & { type: number }): Uint8Array<ArrayBuffer> {
  return new ProtoWriter()
    .uint(1, e.type)
    .uint(5, e.clientTimestamp)
    .uint(7, e.sourceDevice)
    .bytes(8, e.content)
    .string(9, e.serverGuid)
    .uint(10, e.serverTimestamp)
    .string(11, e.sourceServiceId)
    .string(13, e.destinationServiceId)
    .bool(16, e.story || null)
    .finish();
}

// ── Content and what it carries ────────────────────────────────────────

export interface AttachmentPointer {
  cdnId: bigint | null;
  cdnKey: string | null;
  cdnNumber: number;
  contentType: string | null;
  key: Uint8Array | null;
  size: number | null;
  digest: Uint8Array | null;
  fileName: string | null;
  caption: string | null;
}

export function decodeAttachmentPointer(f: Fields): AttachmentPointer {
  return {
    cdnId: bigintField(f, 1),
    cdnKey: stringField(f, 15),
    cdnNumber: numberField(f, 14) ?? 0,
    contentType: stringField(f, 2),
    key: bytesField(f, 3),
    size: numberField(f, 4),
    digest: bytesField(f, 6),
    fileName: stringField(f, 7),
    caption: stringField(f, 11),
  };
}

export interface DataMessage {
  body: string | null;
  attachments: AttachmentPointer[];
  /** The group's master key, for a group message. */
  groupMasterKey: Uint8Array | null;
  flags: number;
  /** The sent timestamp the sender put in; the envelope's normally agrees. */
  timestamp: number | null;
  quote: { id: number | null; authorAci: string | null } | null;
  /** Display names of shared contact cards. */
  contacts: string[];
  sticker: boolean;
  reaction: boolean;
  /** A delete-for-everyone of the sender's own earlier message, by its sent timestamp. */
  deleteTarget: number | null;
  /** A group admin's delete: the author and sent timestamp of the removed message. */
  adminDelete: { authorAci: string | null; timestamp: number | null } | null;
  pollQuestion: string | null;
  isViewOnce: boolean;
  /** A reply to a story, a gift badge, a payment, a group call notice: not a written message. */
  special: 'story-reply' | 'gift' | 'payment' | 'group-call' | 'poll-vote' | 'pin' | null;
  profileKey: Uint8Array | null;
}

/** DataMessage.Flags — END_SESSION, EXPIRATION_TIMER_UPDATE, PROFILE_KEY_UPDATE are not messages. */
export const DataMessageFlags = {
  END_SESSION: 1,
  EXPIRATION_TIMER_UPDATE: 2,
  PROFILE_KEY_UPDATE: 4,
} as const;

function contactCardName(f: Fields): string {
  const name = messageField(f, 1);
  if (!name) return stringField(f, 7) ?? '';
  const parts = [stringField(name, 3), stringField(name, 1), stringField(name, 5), stringField(name, 2)];
  return parts.filter(Boolean).join(' ').trim() || stringField(name, 7) || stringField(f, 7) || '';
}

export function decodeDataMessage(f: Fields): DataMessage {
  const group = messageField(f, 15);
  const quote = messageField(f, 8);
  const del = messageField(f, 17);
  const admin = messageField(f, 29);
  const poll = messageField(f, 24);
  let special: DataMessage['special'] = null;
  if (messageField(f, 21)) special = 'story-reply';
  else if (messageField(f, 22)) special = 'gift';
  else if (messageField(f, 20)) special = 'payment';
  else if (messageField(f, 19)) special = 'group-call';
  else if (messageField(f, 26)) special = 'poll-vote';
  else if (messageField(f, 27) || messageField(f, 28) || messageField(f, 25)) special = 'pin';
  const adminAuthor = admin ? bytesField(admin, 1) : null;
  return {
    body: stringField(f, 1),
    attachments: repeatedMessages(f, 2).map(decodeAttachmentPointer),
    groupMasterKey: group ? bytesField(group, 1) : null,
    flags: numberField(f, 4) ?? 0,
    timestamp: numberField(f, 7),
    quote: quote ? { id: numberField(quote, 1), authorAci: serviceId(quote, 5, 8) } : null,
    contacts: repeatedMessages(f, 9).map(contactCardName),
    sticker: messageField(f, 11) !== null,
    reaction: messageField(f, 16) !== null,
    deleteTarget: del ? numberField(del, 1) : null,
    adminDelete: admin
      ? {
          authorAci: adminAuthor?.length ? serviceIdFromBinary(adminAuthor) : null,
          timestamp: numberField(admin, 2),
        }
      : null,
    pollQuestion: poll ? stringField(poll, 1) : null,
    isViewOnce: boolField(f, 14) ?? false,
    special,
    profileKey: bytesField(f, 6),
  };
}

export interface EditMessage {
  targetSentTimestamp: number | null;
  dataMessage: DataMessage | null;
}

function decodeEditMessage(f: Fields): EditMessage {
  const data = messageField(f, 2);
  return { targetSentTimestamp: numberField(f, 1), dataMessage: data ? decodeDataMessage(data) : null };
}

/** A conversation as `DeleteForMe` names it: a person or a group. */
export interface ConversationRef {
  serviceId: string | null;
  groupId: Uint8Array | null;
  e164: string | null;
}

function decodeConversationRef(f: Fields | null): ConversationRef | null {
  if (!f) return null;
  return { serviceId: serviceId(f, 1, 4), groupId: bytesField(f, 2), e164: stringField(f, 3) };
}

export interface AddressableMessage {
  authorServiceId: string | null;
  sentTimestamp: number | null;
}

function decodeAddressable(f: Fields): AddressableMessage {
  return { authorServiceId: serviceId(f, 1, 4), sentTimestamp: numberField(f, 3) };
}

export interface DeleteForMe {
  messageDeletes: Array<{ conversation: ConversationRef | null; messages: AddressableMessage[] }>;
  conversationDeletes: Array<{ conversation: ConversationRef | null; isFullDelete: boolean }>;
  localOnlyConversationDeletes: Array<{ conversation: ConversationRef | null }>;
}

function decodeDeleteForMe(f: Fields): DeleteForMe {
  return {
    messageDeletes: repeatedMessages(f, 1).map((m) => ({
      conversation: decodeConversationRef(messageField(m, 1)),
      messages: repeatedMessages(m, 2).map(decodeAddressable),
    })),
    conversationDeletes: repeatedMessages(f, 2).map((c) => ({
      conversation: decodeConversationRef(messageField(c, 1)),
      isFullDelete: boolField(c, 3) ?? false,
    })),
    localOnlyConversationDeletes: repeatedMessages(f, 3).map((c) => ({
      conversation: decodeConversationRef(messageField(c, 1)),
    })),
  };
}

export interface SentTranscript {
  destinationServiceId: string | null;
  destinationE164: string | null;
  timestamp: number | null;
  message: DataMessage | null;
  editMessage: EditMessage | null;
  story: boolean;
}

export interface SyncMessage {
  sent: SentTranscript | null;
  contacts: { blob: AttachmentPointer | null; complete: boolean } | null;
  read: Array<{ senderAci: string | null; timestamp: number | null }>;
  deleteForMe: DeleteForMe | null;
}

function decodeSyncMessage(f: Fields): SyncMessage {
  const sent = messageField(f, 1);
  const contacts = messageField(f, 2);
  const del = messageField(f, 22);
  const sentData = sent ? messageField(sent, 3) : null;
  const sentEdit = sent ? messageField(sent, 10) : null;
  const blob = contacts ? messageField(contacts, 1) : null;
  return {
    sent: sent
      ? {
          destinationServiceId: serviceId(sent, 7, 12),
          destinationE164: stringField(sent, 1),
          timestamp: numberField(sent, 2),
          message: sentData ? decodeDataMessage(sentData) : null,
          editMessage: sentEdit ? decodeEditMessage(sentEdit) : null,
          story: messageField(sent, 8) !== null,
        }
      : null,
    contacts: contacts
      ? { blob: blob ? decodeAttachmentPointer(blob) : null, complete: boolField(contacts, 2) ?? false }
      : null,
    read: repeatedMessages(f, 5).map((r) => ({
      senderAci: serviceId(r, 3, 4),
      timestamp: numberField(r, 2),
    })),
    deleteForMe: del ? decodeDeleteForMe(del) : null,
  };
}

export const ReceiptType = { DELIVERY: 0, READ: 1, VIEWED: 2 } as const;

export interface Content {
  dataMessage: DataMessage | null;
  syncMessage: SyncMessage | null;
  editMessage: EditMessage | null;
  receipt: { type: number; timestamps: number[] } | null;
  /** A SenderKeyDistributionMessage riding along: it must be processed before group messages. */
  senderKeyDistribution: Uint8Array | null;
  /** Typing, calls, stories, null messages, decryption-error requests: nothing to store. */
  other: boolean;
}

export function decodeContent(bytes: Uint8Array): Content {
  const f = decodeFields(bytes);
  const data = messageField(f, 1);
  const sync = messageField(f, 2);
  const edit = messageField(f, 11);
  const receipt = messageField(f, 5);
  return {
    dataMessage: data ? decodeDataMessage(data) : null,
    syncMessage: sync ? decodeSyncMessage(sync) : null,
    editMessage: edit ? decodeEditMessage(edit) : null,
    receipt: receipt ? { type: numberField(receipt, 1) ?? 0, timestamps: repeatedNumbers(receipt, 2) } : null,
    senderKeyDistribution: bytesField(f, 7),
    other: [3, 4, 6, 8, 9].some((n) => f.has(n)),
  };
}

// ── encoders for tests and synthetic data ───────────────────────────────

export interface DataMessageInput {
  body?: string;
  timestamp?: number;
  groupMasterKey?: Uint8Array;
  quote?: { id: number; authorAci: string };
  deleteTarget?: number;
  attachments?: Array<{ fileName?: string; contentType?: string }>;
  reaction?: boolean;
  flags?: number;
}

export function encodeDataMessage(d: DataMessageInput): ProtoWriter {
  const w = new ProtoWriter().string(1, d.body);
  for (const a of d.attachments ?? []) {
    w.message(2, new ProtoWriter().string(2, a.contentType).string(7, a.fileName));
  }
  w.uint(4, d.flags);
  w.uint(7, d.timestamp);
  if (d.quote) w.message(8, new ProtoWriter().uint(1, d.quote.id).string(5, d.quote.authorAci));
  if (d.groupMasterKey) w.message(15, new ProtoWriter().bytes(1, d.groupMasterKey).uint(2, 1));
  if (d.reaction) w.message(16, new ProtoWriter().string(1, '👍'));
  if (d.deleteTarget !== undefined) w.message(17, new ProtoWriter().uint(1, d.deleteTarget));
  return w;
}

export interface ContentInput {
  dataMessage?: DataMessageInput;
  editMessage?: { targetSentTimestamp: number; dataMessage: DataMessageInput };
  sent?: {
    destinationServiceId?: string;
    timestamp: number;
    message?: DataMessageInput;
    editMessage?: { targetSentTimestamp: number; dataMessage: DataMessageInput };
  };
  contactsBlob?: { cdnKey: string; cdnNumber: number; key: Uint8Array; size: number; digest?: Uint8Array };
  read?: Array<{ senderAci: string; timestamp: number }>;
  deleteForMe?: {
    messages?: Array<{
      conversation: { serviceId?: string; groupId?: Uint8Array };
      authorAci: string;
      timestamp: number;
    }>;
    conversations?: Array<{ serviceId?: string; groupId?: Uint8Array }>;
  };
  receipt?: { type: number; timestamps: number[] };
  senderKeyDistribution?: Uint8Array;
  typing?: boolean;
}

function editWriter(e: { targetSentTimestamp: number; dataMessage: DataMessageInput }): ProtoWriter {
  return new ProtoWriter().uint(1, e.targetSentTimestamp).message(2, encodeDataMessage(e.dataMessage));
}

function conversationWriter(c: { serviceId?: string; groupId?: Uint8Array }): ProtoWriter {
  return new ProtoWriter().string(1, c.serviceId).bytes(2, c.groupId);
}

export function encodeContent(c: ContentInput): Uint8Array<ArrayBuffer> {
  const w = new ProtoWriter();
  if (c.dataMessage) w.message(1, encodeDataMessage(c.dataMessage));
  const sync = new ProtoWriter();
  let hasSync = false;
  if (c.sent) {
    hasSync = true;
    const sent = new ProtoWriter().uint(2, c.sent.timestamp).string(7, c.sent.destinationServiceId);
    if (c.sent.message) sent.message(3, encodeDataMessage(c.sent.message));
    if (c.sent.editMessage) sent.message(10, editWriter(c.sent.editMessage));
    sync.message(1, sent);
  }
  if (c.contactsBlob) {
    hasSync = true;
    const b = c.contactsBlob;
    sync.message(
      2,
      new ProtoWriter()
        .message(
          1,
          new ProtoWriter()
            .string(2, 'application/octet-stream')
            .bytes(3, b.key)
            .uint(4, b.size)
            .bytes(6, b.digest)
            .uint(14, b.cdnNumber)
            .string(15, b.cdnKey),
        )
        .bool(2, true),
    );
  }
  for (const r of c.read ?? []) {
    hasSync = true;
    sync.message(5, new ProtoWriter().uint(2, r.timestamp).string(3, r.senderAci));
  }
  if (c.deleteForMe) {
    hasSync = true;
    const d = new ProtoWriter();
    for (const m of c.deleteForMe.messages ?? []) {
      d.message(
        1,
        new ProtoWriter()
          .message(1, conversationWriter(m.conversation))
          .message(2, new ProtoWriter().string(1, m.authorAci).uint(3, m.timestamp)),
      );
    }
    for (const conv of c.deleteForMe.conversations ?? []) {
      d.message(2, new ProtoWriter().message(1, conversationWriter(conv)).bool(3, true));
    }
    sync.message(22, d);
  }
  if (hasSync) w.message(2, sync);
  if (c.receipt) {
    const r = new ProtoWriter().uint(1, c.receipt.type);
    for (const t of c.receipt.timestamps) r.uint(2, t);
    w.message(5, r);
  }
  if (c.typing) w.message(6, new ProtoWriter().uint(1, Date.now()));
  w.bytes(7, c.senderKeyDistribution);
  if (c.editMessage) w.message(11, editWriter(c.editMessage));
  return w.finish();
}

/** Signal pads every plaintext with 0x80 and zeros; senders pad to 160-byte blocks. */
export function padPlaintext(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = Math.ceil((plaintext.length + 1) / 160) * 160;
  const out = new Uint8Array(size);
  out.set(plaintext);
  out[plaintext.length] = 0x80;
  return out;
}

/** The inverse — ported from Signal-Desktop `MessageReceiver.#unpad`. */
export function unpadPlaintext(padded: Uint8Array): Uint8Array {
  for (let i = padded.length - 1; i >= 0; i--) {
    if (padded[i] === 0x80) return padded.subarray(0, i);
    if (padded[i] !== 0x00) throw new Error('invalid message padding');
  }
  return padded;
}

// ── linking ─────────────────────────────────────────────────────────────

export interface ProvisionEnvelope {
  publicKey: Uint8Array | null;
  body: Uint8Array | null;
}

export function decodeProvisionEnvelope(bytes: Uint8Array): ProvisionEnvelope {
  const f = decodeFields(bytes);
  return { publicKey: bytesField(f, 1), body: bytesField(f, 2) };
}

export function encodeProvisionEnvelope(e: {
  publicKey: Uint8Array;
  body: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  return new ProtoWriter().bytes(1, e.publicKey).bytes(2, e.body).finish();
}

export interface ProvisionMessage {
  aciIdentityKeyPrivate: Uint8Array | null;
  aci: string | null;
  number: string | null;
  provisioningCode: string | null;
  profileKey: Uint8Array | null;
  pni: string | null;
}

export function decodeProvisionMessage(bytes: Uint8Array): ProvisionMessage {
  const f = decodeFields(bytes);
  const aciBinary = bytesField(f, 17);
  const pniBinary = bytesField(f, 18);
  return {
    aciIdentityKeyPrivate: bytesField(f, 2),
    aci: aciBinary?.length === 16 ? uuidFromBytes(aciBinary) : normalizeServiceId(stringField(f, 8)),
    number: stringField(f, 3),
    provisioningCode: stringField(f, 4),
    profileKey: bytesField(f, 6),
    pni: pniBinary?.length === 16 ? `PNI:${uuidFromBytes(pniBinary)}` : null,
  };
}

export function encodeProvisionMessage(m: {
  aciIdentityKeyPublic: Uint8Array;
  aciIdentityKeyPrivate: Uint8Array;
  aci: string;
  provisioningCode: string;
  profileKey?: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  return new ProtoWriter()
    .bytes(1, m.aciIdentityKeyPublic)
    .bytes(2, m.aciIdentityKeyPrivate)
    .string(4, m.provisioningCode)
    .bytes(6, m.profileKey)
    .string(8, m.aci)
    .uint(9, 1)
    .bytes(17, uuidToBytes(m.aci))
    .finish();
}

export function encodeDeviceName(d: {
  ephemeralPublic: Uint8Array;
  syntheticIv: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  return new ProtoWriter()
    .bytes(1, d.ephemeralPublic)
    .bytes(2, d.syntheticIv)
    .bytes(3, d.ciphertext)
    .finish();
}

export function decodeDeviceName(bytes: Uint8Array): {
  ephemeralPublic: Uint8Array | null;
  syntheticIv: Uint8Array | null;
  ciphertext: Uint8Array | null;
} {
  const f = decodeFields(bytes);
  return { ephemeralPublic: bytesField(f, 1), syntheticIv: bytesField(f, 2), ciphertext: bytesField(f, 3) };
}

// ── contact sync ────────────────────────────────────────────────────────

export interface ContactDetails {
  aci: string | null;
  number: string | null;
  name: string | null;
  avatarLength: number;
}

export function decodeContactDetails(bytes: Uint8Array): ContactDetails {
  const f = decodeFields(bytes);
  const avatar = messageField(f, 3);
  return {
    aci: serviceId(f, 9, 13),
    number: stringField(f, 1),
    name: stringField(f, 2),
    avatarLength: avatar ? (numberField(avatar, 2) ?? 0) : 0,
  };
}

export function encodeContactDetails(c: {
  aci: string;
  number?: string;
  name?: string;
}): Uint8Array<ArrayBuffer> {
  return new ProtoWriter().string(1, c.number).string(2, c.name).string(9, c.aci).finish();
}
