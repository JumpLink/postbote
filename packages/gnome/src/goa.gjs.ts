/**
 * GNOME Online Accounts enumeration (GJS-only).
 *
 * Uses the native `Goa` typelib to list configured accounts and which data
 * domains each exposes. Returns plain DTOs — no GObject instances, no secrets
 * (OAuth tokens / passwords are fetched lazily by the future mail layer, never
 * here).
 */

import type Gio from 'gi://Gio?version=2.0';
import Goa from 'gi://Goa?version=1.0';

import { GNOME_CLIENT_NAME, GOA_UNAVAILABLE_MESSAGE, NO_ACCOUNTS_MESSAGE } from '@postbote/protocol';
import { errorMessage, GnomeError } from '@postbote/protocol';
import type { GnomeAccount, GnomeCheckResult } from '@postbote/protocol';

let clientPromise: Promise<Goa.Client> | null = null;

/**
 * Promise wrapper around the async GOA client constructor. The @girs types only
 * expose the callback form for the static `new`, so we bridge it by hand rather
 * than relying on Gio._promisify of a static method.
 */
function newGoaClient(cancellable: Gio.Cancellable | null): Promise<Goa.Client> {
  return new Promise((resolve, reject) => {
    Goa.Client.new(cancellable, (_source, res) => {
      try {
        resolve(Goa.Client.new_finish(res));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Lazily create and cache the GOA client (one live D-Bus connection per process). */
export async function getClient(): Promise<Goa.Client> {
  if (!clientPromise) {
    const p = newGoaClient(null);
    // Drop the cache on failure so a later call can retry.
    p.catch(() => {
      if (clientPromise === p) clientPromise = null;
    });
    clientPromise = p;
  }
  return clientPromise;
}

/** Map one Goa.Object → plain DTO. Returns null for objects without an account. */
function mapAccount(obj: Goa.Object): GnomeAccount | null {
  const account = obj.get_account();
  if (!account) return null;
  return {
    id: account.id ?? '',
    provider: account.provider_type ?? '',
    providerName: account.provider_name ?? '',
    identity: account.identity ?? '',
    presentation: account.presentation_identity ?? '',
    capabilities: {
      mail: !!obj.get_mail() && !account.mail_disabled,
      calendar: !!obj.get_calendar() && !account.calendar_disabled,
      contacts: !!obj.get_contacts() && !account.contacts_disabled,
      files: !!obj.get_files() && !account.files_disabled,
    },
    auth: {
      oauth2: !!obj.get_oauth2_based(),
      password: !!obj.get_password_based(),
    },
  };
}

/** List all configured GNOME Online Accounts as plain DTOs. */
export async function listAccounts(): Promise<GnomeAccount[]> {
  let client: Goa.Client;
  try {
    client = await getClient();
  } catch (err) {
    throw new GnomeError(`Goa.Client.new: ${errorMessage(err)}`);
  }
  const accounts: GnomeAccount[] = [];
  for (const obj of client.get_accounts()) {
    const dto = mapAccount(obj);
    if (dto) accounts.push(dto);
  }
  return accounts;
}

/**
 * Connectivity probe. Reports three states without leaking PII:
 *   - GOA/EDS unreachable → ok:false
 *   - 0 accounts          → ok:true (hint to add one)
 *   - N accounts          → ok:true (count + provider types only)
 */
export async function check(): Promise<GnomeCheckResult> {
  let objs: Goa.Object[];
  try {
    const client = await getClient();
    objs = client.get_accounts();
  } catch (err) {
    return { name: GNOME_CLIENT_NAME, ok: false, message: errorMessage(err) || GOA_UNAVAILABLE_MESSAGE };
  }
  if (objs.length === 0) {
    return { name: GNOME_CLIENT_NAME, ok: true, message: NO_ACCOUNTS_MESSAGE };
  }
  const counts = new Map<string, number>();
  for (const obj of objs) {
    const account = obj.get_account();
    const provider = account?.provider_type ?? 'unknown';
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([p, n]) => (n > 1 ? `${p}×${n}` : p)).join(', ');
  return { name: GNOME_CLIENT_NAME, ok: true, message: `OK (${objs.length} account(s): ${summary})` };
}
