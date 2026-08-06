/**
 * Contacts via Evolution Data Server (GJS-only).
 *
 * Reads CardDAV/local address books that EDS exposes (a Nextcloud GOA account
 * yields a CardDAV book here). Returns plain ContactDTOs projected from the
 * vCard attributes — never EContact/GObject instances.
 */

import Gio from 'gi://Gio?version=2.0';
import EBook from 'gi://EBook?version=1.2';
import EBookContacts from 'gi://EBookContacts?version=1.2';
import EDataServer from 'gi://EDataServer?version=1.2';

import { extractList, getRegistry, sourceGoaAccountId } from './eds.gjs.ts';
import { errorMessage, GnomeError } from '@postbote/protocol';
import type { ContactDTO, SearchContactsOptions } from '@postbote/protocol';

const DEFAULT_LIMIT = 50;
/** Seconds BookClient.connect waits for the backend to be connected. */
const CONNECT_WAIT_SECONDS = 15;

// get_contacts has a Promise overload in the types; make the runtime match.
Gio._promisify(EBook.BookClient.prototype, 'get_contacts', 'get_contacts_finish');

/** Promise wrapper around the static async BookClient.connect (callback-only in @girs). */
function connectBook(source: EDataServer.Source): Promise<EBook.BookClient> {
  return new Promise((resolve, reject) => {
    EBook.BookClient.connect(source, CONNECT_WAIT_SECONDS, null, (_src, res) => {
      try {
        resolve(EBook.BookClient.connect_finish(res));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function attrValue(attr: EBookContacts.VCardAttribute): string | null {
  const v = attr.get_value();
  return v && v.length > 0 ? v : null;
}

/** Project an EContact's vCard attributes into a plain DTO. */
function mapContact(contact: EBookContacts.Contact): ContactDTO {
  let name = '';
  let org: string | null = null;
  let uid = '';
  const emails: string[] = [];
  const phones: string[] = [];
  for (const attr of contact.get_attributes()) {
    switch (attr.get_name().toUpperCase()) {
      case 'FN':
        name = attrValue(attr) ?? name;
        break;
      case 'ORG':
        org = attrValue(attr) ?? org;
        break;
      case 'EMAIL': {
        const v = attrValue(attr);
        if (v) emails.push(v);
        break;
      }
      case 'TEL': {
        const v = attrValue(attr);
        if (v) phones.push(v);
        break;
      }
      case 'UID':
        uid = attrValue(attr) ?? uid;
        break;
    }
  }
  return { uid, name, org, emails, phones };
}

/**
 * Search contacts across enabled address books (optionally restricted to one
 * GOA account). Empty query matches all (subject to limit). Address books that
 * fail to open are skipped; if none open, the last error is surfaced.
 */
export async function searchContacts(options: SearchContactsOptions): Promise<ContactDTO[]> {
  const { query, limit = DEFAULT_LIMIT, accountId } = options;
  const reg = getRegistry();

  let sources: EDataServer.Source[];
  try {
    sources = reg.list_enabled(EDataServer.SOURCE_EXTENSION_ADDRESS_BOOK);
  } catch (err) {
    throw new GnomeError(`list address books: ${errorMessage(err)}`);
  }
  if (accountId) {
    sources = sources.filter((s) => sourceGoaAccountId(reg, s) === accountId);
  }

  const sexp = EBookContacts.BookQuery.any_field_contains(query ?? '').to_string();
  const results: ContactDTO[] = [];
  let opened = 0;
  let lastError: unknown = null;

  for (const source of sources) {
    if (results.length >= limit) break;
    let client: EBook.BookClient;
    try {
      client = await connectBook(source);
      opened++;
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      const contacts = extractList<EBookContacts.Contact>(await client.get_contacts(sexp, null));
      for (const contact of contacts) {
        results.push(mapContact(contact));
        if (results.length >= limit) break;
      }
    } catch (err) {
      throw new GnomeError(`get_contacts(${source.get_display_name()}): ${errorMessage(err)}`);
    }
  }

  if (opened === 0 && sources.length > 0 && lastError) {
    throw new GnomeError(`connect address book: ${errorMessage(lastError)}`);
  }
  return results;
}
