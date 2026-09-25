/**
 * `postbote backends` — which message backends exist and which are enabled.
 *
 * Enabling one with a terms notice is refused until the notice has been seen and accepted with
 * `--accept-terms`: the notice is printed and the command exits non-zero, config unchanged.
 */

import type { CommandModule } from 'yargs';

import { backendsDisable, backendsEnable, backendsList } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const backendsCommand: CommandModule = {
  command: 'backends',
  describe: 'List, enable or disable message backends (writes the config, never the index)',
  handler: () => {},
  builder: (yargs) =>
    yargs
      .demandCommand(1, 'Choose a subcommand: list, enable, disable')
      .command({
        command: 'list',
        describe: 'Every backend with its sync model, capabilities and whether it is enabled',
        handler: () => {
          runAndExit(() => Promise.resolve(backendsList()));
        },
      })
      .command({
        command: 'enable <name>',
        describe: 'Enable a backend; the first enable shows its terms notice',
        builder: (y) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('accept-terms', { type: 'boolean', describe: 'Accept the backend terms notice' }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(async () => {
            const result = backendsEnable(String(raw.name), {
              acceptTerms: pickArgv<boolean>(raw, 'accept-terms', 'acceptTerms'),
            });
            if (result.outcome === 'terms-required' && result.terms) {
              throw new Error(
                [
                  `${result.name} has terms you have not accepted yet:`,
                  '',
                  result.terms.summary,
                  ...(result.terms.url ? ['', result.terms.url] : []),
                  '',
                  `Nothing was changed. To accept and enable: postbote backends enable ${result.name} --accept-terms`,
                ].join('\n'),
              );
            }
            return result;
          });
        },
      })
      .command({
        command: 'disable <name>',
        describe: 'Disable a backend (its accepted terms stay recorded)',
        builder: (y) => y.positional('name', { type: 'string', demandOption: true }),
        handler: (argv) => {
          runAndExit(() => Promise.resolve(backendsDisable(String((argv as Record<string, unknown>).name))));
        },
      }),
};
