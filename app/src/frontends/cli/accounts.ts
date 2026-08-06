/**
 * `postbote accounts` — list the configured GNOME Online Accounts.
 *
 * The account ids printed here are the join key for every other command: `--account`.
 */

import type { CommandModule } from 'yargs';

import { accountsList } from '../../core/actions/index.ts';
import { runAndExit } from './output.ts';

export const accountsCommand: CommandModule = {
  command: 'accounts',
  describe: 'List configured GNOME Online Accounts and their capabilities',
  handler: () => {
    runAndExit(() => accountsList());
  },
};
