/**
 * `postbote search` / `postbote message` — the two mail commands.
 *
 * They are separate commands rather than one with a `--body` flag on purpose: `search` cannot
 * return a body no matter what it is passed, so a broad query can never dump message contents.
 * Reading one message is a deliberate second call naming its uid.
 */

import type { CommandModule } from 'yargs';

import { BODY_CHARS, MAIL_LIMIT, mailGetMessage, mailSearch } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const searchCommand: CommandModule = {
  command: 'search [query]',
  describe: 'Search mail headers via IMAP (newest first; no message bodies)',
  builder: (yargs) =>
    yargs
      .positional('query', {
        type: 'string',
        describe: 'Free-text IMAP search (TEXT); omit for the most recent messages',
      })
      .option('folder', { type: 'string', describe: 'Mailbox to search (default INBOX)' })
      .option('unseen', { type: 'boolean', describe: 'Only unseen messages' })
      .option('since', { type: 'string', describe: 'Only messages since YYYY-MM-DD' })
      .option('limit', {
        type: 'number',
        describe: `Max messages (default ${MAIL_LIMIT.default}, max ${MAIL_LIMIT.max})`,
      })
      .option('account', {
        type: 'string',
        describe: 'Restrict to a GOA account id (from "accounts"); omit to search all',
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      mailSearch({
        query: pickArgv<string>(raw, 'query'),
        folder: pickArgv<string>(raw, 'folder'),
        unseenOnly: pickArgv<boolean>(raw, 'unseen'),
        since: pickArgv<string>(raw, 'since'),
        limit: pickArgv<number>(raw, 'limit'),
        accountId: pickArgv<string>(raw, 'account'),
      }),
    );
  },
};

export const messageCommand: CommandModule = {
  command: 'message <uid>',
  describe: 'Fetch one full message (body + attachment metadata) by IMAP UID',
  builder: (yargs) =>
    yargs
      .positional('uid', { type: 'string', describe: 'IMAP UID (from "search")' })
      .option('account', {
        type: 'string',
        demandOption: true,
        describe: 'GOA account id the message belongs to (from "accounts")',
      })
      .option('folder', { type: 'string', describe: 'Mailbox the UID belongs to (default INBOX)' })
      .option('max-body', {
        type: 'number',
        describe: `Max body characters (default ${BODY_CHARS.default}, max ${BODY_CHARS.max})`,
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      mailGetMessage({
        uid: pickArgv<string>(raw, 'uid') ?? '',
        accountId: pickArgv<string>(raw, 'account') ?? '',
        folder: pickArgv<string>(raw, 'folder'),
        // yargs exposes a kebab-case option under both spellings; ask for both so a rename
        // of either upstream convention cannot silently drop the cap back to its default.
        maxBodyChars: pickArgv<number>(raw, 'max-body', 'maxBody'),
      }),
    );
  },
};
