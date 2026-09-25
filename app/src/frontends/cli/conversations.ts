/**
 * `postbote conversations` — the per-person view: mail threads and chats grouped into
 * conversations, with `--people-only` hiding newsletters, notifications and other machine mail.
 *
 * Offline: reads what `postbote sync` built. `classify` corrects a sender in the config file.
 */

import type { CommandModule } from 'yargs';

import {
  CONVERSATION_BODY_CHARS,
  CONVERSATION_LIMIT,
  conversationsClassify,
  conversationsList,
  conversationsShow,
} from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

const CLASSIFY_CHOICES = ['conversational', 'automated', 'auto'] as const;

export const conversationsCommand: CommandModule = {
  command: 'conversations',
  describe: 'Conversations across mail threads and chats, from the local index (built by `postbote sync`)',
  handler: () => {},
  builder: (yargs) =>
    yargs
      .demandCommand(1, 'Choose a subcommand: list, show, classify')
      .command({
        command: 'list',
        describe: 'Conversations, newest first',
        builder: (y) =>
          y
            .option('people-only', {
              type: 'boolean',
              describe: 'Only conversations with a person in them — no newsletters or notifications',
            })
            .option('account', { type: 'string', describe: 'Restrict to one account id' })
            .option('limit', {
              type: 'number',
              describe: `Max conversations (max ${CONVERSATION_LIMIT.max})`,
            }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              conversationsList({
                peopleOnly: pickArgv<boolean>(raw, 'people-only', 'peopleOnly'),
                accountId: pickArgv<string>(raw, 'account'),
                limit: pickArgv<number>(raw, 'limit'),
              }),
            ),
          );
        },
      })
      .command({
        command: 'show <id>',
        describe: 'One conversation with its messages (bodies only with --bodies)',
        builder: (y) =>
          y
            .positional('id', { type: 'string', demandOption: true, describe: 'Conversation id from `list`' })
            .option('bodies', { type: 'boolean', describe: 'Include each message body from the index' })
            .option('max-body-chars', {
              type: 'number',
              describe: `Per-message body cap (default ${CONVERSATION_BODY_CHARS.default}, max ${CONVERSATION_BODY_CHARS.max})`,
            }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              conversationsShow({
                id: String(raw.id),
                includeBodies: pickArgv<boolean>(raw, 'bodies'),
                maxBodyChars: pickArgv<number>(raw, 'max-body-chars', 'maxBodyChars'),
              }),
            ),
          );
        },
      })
      .command({
        command: 'classify <address> <as>',
        describe: 'Correct how mail from one sender is classified (auto = back to the rules)',
        builder: (y) =>
          y
            .positional('address', { type: 'string', demandOption: true, describe: 'Sender mail address' })
            .positional('as', { choices: CLASSIFY_CHOICES, demandOption: true }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              conversationsClassify(String(raw.address), raw.as as (typeof CLASSIFY_CHOICES)[number]),
            ),
          );
        },
      }),
};
