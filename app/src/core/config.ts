/**
 * The postbote config file — `$XDG_CONFIG_HOME/postbote/config.json`.
 *
 * It holds decisions only the user can make: which backends are enabled, when their terms were
 * accepted, and how a sender is classified when the automatic call was wrong. None of it can be
 * rebuilt from a server, so it is kept apart from the index, which can.
 *
 * Parsing is pure (`parseConfig`) so the shape is tested on both runtimes; reading and writing
 * the file is a thin layer on top.
 */

import type { Classification } from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import { configPath, ensurePrivateDir } from '@postbote/store';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BackendConfig {
  enabled: boolean;
  /** ISO-8601 time the user accepted the backend's terms notice. */
  termsAcceptedAt?: string;
  /**
   * The backend's own settings (e.g. Telegram's api_id/api_hash), handed to it unvalidated:
   * only the backend knows what they mean. Flat scalars only.
   */
  settings?: Record<string, string | number | boolean>;
}

export interface PostboteConfig {
  backends: Record<string, BackendConfig>;
  /** Per-sender classification overrides, keyed by normalized mail address. */
  senders: Record<string, Classification>;
}

/**
 * What an absent config file means. Mail is enabled by THIS default, not by a special case in
 * the registry: the built-in backend goes through the same "enabled in the config" gate as
 * every other, and a user who disables it in the file gets exactly that.
 */
export function defaultConfig(): PostboteConfig {
  return { backends: { mail: { enabled: true } }, senders: {} };
}

/** Parse and validate the file's text. Throws with the offending key named. */
export function parseConfig(text: string): PostboteConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('config must be a JSON object');
  const obj = raw as Record<string, unknown>;

  const backends: Record<string, BackendConfig> = {};
  const rawBackends = obj.backends ?? {};
  if (typeof rawBackends !== 'object' || rawBackends === null || Array.isArray(rawBackends)) {
    throw new Error('config.backends must be an object');
  }
  for (const [name, value] of Object.entries(rawBackends as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.enabled !== 'boolean') {
      throw new Error(`config.backends.${name}.enabled must be true or false`);
    }
    let settings: Record<string, string | number | boolean> | undefined;
    if (entry.settings !== undefined) {
      if (typeof entry.settings !== 'object' || entry.settings === null || Array.isArray(entry.settings)) {
        throw new Error(`config.backends.${name}.settings must be an object`);
      }
      settings = {};
      for (const [key, v] of Object.entries(entry.settings as Record<string, unknown>)) {
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
          throw new Error(`config.backends.${name}.settings.${key} must be a string, number or boolean`);
        }
        settings[key] = v;
      }
    }
    backends[name] = {
      enabled: entry.enabled,
      ...(typeof entry.termsAcceptedAt === 'string' ? { termsAcceptedAt: entry.termsAcceptedAt } : {}),
      ...(settings ? { settings } : {}),
    };
  }

  const senders: Record<string, Classification> = {};
  const rawSenders = obj.senders ?? {};
  if (typeof rawSenders !== 'object' || rawSenders === null || Array.isArray(rawSenders)) {
    throw new Error('config.senders must be an object');
  }
  for (const [address, value] of Object.entries(rawSenders as Record<string, unknown>)) {
    const key = normalizeAddress('email', address);
    if (!key) throw new Error(`config.senders: ${JSON.stringify(address)} is not a mail address`);
    if (value !== 'conversational' && value !== 'automated') {
      throw new Error(`config.senders.${address} must be "conversational" or "automated"`);
    }
    senders[key] = value;
  }

  return { backends, senders };
}

/** Read the config, or the default when there is no file yet. */
export function loadConfig(path = configPath()): PostboteConfig {
  if (!existsSync(path)) return defaultConfig();
  return parseConfig(readFileSync(path, 'utf8'));
}

/**
 * Write the config atomically, mode 0600 in a 0700 directory: the sender overrides are other
 * people's addresses.
 */
export function saveConfig(config: PostboteConfig, path = configPath()): void {
  ensurePrivateDir(dirname(path));
  const part = `${path}.part`;
  writeFileSync(part, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(part, 0o600);
  renameSync(part, path);
}
