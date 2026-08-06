/**
 * `postbote check` — report which backends are reachable.
 *
 * Phase 0 reports the runtime only; the GOA/EDS/IMAP probes are wired in as those packages
 * land. The shape is the three-state probe used across the studio's CLIs ({ name, ok, message })
 * so a caller can tell "unavailable here" apart from "broken".
 */

import type { CommandModule } from 'yargs';
import { runtimeName } from '../../core/runtime.ts';
import { runAndExit } from './output.ts';

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export async function runChecks(): Promise<{ checks: CheckResult[] }> {
  const runtime = runtimeName();
  return {
    checks: [
      {
        name: 'runtime',
        ok: runtime === 'gjs',
        message:
          runtime === 'gjs'
            ? 'running on GJS'
            : 'running on Node — the GNOME backends need GJS (gi:// typelibs)',
      },
    ],
  };
}

export const checkCommand: CommandModule = {
  command: 'check',
  describe: 'Check which backends are reachable (runtime, GNOME Online Accounts, IMAP, index)',
  handler: () => {
    runAndExit(runChecks);
  },
};
