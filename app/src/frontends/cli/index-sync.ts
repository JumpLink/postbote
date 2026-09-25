/**
 * `postbote sync` and `postbote index` — building and inspecting the local index.
 *
 * Kept apart from `search` on purpose: only `sync` ever writes to the index, so a search can
 * never surprise anyone with disk growth. One mental model, stated in one place.
 */

import type { CommandModule } from 'yargs';

import { indexSearch, indexStatus, indexSync } from '../../core/actions/index.ts';
import { MAIL_LIMIT, capLimit } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const syncCommand: CommandModule = {
  command: 'sync',
  describe: 'Build or update the local full-text index (the only command that writes to it)',
  builder: (yargs) =>
    yargs
      .option('account', {
        type: 'string',
        describe: 'Restrict to one account id (GOA, or e.g. telegram-…); omit for all',
      })
      .option('folder', {
        type: 'string',
        describe: 'Restrict to one mailbox (skips chat backends); omit for all',
      })
      .option('full-scan', {
        type: 'boolean',
        describe:
          'Mail: force the flag/expunge pass. Chats: re-fetch the newest window, picking up edits and removing what was deleted',
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      indexSync({
        accountId: pickArgv<string>(raw, 'account'),
        folder: pickArgv<string>(raw, 'folder'),
        fullScan: pickArgv<boolean>(raw, 'full-scan', 'fullScan'),
      }),
    );
  },
};

export const indexCommand: CommandModule = {
  command: 'index',
  describe: 'Inspect or query the local index without touching the network',
  handler: () => {},
  builder: (yargs) =>
    yargs
      .demandCommand(1, 'Choose a subcommand: status, search')
      .command({
        command: 'status',
        describe: 'What the index holds, and which folders are stale',
        handler: () => {
          runAndExit(() => Promise.resolve(indexStatus()));
        },
      })
      .command({
        command: 'search [query]',
        describe: 'Search the index only — offline, no server contact',
        builder: (y) =>
          y
            .positional('query', { type: 'string', describe: 'Full text across subject, sender and body' })
            .option('from', { type: 'string', describe: 'Sender contains' })
            .option('subject', { type: 'string', describe: 'Subject contains' })
            .option('since', { type: 'string', describe: 'Date header on/after YYYY-MM-DD' })
            .option('before', { type: 'string', describe: 'Date header before YYYY-MM-DD' })
            .option('unseen', { type: 'boolean', describe: 'Only unseen messages' })
            .option('flagged', { type: 'boolean', describe: 'Only flagged messages' })
            .option('attachments', { type: 'boolean', describe: 'Only messages with an attachment' })
            .option('account', { type: 'string', describe: 'Restrict to a GOA account id' })
            .option('folder', { type: 'string', describe: 'Restrict to one mailbox (wire path)' })
            .option('limit', { type: 'number', describe: `Max messages (max ${MAIL_LIMIT.max})` }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              indexSearch({
                query: pickArgv<string>(raw, 'query'),
                from: pickArgv<string>(raw, 'from'),
                subject: pickArgv<string>(raw, 'subject'),
                since: pickArgv<string>(raw, 'since'),
                before: pickArgv<string>(raw, 'before'),
                unseen: pickArgv<boolean>(raw, 'unseen'),
                flagged: pickArgv<boolean>(raw, 'flagged'),
                hasAttachment: pickArgv<boolean>(raw, 'attachments'),
                accountId: pickArgv<string>(raw, 'account'),
                folderPath: pickArgv<string>(raw, 'folder'),
                limit: capLimit(pickArgv<number>(raw, 'limit'), MAIL_LIMIT),
              }),
            ),
          );
        },
      }),
};
