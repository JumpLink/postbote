/**
 * Where postbote keeps things.
 *
 * The single promise this file makes: **nothing is ever written inside the repository.** The
 * index holds mail headers AND plain-text bodies, and this repo is public — a stray index file
 * would be a permanent leak, and `.gitignore` is only the second line of defence. Not writing
 * there is the first, and it lives here.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$XDG_DATA_HOME`, or the spec's default. */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.XDG_DATA_HOME?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.local', 'share');
}

/** The per-user data directory. Overridable for tests and for a non-standard setup. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POSTBOTE_DATA_DIR?.trim();
  return explicit || join(xdgDataHome(env), 'postbote');
}

/**
 * Path of the SQLite index.
 *
 * The `.db` suffix is REQUIRED, not conventional: gjsify's `node:sqlite` is a libgda wrapper,
 * and libgda appends `.db` to whatever name it is given. A file called `index.sqlite` therefore
 * lands on disk as `index.sqlite.db`, and the next open creates `index.sqlite.db.db`.
 */
export function indexDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POSTBOTE_DB_PATH?.trim();
  if (explicit) return explicit.endsWith('.db') ? explicit : `${explicit}.db`;
  return join(dataDir(env), 'index.db');
}

/** Where attachments are saved by default. */
export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POSTBOTE_ATTACHMENTS_DIR?.trim();
  if (explicit) return explicit;
  const download = env.XDG_DOWNLOAD_DIR?.trim();
  if (download && download.startsWith('/')) return download;
  return join(dataDir(env), 'attachments');
}

/** `$XDG_CONFIG_HOME`, or the spec's default. A relative value is ignored, as for the data home. */
export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.XDG_CONFIG_HOME?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.config');
}

/**
 * The config file: which backends are enabled, which terms were accepted, and the per-sender
 * classification overrides. User decisions, not derived data — so it lives under the config
 * home, apart from the rebuildable index.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POSTBOTE_CONFIG?.trim();
  return explicit || join(xdgConfigHome(env), 'postbote', 'config.json');
}
