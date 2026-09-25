/**
 * Conversations, participants and their messages — derived from the mail index, read by the CLI
 * and MCP.
 *
 * `rebuildMailConversations` runs after a sync and rewrites the mail part of these tables in
 * one transaction. A full rebuild rather than an incremental update, on purpose: threading is a
 * union over the whole mailbox (a late reply can join two threads that were apart), and the
 * classification of one message depends on the rest of its thread (did the user reply?). An
 * incremental version would have to redo exactly that, with more ways to drift.
 *
 * The reads apply the user's per-sender overrides at query time. They come from the config, not
 * the index, so correcting a sender never writes here — only `postbote sync` does.
 */

import type {
  Classification,
  ClassificationReason,
  ContactDTO,
  Conversation,
  ConversationMessage,
  MailAddress,
  Participant,
  ParticipantAddress,
} from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import { classifyMail, conversationVerdict, type MessageVerdict, type SenderOverrides } from './classify.ts';
import type { IndexDatabase } from './db.ts';
import { withTransaction } from './db.ts';
import { messageBody } from './index-store.ts';
import { buildThreads, normalizeSubject, stableId, type ThreadMember } from './threads.ts';

const MAIL_BACKEND = 'mail';

export interface RebuildOptions {
  /** The address book, for `known-contact` and to link participants to their EDS contact. */
  contacts?: readonly ContactDTO[];
  /** The user's own addresses, beyond the account identities the index already knows. */
  selfAddresses?: readonly string[];
}

export interface RebuildResult {
  conversations: number;
  messages: number;
  participants: number;
}

interface MailRow extends ThreadMember {
  folderPath: string;
  uid: number;
  subject: string | null;
  sender: string;
  seen: boolean;
  hasAttachment: boolean;
  from: MailAddress[];
  recipients: MailAddress[];
  listId: string | null;
  listUnsubscribe: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseAddresses(json: unknown): MailAddress[] {
  if (typeof json !== 'string' || !json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((a): a is MailAddress => typeof (a as MailAddress)?.email === 'string')
      : [];
  } catch {
    // upsertMessage writes this with JSON.stringify, so a parse failure means a damaged row.
    // One damaged row must not abort the rebuild of every conversation: it gets no participants.
    return [];
  }
}

function loadMailRows(db: IndexDatabase): MailRow[] {
  const rows = db
    .prepare(
      `SELECT account_id, folder_path, uid, message_id, subject, sender, date, internal_date, seen,
              has_attachment, in_reply_to, thread_refs, from_json, to_json, list_id,
              list_unsubscribe, auto_submitted, precedence
         FROM messages ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: `${String(r.folder_path)}/${String(r.uid)}`,
    accountId: String(r.account_id),
    folderPath: String(r.folder_path),
    uid: Number(r.uid),
    messageId: str(r.message_id),
    inReplyTo: str(r.in_reply_to),
    references: (str(r.thread_refs) ?? '').split(' ').filter(Boolean),
    sentAt: str(r.date) ?? str(r.internal_date),
    subject: str(r.subject),
    sender: String(r.sender ?? ''),
    seen: Number(r.seen) === 1,
    hasAttachment: Number(r.has_attachment) === 1,
    from: parseAddresses(r.from_json),
    recipients: parseAddresses(r.to_json),
    listId: str(r.list_id),
    listUnsubscribe: str(r.list_unsubscribe),
    autoSubmitted: str(r.auto_submitted),
    precedence: str(r.precedence),
  }));
}

/** Participants keyed by address, merged through the address book. */
class ParticipantDirectory {
  readonly byAddress = new Map<string, { id: string; name: string | null; contactUid: string | null }>();
  readonly addresses = new Map<string, ParticipantAddress[]>();

  constructor(contacts: readonly ContactDTO[]) {
    // A contact owns ALL its addresses up front, so mail from any of them lands on one person —
    // and the phone numbers are already there for the chat backends that identify by them.
    for (const contact of contacts) {
      const id = stableId('p-', 'contact', contact.uid);
      const owned: ParticipantAddress[] = [];
      const claim = (kind: ParticipantAddress['kind'], raw: string) => {
        const value = normalizeAddress(kind, raw);
        const key = value ? `${kind}:${value}` : null;
        if (!value || !key || this.byAddress.has(key)) return;
        this.byAddress.set(key, { id, name: contact.name || null, contactUid: contact.uid });
        owned.push({ kind, value });
      };
      for (const email of contact.emails) claim('email', email);
      for (const phone of contact.phones) claim('phone', phone);
      if (owned.length > 0) this.addresses.set(id, owned);
    }
  }

  isKnown(email: string): boolean {
    return this.byAddress.get(`email:${email}`)?.contactUid != null;
  }

  /** The participant for a mail address, created on first sight. */
  resolve(address: MailAddress): { id: string; name: string | null; email: string } | null {
    const email = normalizeAddress('email', address.email);
    if (!email) return null;
    const key = `email:${email}`;
    let entry = this.byAddress.get(key);
    if (!entry) {
      entry = { id: stableId('p-', 'email', email), name: address.name, contactUid: null };
      this.byAddress.set(key, entry);
      this.addresses.set(entry.id, [{ kind: 'email', value: email }]);
    } else if (!entry.name && address.name) {
      entry.name = address.name;
    }
    return { id: entry.id, name: entry.name, email };
  }

  participants(): Array<{ id: string; name: string | null; contactUid: string | null }> {
    const seen = new Map<string, { id: string; name: string | null; contactUid: string | null }>();
    for (const entry of this.byAddress.values()) if (!seen.has(entry.id)) seen.set(entry.id, entry);
    return [...seen.values()];
  }
}

function selfAddressSet(db: IndexDatabase, extra: readonly string[]): Set<string> {
  const rows = db.prepare('SELECT identity FROM accounts').all() as Array<{ identity?: string | null }>;
  const self = new Set<string>();
  for (const raw of [...rows.map((r) => r.identity ?? ''), ...extra]) {
    const email = normalizeAddress('email', raw);
    if (email) self.add(email);
  }
  return self;
}

/**
 * Rewrite the mail conversations, their messages and the participant directory from the index.
 * Idempotent: running it twice yields the same rows and the same ids.
 */
export function rebuildMailConversations(db: IndexDatabase, options: RebuildOptions = {}): RebuildResult {
  const rows = loadMailRows(db);
  const self = selfAddressSet(db, options.selfAddresses ?? []);
  const directory = new ParticipantDirectory(options.contacts ?? []);
  const threads = buildThreads(rows);

  // Every row is computed first and written afterwards in multi-row INSERTs. One statement per
  // row made this 5 000 executions for a 5 000-message mailbox, and on gjsify's libgda-backed
  // `node:sqlite` each execution costs three round trips plus objects that the GC frees late.
  const messageRows: SqlValue[][] = [];
  const conversationRows: SqlValue[][] = [];
  const memberRows: SqlValue[][] = [];

  for (const thread of threads) {
    const conversationId = stableId('c-', MAIL_BACKEND, thread.accountId, thread.rootKey);
    const senderEmail = (row: MailRow) => normalizeAddress('email', row.from[0]?.email ?? '');
    const repliedInThread = thread.members.some((row) => {
      const email = senderEmail(row);
      return email !== null && self.has(email);
    });

    const others = new Set<string>();
    const verdicts: MessageVerdict[] = [];
    let unread = 0;
    let attachments = false;

    for (const row of thread.members) {
      const email = senderEmail(row);
      const fromSelf = email !== null && self.has(email);
      const sender = row.from[0] ? directory.resolve(row.from[0]) : null;
      for (const address of [...row.from, ...row.recipients]) {
        const participant = directory.resolve(address);
        if (participant && !self.has(participant.email)) others.add(participant.id);
      }
      const verdict = classifyMail({
        fromSelf,
        senderAddress: email,
        automation: {
          listId: row.listId,
          listUnsubscribe: row.listUnsubscribe,
          autoSubmitted: row.autoSubmitted,
          precedence: row.precedence,
        },
        knownContact: email !== null && directory.isKnown(email),
        repliedInThread,
      });
      verdicts.push({
        fromSelf,
        senderAddress: email,
        classification: verdict.classification,
        reason: verdict.reason,
      });
      if (!fromSelf && !row.seen) unread++;
      if (row.hasAttachment) attachments = true;

      messageRows.push([
        stableId('m-', conversationId, row.messageId ?? row.key),
        conversationId,
        MAIL_BACKEND,
        row.accountId,
        // Mail stays mail in presentation (ADR 0001 §1): a card with subject and attachments.
        'document',
        fromSelf ? null : (sender?.id ?? null),
        sender?.name ?? (row.from[0] ? null : row.sender || null),
        email ? 'email' : null,
        email,
        fromSelf ? 1 : 0,
        row.sentAt,
        row.subject,
        row.seen ? 1 : 0,
        row.hasAttachment ? 1 : 0,
        verdict.classification,
        verdict.reason,
        row.folderPath,
        row.uid,
      ]);
    }

    const summary = conversationVerdict(verdicts);
    const first = thread.members[0];
    const last = thread.members[thread.members.length - 1];
    conversationRows.push([
      conversationId,
      MAIL_BACKEND,
      thread.accountId,
      others.size > 1 ? 'group' : 'direct',
      normalizeSubject(thread.members.find((m) => m.subject)?.subject ?? null),
      summary.classification,
      summary.reason,
      first.sentAt,
      last.sentAt,
      thread.members.length,
      unread,
      attachments ? 1 : 0,
    ]);
    for (const participantId of others) memberRows.push([conversationId, participantId]);
  }

  const participants = directory.participants();
  const participantRows = participants.map((p): SqlValue[] => [p.id, p.name, p.contactUid]);
  const addressRows = participants.flatMap((p) =>
    (directory.addresses.get(p.id) ?? []).map((a): SqlValue[] => [p.id, a.kind, a.value]),
  );

  withTransaction(db, () => {
    db.prepare('DELETE FROM conversation_messages WHERE backend = ?').run(MAIL_BACKEND);
    db.prepare(
      'DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE backend = ?)',
    ).run(MAIL_BACKEND);
    db.prepare('DELETE FROM conversations WHERE backend = ?').run(MAIL_BACKEND);
    // The directory is rebuilt whole. Mail is its only writer today; when a chat backend adds
    // participants of its own, this becomes a merge instead of a rewrite.
    db.exec('DELETE FROM participant_addresses');
    db.exec('DELETE FROM participants');

    insertMany(
      db,
      `INSERT OR REPLACE INTO conversation_messages
         (id, conversation_id, backend, account_id, presentation, sender_participant_id, sender_name,
          sender_kind, sender_address, from_self, sent_at, subject, seen, has_attachments,
          classification, classification_reason, folder_path, uid)`,
      messageRows,
    );
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversations
         (id, backend, account_id, kind, title, classification, classification_reason,
          first_message_at, last_message_at, message_count, unread_count, has_attachments)`,
      conversationRows,
    );
    insertMany(
      db,
      'INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id)',
      memberRows,
    );
    insertMany(db, 'INSERT INTO participants (id, display_name, contact_uid)', participantRows);
    insertMany(db, 'INSERT OR IGNORE INTO participant_addresses (participant_id, kind, value)', addressRows);
  });

  return { conversations: threads.length, messages: messageRows.length, participants: participants.length };
}

type SqlValue = string | number | null;

/**
 * Bound values per multi-row INSERT. Measured, not guessed: gjsify's libgda binding costs
 * roughly the square of the parameter count per statement, while each execution has a fixed
 * cost of its own. Rebuilding 3 000 messages on GJS took 23 s one row per statement, 9.4 s at
 * 20 values, 3.7 s at 60, 4.9 s at 150 and 10.3 s at 400.
 */
const PARAM_BUDGET = 60;

/** `head VALUES (?, …), (?, …), …` in chunks. Every row must have the same width. */
function insertMany(db: IndexDatabase, head: string, rows: readonly SqlValue[][]): void {
  if (rows.length === 0) return;
  const perChunk = Math.max(1, Math.floor(PARAM_BUDGET / rows[0].length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const tuple = `(${placeholders(chunk[0].length)})`;
    db.prepare(`${head} VALUES ${chunk.map(() => tuple).join(', ')}`).run(...chunk.flat());
  }
}

// ── reads ──────────────────────────────────────────────────────────────

export interface ConversationQuery {
  /** Only conversations with a person in them (ADR 0001: `--people-only`). */
  peopleOnly?: boolean;
  accountId?: string;
  backend?: string;
  limit?: number;
  /** Per-sender corrections, keyed by normalized address. */
  overrides?: SenderOverrides;
}

const DEFAULT_LIST_LIMIT = 50;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * The SQL twin of `conversationVerdict`: a conversation is conversational when no one else
 * wrote in it, or when some message from someone else is conversational after overrides.
 * Kept next to that function's contract; the tests pin that both agree.
 */
function peopleOnlyClause(overrides: SenderOverrides): { sql: string; params: string[] } {
  const forced = Object.entries(overrides);
  const toConversational = forced.filter(([, c]) => c === 'conversational').map(([a]) => a);
  const toAutomated = forced.filter(([, c]) => c === 'automated').map(([a]) => a);

  const messageConditions: string[] = [];
  const params: string[] = [];
  if (toConversational.length > 0) {
    messageConditions.push(`sender_address IN (${placeholders(toConversational.length)})`);
    params.push(...toConversational);
  }
  if (toAutomated.length > 0) {
    // NULL-safe: `NULL NOT IN (…)` is NULL, which would silently drop every sender-less row.
    messageConditions.push(
      `(classification = 'conversational' AND (sender_address IS NULL OR sender_address NOT IN (${placeholders(toAutomated.length)})))`,
    );
    params.push(...toAutomated);
  } else {
    messageConditions.push(`classification = 'conversational'`);
  }

  return {
    sql:
      `(id IN (SELECT conversation_id FROM conversation_messages WHERE from_self = 0 AND (${messageConditions.join(' OR ')}))` +
      ` OR id NOT IN (SELECT conversation_id FROM conversation_messages WHERE from_self = 0))`,
    params,
  };
}

function loadParticipants(db: IndexDatabase, conversationIds: string[]): Map<string, Participant[]> {
  const result = new Map<string, Participant[]>();
  if (conversationIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT cp.conversation_id, p.id, p.display_name, p.contact_uid
         FROM conversation_participants cp JOIN participants p ON p.id = cp.participant_id
        WHERE cp.conversation_id IN (${placeholders(conversationIds.length)})
        ORDER BY p.display_name, p.id`,
    )
    .all(...conversationIds) as Array<Record<string, unknown>>;
  const participantIds = [...new Set(rows.map((r) => String(r.id)))];
  const addresses = new Map<string, ParticipantAddress[]>();
  if (participantIds.length > 0) {
    const addressRows = db
      .prepare(
        `SELECT participant_id, kind, value FROM participant_addresses
          WHERE participant_id IN (${placeholders(participantIds.length)}) ORDER BY kind, value`,
      )
      .all(...participantIds) as Array<Record<string, unknown>>;
    for (const a of addressRows) {
      const list = addresses.get(String(a.participant_id)) ?? [];
      list.push({ kind: String(a.kind) as ParticipantAddress['kind'], value: String(a.value) });
      addresses.set(String(a.participant_id), list);
    }
  }
  for (const r of rows) {
    const id = String(r.id);
    const list = result.get(String(r.conversation_id)) ?? [];
    list.push({
      id,
      displayName: str(r.display_name),
      contactUid: str(r.contact_uid),
      addresses: addresses.get(id) ?? [],
    });
    result.set(String(r.conversation_id), list);
  }
  return result;
}

function loadVerdicts(db: IndexDatabase, conversationIds: string[]): Map<string, MessageVerdict[]> {
  const result = new Map<string, MessageVerdict[]>();
  if (conversationIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT conversation_id, from_self, sender_address, classification, classification_reason
         FROM conversation_messages WHERE conversation_id IN (${placeholders(conversationIds.length)})`,
    )
    .all(...conversationIds) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const list = result.get(String(r.conversation_id)) ?? [];
    list.push({
      fromSelf: Number(r.from_self) === 1,
      senderAddress: str(r.sender_address),
      classification: String(r.classification) as Classification,
      reason: String(r.classification_reason) as ClassificationReason,
    });
    result.set(String(r.conversation_id), list);
  }
  return result;
}

function rowToConversation(
  r: Record<string, unknown>,
  participants: Participant[],
  verdict: { classification: Classification; reason: ClassificationReason },
): Conversation {
  return {
    id: String(r.id),
    backend: String(r.backend),
    accountId: String(r.account_id),
    kind: String(r.kind) === 'group' ? 'group' : 'direct',
    title: str(r.title),
    participants,
    classification: verdict.classification,
    classificationReason: verdict.reason,
    firstMessageAt: str(r.first_message_at),
    lastMessageAt: str(r.last_message_at),
    messageCount: Number(r.message_count),
    unreadCount: Number(r.unread_count),
    hasAttachments: Number(r.has_attachments) === 1,
  };
}

const CONVERSATION_COLUMNS = `id, backend, account_id, kind, title, first_message_at, last_message_at,
  message_count, unread_count, has_attachments`;

function hydrate(
  db: IndexDatabase,
  rows: Array<Record<string, unknown>>,
  overrides: SenderOverrides,
): Conversation[] {
  const ids = rows.map((r) => String(r.id));
  const participants = loadParticipants(db, ids);
  const verdicts = loadVerdicts(db, ids);
  return rows.map((r) =>
    rowToConversation(
      r,
      participants.get(String(r.id)) ?? [],
      conversationVerdict(verdicts.get(String(r.id)) ?? [], overrides),
    ),
  );
}

/** Conversations, newest first. */
export function listConversations(db: IndexDatabase, query: ConversationQuery = {}): Conversation[] {
  const overrides = query.overrides ?? {};
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.accountId) {
    where.push('account_id = ?');
    params.push(query.accountId);
  }
  if (query.backend) {
    where.push('backend = ?');
    params.push(query.backend);
  }
  if (query.peopleOnly) {
    const clause = peopleOnlyClause(overrides);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  const rows = db
    .prepare(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY last_message_at DESC, id LIMIT ?`,
    )
    .all(...params, query.limit ?? DEFAULT_LIST_LIMIT) as Array<Record<string, unknown>>;
  return hydrate(db, rows, overrides);
}

export interface ConversationDetailOptions {
  /** Include each message's plain-text body. Off by default: bodies are other people's words. */
  includeBodies?: boolean;
  /** Per-message body cap when bodies are included. */
  maxBodyChars?: number;
  overrides?: SenderOverrides;
}

/** One conversation with its messages, oldest first. Null when the id is unknown. */
export function getConversation(
  db: IndexDatabase,
  id: string,
  options: ConversationDetailOptions = {},
): { conversation: Conversation; messages: ConversationMessage[] } | null {
  const overrides = options.overrides ?? {};
  const row = db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const [conversation] = hydrate(db, [row], overrides);

  const rows = db
    .prepare(
      `SELECT id, conversation_id, backend, account_id, presentation, sender_participant_id, sender_name,
              sender_kind, sender_address, from_self, sent_at, subject, seen, has_attachments,
              classification, classification_reason, folder_path, uid, remote_id
         FROM conversation_messages WHERE conversation_id = ? ORDER BY sent_at, id`,
    )
    .all(id) as Array<Record<string, unknown>>;

  const messages = rows.map((r): ConversationMessage => {
    const senderAddress = str(r.sender_address);
    const forced = senderAddress && Number(r.from_self) !== 1 ? overrides[senderAddress] : undefined;
    const folder = str(r.folder_path);
    const uid = r.uid === null || r.uid === undefined ? undefined : Number(r.uid);
    const message: ConversationMessage = {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      backend: String(r.backend),
      presentation: String(r.presentation) === 'bubble' ? 'bubble' : 'document',
      senderId: str(r.sender_participant_id),
      senderName: str(r.sender_name),
      senderAddress:
        senderAddress && r.sender_kind
          ? { kind: String(r.sender_kind) as ParticipantAddress['kind'], value: senderAddress }
          : null,
      fromSelf: Number(r.from_self) === 1,
      sentAt: str(r.sent_at),
      subject: str(r.subject),
      seen: Number(r.seen) === 1,
      hasAttachments: Number(r.has_attachments) === 1,
      classification: forced ?? (String(r.classification) as Classification),
      classificationReason: forced ? 'override' : (String(r.classification_reason) as ClassificationReason),
      ref: {
        accountId: String(r.account_id),
        ...(folder ? { folder } : {}),
        ...(uid !== undefined ? { uid } : {}),
        ...(r.remote_id ? { remoteId: String(r.remote_id) } : {}),
      },
    };
    if (options.includeBodies) {
      const body = folder && uid !== undefined ? messageBody(db, message.ref.accountId, folder, uid) : null;
      const cap = options.maxBodyChars;
      message.bodyText = body !== null && cap !== undefined && body.length > cap ? body.slice(0, cap) : body;
      message.bodyTruncated = body !== null && cap !== undefined && body.length > cap;
    }
    return message;
  });

  return { conversation, messages };
}
