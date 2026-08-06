/**
 * `postbote check` — report which backends are reachable.
 *
 * Three-state probe ({ name, ok, message }) so a caller can tell "unavailable here" apart from
 * "broken": on Node the GNOME backends report that GJS is required; on GJS without a session
 * bus they report GOA unreachable; with one they report the account count.
 */

import type { CommandModule } from 'yargs';
import { check as checkGnome } from '@postbote/gnome';
import { runtimeName } from '../../core/runtime.ts';
import { runAndExit } from './output.ts';

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export async function runChecks(): Promise<{ checks: CheckResult[] }> {
  const runtime = runtimeName();
  const checks: CheckResult[] = [
    {
      name: 'runtime',
      ok: runtime === 'gjs',
      message:
        runtime === 'gjs'
          ? 'running on GJS'
          : 'running on Node — the GNOME backends need GJS (gi:// typelibs)',
    },
  ];

  // Never let one probe's failure hide the others: report it as a failed check, not a throw.
  try {
    checks.push(await checkGnome());
  } catch (err) {
    checks.push({
      name: 'GNOME',
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { checks };
}

export const checkCommand: CommandModule = {
  command: 'check',
  describe: 'Check which backends are reachable (runtime, GNOME Online Accounts, IMAP, index)',
  handler: () => {
    runAndExit(runChecks);
  },
};
