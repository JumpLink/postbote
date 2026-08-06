/**
 * The "unavailable" implementation of the IMAP surface.
 *
 * The transport is Gio sockets and the credentials come from GOA — both GJS-only. On Node the
 * surface throws so callers surface a clear message instead of an empty result that reads as
 * "no mail found".
 */

import {
  GJS_REQUIRED_MESSAGE,
  GnomeUnavailableError,
  type GetMessageOptions,
  type MailMessageDTO,
  type MailSummaryDTO,
  type SearchMailOptions,
} from '@postbote/protocol';

export async function searchMail(_options: SearchMailOptions): Promise<MailSummaryDTO[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function getMessage(_options: GetMessageOptions): Promise<MailMessageDTO> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}
