/**
 * Account actions — GNOME Online Accounts enumeration, the availability probe, and the accounts
 * of backends that keep their own (chat networks).
 *
 * The action layer is where scoping, limits and redaction live: the packages return full DTOs,
 * the actions decide what a caller sees. Both frontends (CLI, MCP) go through here, so a cap
 * added once applies to both.
 */

import { check, listAccounts } from '@postbote/gnome';
import type { AccountPrompter, BackendAccount, GnomeAccount, GnomeCheckResult } from '@postbote/protocol';
import { configPath } from '@postbote/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig } from '../config.ts';

/** List configured GNOME Online Accounts and their capabilities. No credentials. */
export async function accountsList(): Promise<GnomeAccount[]> {
  return listAccounts();
}

/** Probe GOA/EDS availability (the same three-state shape `postbote check` reports). */
export async function accountsCheck(): Promise<GnomeCheckResult> {
  return check();
}

/** The accounts one ENABLED backend knows. No credentials, no session data. */
export async function backendAccountsList(
  name: string,
  path = configPath(),
): Promise<{ backend: string; accounts: BackendAccount[] }> {
  const config = loadConfig(path);
  const backend = builtinRegistry().create(config, name, backendContext(name, config));
  return { backend: name, accounts: await backend.listAccounts() };
}

/**
 * Add an account to an ENABLED backend, interactively. Only backends that keep their own accounts
 * can: mail accounts are GNOME Online Accounts and are added in GNOME Settings.
 */
export async function accountsAdd(
  name: string,
  prompter: AccountPrompter,
  path = configPath(),
): Promise<{ backend: string; account: BackendAccount }> {
  const config = loadConfig(path);
  const backend = builtinRegistry().create(config, name, backendContext(name, config));
  if (!backend.addAccount) {
    throw new Error(
      `${name} accounts are not added in postbote — ${
        backend.kind === 'mailbox'
          ? 'add them in GNOME Settings → Online Accounts'
          : 'this backend has no login flow'
      }`,
    );
  }
  return { backend: name, account: await backend.addAccount(prompter) };
}
