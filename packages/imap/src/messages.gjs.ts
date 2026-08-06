/**
 * Mail search and single-message fetch over IMAP (GJS-only).
 *
 * Privacy, enforced structurally: `searchMail` returns header/metadata summaries only — never
 * message bodies. Bodies and attachment metadata (never attachment bytes) come solely from
 * `getMessage`, the explicit single-message fetch.
 */

import {
  errorMessage,
  extractBodySection,
  GnomeError,
  hasFlag,
  type GetMessageOptions,
  type ImapValue,
  type MailMessageDTO,
  type MailSummaryDTO,
  type MailTarget,
  parseEnvelope,
  type ParsedEnvelope,
  parseFetchAttributes,
  type ParsedFetch,
  parseMimeMessage,
  type SearchMailOptions,
  tokenizeImapList,
} from '@postbote/protocol';
import { listMailTargets } from '@postbote/gnome';
import { ImapClient, type ImapResponse } from './client.gjs.ts';

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_BODY_CHARS = 50_000;

/** Iterate the untagged `* n FETCH (...)` lines of a response. */
function* fetchItems(response: ImapResponse): Generator<ImapValue[]> {
  for (const line of response.lines) {
    if (!/^\*\s+\d+\s+FETCH\s+\(/i.test(line)) continue;
    yield tokenizeImapList(line, response.literals);
  }
}

/** Build the shared summary fields from already-parsed FETCH attributes + envelope. */
function summaryFields(
  fetch: ParsedFetch,
  env: ParsedEnvelope,
  folder: string,
  accountId: string,
  fallbackUid = '',
): MailSummaryDTO {
  return {
    uid: fetch.uid ?? fallbackUid,
    folder,
    accountId,
    subject: env.subject,
    from: env.from,
    to: env.to,
    date: env.date,
    seen: hasFlag(fetch.flags, '\\Seen'),
    flagged: hasFlag(fetch.flags, '\\Flagged'),
    size: fetch.size,
  };
}

function toSummary(items: ImapValue[], folder: string, accountId: string): MailSummaryDTO {
  const fetch = parseFetchAttributes(items);
  return summaryFields(fetch, parseEnvelope(fetch.envelope), folder, accountId);
}

async function connectAndLogin(target: MailTarget): Promise<ImapClient> {
  const password = target.getPassword();
  const client = new ImapClient();
  await client.connect(target);
  await client.login(target.user, password);
  return client;
}

/**
 * Search messages across mail accounts (or one), newest first. Returns header/metadata
 * summaries only — never message bodies.
 */
export async function searchMail(options: SearchMailOptions): Promise<MailSummaryDTO[]> {
  const targets = await listMailTargets(options.accountId);
  if (targets.length === 0) {
    throw new GnomeError(
      options.accountId
        ? `no mail-capable GOA account with id ${options.accountId}`
        : 'no mail-capable GOA account configured (add an "Email" account in GNOME Settings → Online Accounts)',
    );
  }
  const folder = options.folder ?? 'INBOX';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const summaries: MailSummaryDTO[] = [];
  let connected = 0;
  let lastError: unknown = null;

  for (const target of targets) {
    if (summaries.length >= limit) break;
    let client: ImapClient;
    try {
      client = await connectAndLogin(target);
      connected++;
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      await client.select(folder);
      const uids = (await client.searchUids(options))
        .sort((a, b) => b - a)
        .slice(0, limit - summaries.length);
      if (uids.length > 0) {
        const response = await client.fetchSummaries(uids);
        if (!response.ok) throw new GnomeError('IMAP FETCH failed');
        for (const items of fetchItems(response)) summaries.push(toSummary(items, folder, target.accountId));
      }
    } catch (err) {
      lastError = err;
    } finally {
      await client.logout();
    }
  }

  // Only a total failure is an error: one unreachable account must not hide the others' results.
  if (connected === 0 && lastError) {
    throw lastError instanceof GnomeError ? lastError : new GnomeError(errorMessage(lastError));
  }
  summaries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return summaries.slice(0, limit);
}

/**
 * Fetch one message in full: summary + cc + plain-text body (truncated to maxBodyChars) +
 * attachment metadata. Attachment bytes are never returned.
 */
export async function getMessage(options: GetMessageOptions): Promise<MailMessageDTO> {
  if (!options.accountId) throw new GnomeError('getMessage requires an accountId');
  const targets = await listMailTargets(options.accountId);
  if (targets.length === 0) throw new GnomeError(`no mail-capable GOA account with id ${options.accountId}`);
  const target = targets[0];
  const folder = options.folder ?? 'INBOX';
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  const client = await connectAndLogin(target);
  try {
    await client.select(folder);
    const response = await client.fetchFull(options.uid);
    if (!response.ok) throw new GnomeError(`IMAP FETCH of uid ${options.uid} failed`);
    const [items] = [...fetchItems(response)];
    if (!items) throw new GnomeError(`message uid ${options.uid} not found in ${folder}`);

    const fetch = parseFetchAttributes(items);
    const env = parseEnvelope(fetch.envelope);
    const mime = parseMimeMessage(extractBodySection(items));

    let bodyText = mime.bodyText;
    let bodyTruncated = false;
    if (bodyText && bodyText.length > maxBodyChars) {
      bodyText = bodyText.slice(0, maxBodyChars);
      bodyTruncated = true;
    }

    return {
      ...summaryFields(fetch, env, folder, target.accountId, options.uid),
      cc: env.cc,
      messageId: env.messageId,
      bodyText,
      bodyTruncated,
      attachments: mime.attachments,
    };
  } finally {
    await client.logout();
  }
}
