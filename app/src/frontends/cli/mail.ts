/**
 * The mail commands: `search`, `message`, `folders`, `parts`, `save`.
 *
 * `search` and `message` are separate commands rather than one with a `--body` flag on purpose:
 * the search path contains no code that can fetch a body, so a broad query can never dump
 * message contents. Reading one message is a deliberate second call naming its uid — and saving
 * its attachment a third.
 */

import type { CommandModule } from 'yargs';

import {
  ATTACHMENT_BYTES,
  BODY_CHARS,
  MAIL_LIMIT,
  mailGetMessage,
  mailListFolders,
  mailListParts,
  mailSaveAttachment,
  mailSearch,
} from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const searchCommand: CommandModule = {
  command: 'search [query]',
  describe: 'Search mail via IMAP (newest first; headers only, never message bodies)',
  builder: (yargs) =>
    yargs
      .positional('query', {
        type: 'string',
        describe: 'Free text across headers and body (IMAP TEXT); omit to list the most recent',
      })
      .option('from', { type: 'string', describe: 'Sender contains' })
      .option('to', { type: 'string', describe: 'Recipient contains' })
      .option('cc', { type: 'string', describe: 'Cc contains' })
      .option('subject', { type: 'string', describe: 'Subject contains' })
      .option('body', { type: 'string', describe: 'Body contains (excludes headers)' })
      .option('since', { type: 'string', describe: 'Date header on/after YYYY-MM-DD' })
      .option('before', { type: 'string', describe: 'Date header before YYYY-MM-DD' })
      .option('received-since', {
        type: 'string',
        describe: 'ARRIVAL on/after YYYY-MM-DD (unreliable after a mailbox migration)',
      })
      .option('received-before', { type: 'string', describe: 'ARRIVAL before YYYY-MM-DD' })
      .option('unseen', { type: 'boolean', describe: 'Only unseen messages' })
      .option('flagged', { type: 'boolean', describe: 'Only flagged messages' })
      .option('folder', { type: 'string', describe: 'Mailbox: name, wire path or role (default INBOX)' })
      .option('all-folders', {
        type: 'boolean',
        describe: 'Search every mailbox (skips All Mail, Trash and Junk)',
      })
      .option('limit', {
        type: 'number',
        describe: `Max messages (default ${MAIL_LIMIT.default}, max ${MAIL_LIMIT.max})`,
      })
      .option('account', {
        type: 'string',
        describe: 'Restrict to a GOA account id (from "accounts"); omit to search all',
      })
      .example('$0 search energieberater --since 2025-01-01', 'free-text, this year')
      .example('$0 search --from berater --all-folders', 'by sender, every mailbox'),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      mailSearch({
        query: pickArgv<string>(raw, 'query'),
        from: pickArgv<string>(raw, 'from'),
        to: pickArgv<string>(raw, 'to'),
        cc: pickArgv<string>(raw, 'cc'),
        subject: pickArgv<string>(raw, 'subject'),
        body: pickArgv<string>(raw, 'body'),
        since: pickArgv<string>(raw, 'since'),
        before: pickArgv<string>(raw, 'before'),
        // yargs exposes a kebab-case option under both spellings; ask for both so a change in
        // either upstream convention cannot silently drop the criterion.
        receivedSince: pickArgv<string>(raw, 'received-since', 'receivedSince'),
        receivedBefore: pickArgv<string>(raw, 'received-before', 'receivedBefore'),
        unseen: pickArgv<boolean>(raw, 'unseen'),
        flagged: pickArgv<boolean>(raw, 'flagged'),
        folder: pickArgv<string>(raw, 'folder'),
        allFolders: pickArgv<boolean>(raw, 'all-folders', 'allFolders'),
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
        maxBodyChars: pickArgv<number>(raw, 'max-body', 'maxBody'),
      }),
    );
  },
};

export const foldersCommand: CommandModule = {
  command: 'folders',
  describe: 'List mailboxes with their resolved roles (inbox, sent, trash, …)',
  builder: (yargs) =>
    yargs.option('account', {
      type: 'string',
      describe: 'Restrict to a GOA account id (from "accounts"); omit for all',
    }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() => mailListFolders(pickArgv<string>(raw, 'account')));
  },
};

export const partsCommand: CommandModule = {
  command: 'parts <uid>',
  describe: "List one message's parts and their sections (what can be saved)",
  builder: (yargs) =>
    yargs
      .positional('uid', { type: 'string', describe: 'IMAP UID (from "search")' })
      .option('account', { type: 'string', demandOption: true, describe: 'GOA account id' })
      .option('folder', { type: 'string', describe: 'Mailbox the UID belongs to (default INBOX)' }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      mailListParts({
        uid: pickArgv<string>(raw, 'uid') ?? '',
        accountId: pickArgv<string>(raw, 'account') ?? '',
        folder: pickArgv<string>(raw, 'folder'),
      }),
    );
  },
};

export const saveCommand: CommandModule = {
  command: 'save <uid>',
  describe: 'Save an attachment to disk (decoded; never overwrites an existing file)',
  builder: (yargs) =>
    yargs
      .positional('uid', { type: 'string', describe: 'IMAP UID (from "search")' })
      .option('account', { type: 'string', demandOption: true, describe: 'GOA account id' })
      .option('folder', { type: 'string', describe: 'Mailbox the UID belongs to (default INBOX)' })
      .option('section', {
        type: 'string',
        describe: 'IMAP section from "parts"; omit for the first attachment',
      })
      .option('out', { type: 'string', describe: 'Directory to save into (default $XDG_DOWNLOAD_DIR)' })
      .option('max-bytes', {
        type: 'number',
        describe: `Refuse a part larger than this (default ${ATTACHMENT_BYTES.default})`,
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      mailSaveAttachment({
        uid: pickArgv<string>(raw, 'uid') ?? '',
        accountId: pickArgv<string>(raw, 'account') ?? '',
        folder: pickArgv<string>(raw, 'folder'),
        section: pickArgv<string>(raw, 'section'),
        directory: pickArgv<string>(raw, 'out'),
        maxBytes: pickArgv<number>(raw, 'max-bytes', 'maxBytes'),
      }),
    );
  },
};
