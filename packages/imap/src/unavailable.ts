/**
 * The "unavailable" implementation of the IMAP surface.
 *
 * The transport is Gio sockets and the credentials come from GOA — both GJS-only. On Node the
 * surface throws so callers surface a clear message instead of an empty result that reads as
 * "no mail found".
 *
 * Every signature here must match the GJS entry EXACTLY. TypeScript resolves the `node`
 * condition when checking the app, so a loosened parameter or return type here is what the
 * whole app is checked against — a stub returning `Promise<never>` silently turned every
 * downstream property access into an error about `never`.
 */

import {
  type FetchPartInfo,
  type FetchPartOptions,
  type FolderDTO,
  type GetMessageOptions,
  GJS_REQUIRED_MESSAGE,
  GnomeUnavailableError,
  type ListPartsOptions,
  type LiteralSink,
  type MailMessageDTO,
  type MailPartDTO,
  type MailSummaryDTO,
  type SearchMailOptions,
} from '@postbote/protocol';

export async function searchMail(_options: SearchMailOptions): Promise<MailSummaryDTO[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function getMessage(_options: GetMessageOptions): Promise<MailMessageDTO> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function listFolders(_accountId?: string): Promise<FolderDTO[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function listParts(_options: ListPartsOptions): Promise<MailPartDTO[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function fetchPart(
  _options: FetchPartOptions,
  _makeSink: (info: FetchPartInfo) => LiteralSink | Promise<LiteralSink>,
): Promise<{ info: FetchPartInfo; bytes: number }> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}
