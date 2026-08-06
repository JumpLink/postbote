/**
 * Contact actions — Evolution Data Server address books (CardDAV/local).
 */

import { searchContacts } from '@postbote/gnome';
import type { ContactDTO, SearchContactsOptions } from '@postbote/protocol';
import { capLimit, CONTACT_LIMIT } from './limits.ts';

/** Search contacts; caps the result count so a caller can't dump a whole address book. */
export async function contactsSearch(options: SearchContactsOptions = {}): Promise<ContactDTO[]> {
  return searchContacts({ ...options, limit: capLimit(options.limit, CONTACT_LIMIT) });
}
