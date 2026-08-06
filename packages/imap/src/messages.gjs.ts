/**
 * Mail operations over IMAP (GJS-only): folders, search, message fetch, parts, attachments.
 *
 * Privacy, enforced structurally: `searchMail` returns header/metadata summaries only — there
 * is no code path here that can attach a body to a search result. Bodies come solely from
 * `getMessage`, and attachment BYTES only from `saveAttachment`, one named part at a time.
 * Every read uses BODY.PEEK, so nothing here can mark a message as seen.
 */

import {
  attachmentParts,
  type BodyPart,
  errorMessage,
  extractBodySection,
  type FetchPartInfo,
  type FetchPartOptions,
  type FolderDTO,
  type FolderInfo,
  type GetMessageOptions,
  GnomeError,
  hasFlag,
  type ImapValue,
  type ListPartsOptions,
  type LiteralSink,
  type MailMessageDTO,
  type MailPartDTO,
  type MailSummaryDTO,
  type MailTarget,
  parseEnvelope,
  type ParsedEnvelope,
  parseFetchAttributes,
  type ParsedFetch,
  parseMimeMessage,
  resolveFolder,
  searchableFolders,
  type SearchMailOptions,
  tokenizeImapList,
  walkBodyStructure,
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

/** Resolve the accounts to work on, with a message that says what to do about it if there are none. */
async function requireTargets(accountId?: string): Promise<MailTarget[]> {
  const targets = await listMailTargets(accountId);
  if (targets.length === 0) {
    throw new GnomeError(
      accountId
        ? `no mail-capable GOA account with id ${accountId}`
        : 'no mail-capable GOA account configured (add an "Email" account in GNOME Settings → Online Accounts)',
    );
  }
  return targets;
}

/**
 * Decide which mailboxes to visit.
 *
 * Only lists folders when it has to: the common case — no `--folder`, no `--all-folders` — uses
 * INBOX directly and saves a LIST round trip per account.
 */
async function pickFolders(client: ImapClient, options: SearchMailOptions): Promise<FolderInfo[]> {
  if (!options.allFolders && !options.folder) {
    return [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: null,
        attributes: [],
        selectable: true,
        role: 'inbox',
        roleSource: 'name',
      },
    ];
  }
  const folders = await client.listFolders();
  if (options.allFolders) return searchableFolders(folders);

  const match = resolveFolder(folders, options.folder ?? '');
  if (!match) {
    // Name the alternatives: the usual cause is a display name where the wire name differs, and
    // a bare "not found" leaves the user with nothing to try.
    const names = folders
      .filter((f) => f.selectable)
      .map((f) => f.name)
      .slice(0, 40);
    throw new GnomeError(`no mailbox matching "${options.folder}". Available: ${names.join(', ')}`);
  }
  if (!match.selectable) throw new GnomeError(`mailbox "${match.name}" holds no messages (\\Noselect)`);
  return [match];
}

/**
 * Search messages across accounts and mailboxes, newest first. Header/metadata only.
 */
export async function searchMail(options: SearchMailOptions): Promise<MailSummaryDTO[]> {
  const targets = await requireTargets(options.accountId);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const summaries: MailSummaryDTO[] = [];
  let connected = 0;
  let lastError: unknown = null;

  for (const target of targets) {
    let client: ImapClient;
    try {
      client = await connectAndLogin(target);
      connected++;
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      for (const folder of await pickFolders(client, options)) {
        // Over-fetch is pointless: stop as soon as the cap is met. Sorting happens at the end
        // across all folders, so the newest still win globally.
        if (summaries.length >= limit * targets.length + limit) break;
        try {
          await client.examine(folder.path);
          const { uids } = await client.search(options);
          if (uids.length === 0) continue;
          const newest = uids.sort((a, b) => b - a).slice(0, limit);
          const response = await client.fetchSummaries(newest);
          if (!response.ok) throw new GnomeError('IMAP FETCH failed');
          for (const items of fetchItems(response)) {
            summaries.push(toSummary(items, folder.path, target.accountId));
          }
        } catch (err) {
          // One unreadable mailbox must not lose the others' hits.
          lastError = err;
        }
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

/** List every mailbox of every (or one) account. */
export async function listFolders(accountId?: string): Promise<FolderDTO[]> {
  const targets = await requireTargets(accountId);
  const out: FolderDTO[] = [];
  let connected = 0;
  let lastError: unknown = null;

  for (const target of targets) {
    let client: ImapClient;
    try {
      client = await connectAndLogin(target);
      connected++;
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      for (const folder of await client.listFolders()) {
        out.push({
          accountId: target.accountId,
          path: folder.path,
          name: folder.name,
          delimiter: folder.delimiter,
          selectable: folder.selectable,
          role: folder.role,
          roleSource: folder.roleSource,
          messages: null,
        });
      }
    } catch (err) {
      lastError = err;
    } finally {
      await client.logout();
    }
  }

  if (connected === 0 && lastError) {
    throw lastError instanceof GnomeError ? lastError : new GnomeError(errorMessage(lastError));
  }
  return out;
}

/** Open one account and resolve the mailbox a UID lives in. Shared by the per-message commands. */
async function openMessageContext(
  accountId: string,
  folderSpec: string | undefined,
): Promise<{ client: ImapClient; target: MailTarget; folderPath: string }> {
  if (!accountId) throw new GnomeError('an accountId is required — it identifies the mail server');
  const [target] = await requireTargets(accountId);
  const client = await connectAndLogin(target);
  try {
    let folderPath = 'INBOX';
    if (folderSpec && folderSpec.toUpperCase() !== 'INBOX') {
      const match = resolveFolder(await client.listFolders(), folderSpec);
      if (!match) throw new GnomeError(`no mailbox matching "${folderSpec}"`);
      folderPath = match.path;
    }
    await client.examine(folderPath);
    return { client, target, folderPath };
  } catch (err) {
    await client.logout();
    throw err;
  }
}

/**
 * Fetch one message in full: summary + cc + plain-text body (truncated to maxBodyChars) +
 * attachment metadata. Attachment bytes are never returned.
 */
export async function getMessage(options: GetMessageOptions): Promise<MailMessageDTO> {
  const { client, target, folderPath } = await openMessageContext(options.accountId, options.folder);
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  try {
    const response = await client.fetchFull(options.uid);
    if (!response.ok) throw new GnomeError(`IMAP FETCH of uid ${options.uid} failed`);
    const [items] = [...fetchItems(response)];
    if (!items) throw new GnomeError(`message uid ${options.uid} not found in ${folderPath}`);

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
      ...summaryFields(fetch, env, folderPath, target.accountId, options.uid),
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

/** Fetch one message's BODYSTRUCTURE and report its parts, each with its fetchable section. */
export async function listParts(options: ListPartsOptions): Promise<MailPartDTO[]> {
  const { client } = await openMessageContext(options.accountId, options.folder);
  try {
    const response = await client.fetchStructure(options.uid);
    if (!response.ok) throw new GnomeError(`IMAP FETCH of uid ${options.uid} failed`);
    const [items] = [...fetchItems(response)];
    if (!items) throw new GnomeError(`message uid ${options.uid} not found`);

    const structure = findBodyStructure(items);
    const parts = walkBodyStructure(structure);
    const attachments = new Set(attachmentParts(parts).map((p) => p.section));
    return parts.filter((p) => !p.multipart).map((p) => toPartDto(p, attachments.has(p.section)));
  } finally {
    await client.logout();
  }
}

function toPartDto(part: BodyPart, attachment: boolean): MailPartDTO {
  return {
    section: part.section,
    mimeType: part.mimeType,
    filename: part.filename,
    disposition: part.disposition,
    size: part.size,
    attachment,
  };
}

/** Pull the BODYSTRUCTURE value out of a tokenized FETCH attribute list. */
function findBodyStructure(items: ImapValue[]): ImapValue {
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = String(items[i]).toUpperCase();
    if (key === 'BODYSTRUCTURE' || key === 'BODY') return items[i + 1];
  }
  return null;
}

/**
 * Stream one part into a sink.
 *
 * The sink is supplied by the caller — a file writer from @postbote/store, or a buffer in tests
 * — so this stays free of any filesystem knowledge and the bytes never become a JS string.
 *
 * `describe` runs first so the caller can derive a filename from real metadata rather than
 * guessing, and so an oversized part is refused before a byte is transferred.
 */
export async function fetchPart(
  options: FetchPartOptions,
  makeSink: (info: FetchPartInfo) => LiteralSink | Promise<LiteralSink>,
): Promise<{ info: FetchPartInfo; bytes: number }> {
  const { client } = await openMessageContext(options.accountId, options.folder);
  try {
    const response = await client.fetchStructure(options.uid);
    if (!response.ok) throw new GnomeError(`IMAP FETCH of uid ${options.uid} failed`);
    const [items] = [...fetchItems(response)];
    if (!items) throw new GnomeError(`message uid ${options.uid} not found`);

    const parts = walkBodyStructure(findBodyStructure(items));
    const chosen = options.section
      ? parts.find((p) => p.section === options.section)
      : attachmentParts(parts)[0];

    if (!chosen) {
      throw new GnomeError(
        options.section
          ? `message uid ${options.uid} has no part ${options.section}`
          : `message uid ${options.uid} has no attachment`,
      );
    }
    if (chosen.multipart) {
      throw new GnomeError(`part ${chosen.section} is a container, not a file — pick one of its parts`);
    }
    if (chosen.size > options.maxBytes) {
      throw new GnomeError(
        `part ${chosen.section} is ${chosen.size} bytes, over the ${options.maxBytes}-byte limit`,
      );
    }

    const info: FetchPartInfo = {
      section: chosen.section,
      mimeType: chosen.mimeType,
      filename: chosen.filename,
      size: chosen.size,
      encoding: chosen.encoding,
    };
    const sink = await makeSink(info);
    const result = await client.fetchSectionTo(options.uid, chosen.section, sink, options.maxBytes);
    return { info, bytes: result.bytes };
  } finally {
    await client.logout();
  }
}
