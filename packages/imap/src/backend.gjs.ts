/**
 * The IMAP implementation of the `MailBackend` port (GJS-only).
 *
 * This is the adapter that lets `@postbote/store` run the sync engine without ever importing
 * `gi://`. Everything IMAP-shaped stays on this side of the port; the engine sees only plain
 * data.
 */

import {
  type BackendAccount,
  type BackendFlagState,
  type BackendMessage,
  type BackendSession,
  type FolderInfo,
  type MailBackend,
  type MailTarget,
  decodeBytes,
  extractBodySection,
  hasFlag,
  type ImapValue,
  latin1ToBytes,
  parseEnvelope,
  parseFetchAttributes,
  pickBodyPart,
  quotedPrintableToBytes,
  base64ToBytes,
  attachmentParts,
  extractHeaderFields,
  parseMessageIdList,
  parseThreadHeaders,
  threadHeaderFetchItem,
  tokenizeImapList,
  walkBodyStructure,
} from '@postbote/protocol';
import { listMailTargets } from '@postbote/gnome';
import { ImapClient, type ImapResponse } from './client.gjs.ts';
import { MAIL_MANIFEST } from './manifest.ts';

/**
 * How much body text is indexed per message.
 *
 * Deliberately far above the 50 000-character DISPLAY cap: this is the searchable corpus, and a
 * term that appears only on page four of a long thread is exactly what a search is for.
 */
const MAX_INDEX_BODY_CHARS = 200_000;

function* fetchItems(response: ImapResponse): Generator<ImapValue[]> {
  for (const line of response.lines) {
    if (!/^\*\s+\d+\s+FETCH\s+\(/i.test(line)) continue;
    yield tokenizeImapList(line, response.literals);
  }
}

function formatAddresses(list: Array<{ name: string | null; email: string }>): string {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** Decode one fetched part's bytes according to its transfer encoding. */
function decodePart(raw: string, encoding: string, charset: string | undefined): string {
  const enc = encoding.toLowerCase();
  const bytes =
    enc === 'base64'
      ? base64ToBytes(raw)
      : enc === 'quoted-printable'
        ? quotedPrintableToBytes(raw)
        : latin1ToBytes(raw);
  return decodeBytes(bytes, charset);
}

/** Strip tags when only an HTML part exists, so the index holds words rather than markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

class ImapBackendSession implements BackendSession {
  private readonly client: ImapClient;

  constructor(client: ImapClient) {
    this.client = client;
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.client.listFolders();
  }

  async openFolder(path: string) {
    // EXAMINE, not SELECT: read-only at the protocol level, so no code path here can set \Seen
    // even by accident.
    return this.client.examine(path);
  }

  async fetchNewer(path: string, afterUid: number, batchSize: number): Promise<BackendMessage[]> {
    const start = afterUid + 1;
    const response = await this.client.fetchRange(
      `${start}:*`,
      `(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE ${threadHeaderFetchItem()})`,
    );
    if (!response.ok) return [];

    const messages: BackendMessage[] = [];
    for (const items of fetchItems(response)) {
      if (messages.length >= batchSize) break;
      const fetch = parseFetchAttributes(items);
      const uid = fetch.uid ? Number.parseInt(fetch.uid, 10) : Number.NaN;
      // `<n>:*` yields at least the highest existing UID even when n is past the end, so the
      // caller would otherwise re-index the newest message on every run.
      if (!Number.isInteger(uid) || uid < start) continue;

      const env = parseEnvelope(fetch.envelope);
      const thread = parseThreadHeaders(extractHeaderFields(items));
      const parts = walkBodyStructure(fetch.bodyStructure);
      const bodyPart = pickBodyPart(parts);
      const attachments = attachmentParts(parts).map((p) => ({
        section: p.section,
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.size,
      }));

      let bodyText: string | null = null;
      if (bodyPart) {
        const bodyResponse = await this.client.fetchSection(String(uid), bodyPart.section);
        if (bodyResponse.ok) {
          const [bodyItems] = [...fetchItems(bodyResponse)];
          const raw = bodyItems ? extractBodySection(bodyItems, bodyPart.section) : '';
          const decoded = decodePart(raw, bodyPart.encoding, bodyPart.params.charset);
          const text = bodyPart.mimeType === 'text/html' ? htmlToText(decoded) : decoded;
          bodyText = text.length > MAX_INDEX_BODY_CHARS ? text.slice(0, MAX_INDEX_BODY_CHARS) : text;
        }
      }

      messages.push({
        uid,
        messageId: env.messageId,
        subject: env.subject,
        sender: formatAddresses(env.from),
        recipients: formatAddresses([...env.to, ...env.cc]),
        date: env.date,
        internalDate: fetch.internalDate,
        size: fetch.size,
        seen: hasFlag(fetch.flags, '\\Seen'),
        flagged: hasFlag(fetch.flags, '\\Flagged'),
        hasAttachment: attachments.length > 0,
        attachments,
        bodyText,
        from: env.from,
        to: env.to,
        cc: env.cc,
        // ENVELOPE's In-Reply-To is the fallback for a server that answered the header fetch
        // with nothing; both are the same header.
        inReplyTo: thread.inReplyTo ?? parseMessageIdList(env.inReplyTo)[0] ?? null,
        references: thread.references,
        automation: thread.automation,
      });
    }
    // Ascending, so the engine's cursor advances monotonically.
    messages.sort((a, b) => a.uid - b.uid);
    return messages;
  }

  async listFlags(path: string): Promise<BackendFlagState[]> {
    // Re-open explicitly rather than relying on a prior openFolder still being in effect. The
    // engine does call them in that order today, but a FETCH against whatever mailbox happens
    // to be selected is the kind of implicit coupling that silently indexes the wrong folder.
    await this.client.examine(path);
    const response = await this.client.fetchRange('1:*', '(UID FLAGS)');
    if (!response.ok) return [];
    const states: BackendFlagState[] = [];
    for (const items of fetchItems(response)) {
      const fetch = parseFetchAttributes(items);
      const uid = fetch.uid ? Number.parseInt(fetch.uid, 10) : Number.NaN;
      if (!Number.isInteger(uid)) continue;
      states.push({
        uid,
        seen: hasFlag(fetch.flags, '\\Seen'),
        flagged: hasFlag(fetch.flags, '\\Flagged'),
      });
    }
    return states;
  }

  async close(): Promise<void> {
    await this.client.logout();
  }
}

/** The live IMAP backend, resolving accounts through GNOME Online Accounts. */
export class ImapBackend implements MailBackend {
  readonly manifest = MAIL_MANIFEST;
  readonly kind = 'mailbox' as const;
  private targets: MailTarget[] | null = null;

  private async allTargets(): Promise<MailTarget[]> {
    if (!this.targets) this.targets = await listMailTargets();
    return this.targets;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return (await this.allTargets()).map((t) => ({
      id: t.accountId,
      identity: t.user,
      provider: 'imap_smtp',
    }));
  }

  async connect(accountId: string): Promise<BackendSession> {
    const target = (await this.allTargets()).find((t) => t.accountId === accountId);
    if (!target) throw new Error(`no mail-capable GOA account with id ${accountId}`);
    const client = new ImapClient();
    await client.connect(target);
    await client.login(target.user, target.getPassword());
    return new ImapBackendSession(client);
  }
}
