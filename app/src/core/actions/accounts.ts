/**
 * Account actions — GNOME Online Accounts enumeration and the availability probe.
 *
 * The action layer is where scoping, limits and redaction live: the packages return full DTOs,
 * the actions decide what a caller sees. Both frontends (CLI, MCP) go through here, so a cap
 * added once applies to both.
 */

import { check, listAccounts } from '@postbote/gnome';
import type { GnomeAccount, GnomeCheckResult } from '@postbote/protocol';

/** List configured GNOME Online Accounts and their capabilities. No credentials. */
export async function accountsList(): Promise<GnomeAccount[]> {
  return listAccounts();
}

/** Probe GOA/EDS availability (the same three-state shape `postbote check` reports). */
export async function accountsCheck(): Promise<GnomeCheckResult> {
  return check();
}
