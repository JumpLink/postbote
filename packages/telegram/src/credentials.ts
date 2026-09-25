/**
 * The Telegram API credentials — the user's OWN `api_id` and `api_hash`.
 *
 * Telegram requires every third-party client to use credentials registered to its user at
 * my.telegram.org; postbote ships none and never falls back to someone else's.
 *
 * Where they live: in the account's SESSION file (`SecretStore`, 0600, backup tier `secret`),
 * asked for once by `postbote accounts add telegram`. The environment
 * (`POSTBOTE_TELEGRAM_API_ID`, `POSTBOTE_TELEGRAM_API_HASH`) overrides them, for a user who keeps
 * them in a password manager. NOT in the config file: that is `state` in a backup, readable
 * wherever the backup goes, and the api_hash is a credential — so a config that carries one is
 * refused rather than silently used.
 *
 * The hash is never echoed back, not even in an error: an error message ends up in a terminal
 * scrollback or an MCP transcript.
 */

import type { BackendContext } from '@postbote/protocol';
import type { SecretStore } from '@postbote/store';

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export const API_ID_ENV = 'POSTBOTE_TELEGRAM_API_ID';
export const API_HASH_ENV = 'POSTBOTE_TELEGRAM_API_HASH';

/** The session file's namespace for the credentials the session was created with. */
export const CREDENTIALS_NAMESPACE = 'postbote.api';

const WHERE = `create them for yourself at https://my.telegram.org ("API development tools")`;

/** Validate one pair. Throws without ever quoting the hash. */
export function parseCredentials(rawId: unknown, rawHash: unknown): TelegramCredentials {
  const apiId = typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim());
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error(`the Telegram api_id must be a positive whole number — ${WHERE}`);
  }
  const apiHash = String(rawHash ?? '').trim();
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw new Error(`the Telegram api_hash must be 32 hexadecimal characters (value not shown) — ${WHERE}`);
  }
  return { apiId, apiHash: apiHash.toLowerCase() };
}

/** Refuse credentials in the config file: it is backed up as plain `state`. */
export function refuseConfigCredentials(settings: BackendContext['settings']): void {
  if ('apiHash' in settings || 'apiId' in settings) {
    throw new Error(
      'the Telegram api_id/api_hash do not belong in the config file (it is backed up in the clear) — ' +
        'remove backends.telegram.settings.apiId/apiHash; `postbote accounts add telegram` keeps them in ' +
        `the account's 0600 session file, or set ${API_ID_ENV} and ${API_HASH_ENV}`,
    );
  }
}

/** The environment's pair, or null when neither variable is set. Half a pair is an error. */
export function credentialsFromEnv(env: BackendContext['env']): TelegramCredentials | null {
  const id = env[API_ID_ENV]?.trim();
  const hash = env[API_HASH_ENV]?.trim();
  if (!id && !hash) return null;
  if (!id || !hash) throw new Error(`set both ${API_ID_ENV} and ${API_HASH_ENV}, or neither`);
  return parseCredentials(id, hash);
}

export function readStoredCredentials(store: SecretStore): TelegramCredentials | null {
  const id = store.get(CREDENTIALS_NAMESPACE, 'apiId');
  const hash = store.get(CREDENTIALS_NAMESPACE, 'apiHash');
  return id && hash ? parseCredentials(id, hash) : null;
}

export function writeStoredCredentials(store: SecretStore, credentials: TelegramCredentials): void {
  store.apply([
    { namespace: CREDENTIALS_NAMESPACE, key: 'apiId', value: String(credentials.apiId) },
    { namespace: CREDENTIALS_NAMESPACE, key: 'apiHash', value: credentials.apiHash },
  ]);
}

/** For an existing session: the environment wins, else what the session was created with. */
export function resolveCredentials(context: BackendContext, store: SecretStore): TelegramCredentials {
  refuseConfigCredentials(context.settings);
  const credentials = credentialsFromEnv(context.env) ?? readStoredCredentials(store);
  if (!credentials) {
    throw new Error(
      `this Telegram session has no api_id/api_hash stored — log in again with \`postbote accounts add telegram\`, or set ${API_ID_ENV} and ${API_HASH_ENV}`,
    );
  }
  return credentials;
}
