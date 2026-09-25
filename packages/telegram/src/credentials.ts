/**
 * The Telegram API credentials — the user's OWN `api_id` and `api_hash`.
 *
 * Telegram requires every third-party client to use credentials registered to its user at
 * my.telegram.org; postbote ships none and never falls back to someone else's. They come from
 * the environment (`POSTBOTE_TELEGRAM_API_ID`, `POSTBOTE_TELEGRAM_API_HASH`), which wins, or
 * from the config (`backends.telegram.settings.apiId` / `apiHash`, a 0600 file).
 *
 * The hash is never echoed back, not even in an error: an error message ends up in a terminal
 * scrollback or an MCP transcript.
 */

import type { BackendContext } from '@postbote/protocol';

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export const API_ID_ENV = 'POSTBOTE_TELEGRAM_API_ID';
export const API_HASH_ENV = 'POSTBOTE_TELEGRAM_API_HASH';

const WHERE =
  `create them for yourself at https://my.telegram.org ("API development tools"), then set ` +
  `${API_ID_ENV} and ${API_HASH_ENV}, or backends.telegram.settings.apiId and .apiHash in postbote's config`;

export function resolveCredentials(context: Pick<BackendContext, 'settings' | 'env'>): TelegramCredentials {
  const rawId = context.env[API_ID_ENV]?.trim() || context.settings.apiId;
  const rawHash = context.env[API_HASH_ENV]?.trim() || context.settings.apiHash;
  if (rawId === undefined || rawId === '' || rawHash === undefined || rawHash === '') {
    throw new Error(`Telegram needs your own api_id and api_hash — ${WHERE}`);
  }
  const apiId = typeof rawId === 'number' ? rawId : Number(String(rawId));
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error(`the Telegram api_id must be a positive whole number — ${WHERE}`);
  }
  const apiHash = String(rawHash);
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw new Error(`the Telegram api_hash must be 32 hexadecimal characters (value not shown) — ${WHERE}`);
  }
  return { apiId, apiHash: apiHash.toLowerCase() };
}
