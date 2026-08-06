/**
 * The "unavailable" implementation of the GOA/EDS surface.
 *
 * Used by the Node entry — GOA/EDS are GObject-Introspection libraries that exist only under
 * GJS, so on Node the whole surface degrades: `check()` reports gracefully and data functions
 * throw `GnomeUnavailableError` so callers (CLI/MCP) can surface a clear message instead of
 * returning empty results that look like "nothing found".
 */

import {
  GJS_REQUIRED_MESSAGE,
  GNOME_CLIENT_NAME,
  GnomeUnavailableError,
  type CalendarEventDTO,
  type ContactDTO,
  type GnomeAccount,
  type GnomeCheckResult,
  type ListEventsOptions,
  type MailTarget,
  type SearchContactsOptions,
} from '@postbote/protocol';

export async function check(): Promise<GnomeCheckResult> {
  return { name: GNOME_CLIENT_NAME, ok: false, message: GJS_REQUIRED_MESSAGE };
}

export async function listAccounts(): Promise<GnomeAccount[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function searchContacts(_options: SearchContactsOptions): Promise<ContactDTO[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function listEvents(_options: ListEventsOptions): Promise<CalendarEventDTO[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}

export async function listMailTargets(_accountId?: string): Promise<MailTarget[]> {
  throw new GnomeUnavailableError(GJS_REQUIRED_MESSAGE);
}
