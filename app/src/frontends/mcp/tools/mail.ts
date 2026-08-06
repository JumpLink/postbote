/**
 * Mail tools — IMAP folders, search, message fetch, parts and attachment saving.
 *
 * Split by what each can return, not by convenience: `mail_search` is structurally incapable of
 * returning a body, so no query however broad can dump message contents. Reading a message is a
 * second explicit call naming its uid, and getting attachment bytes a third naming its section.
 * IMAP is spoken with BODY.PEEK throughout, so none of this marks mail as seen.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  ATTACHMENT_BYTES,
  BODY_CHARS,
  MAIL_LIMIT,
  mailGetMessage,
  mailListFolders,
  mailListParts,
  mailSaveAttachment,
  mailSearch,
} from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

const accountId = z.string().optional().describe('Restrict to a GOA mail account id (from accounts_list)');
const folder = z
  .string()
  .optional()
  .describe('Mailbox: display name, wire path, or role (sent/trash/archive). Default INBOX.');

export function registerMailTools(server: McpServer): void {
  // ── mail_list_folders ───────────────────────────────────────────────

  server.registerTool(
    'mail_list_folders',
    {
      title: 'List Mailboxes',
      description:
        'List the mailboxes of every (or one) mail account, with the role each serves (inbox, sent, drafts, trash, junk, archive) and where that role was determined from. Use the returned name or path as the folder argument of mail_search.',
      inputSchema: { account_id: accountId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const folders = await mailListFolders(params.account_id);
        return mcpSuccess({ count: folders.length, folders });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  // ── mail_search ─────────────────────────────────────────────────────

  server.registerTool(
    'mail_search',
    {
      title: 'Search Mail (IMAP)',
      description:
        'Search mail via IMAP through GNOME Online Accounts, newest first. Returns header/metadata summaries only (subject, from, to, date, flags, IMAP uid, folder) — never message bodies. Combine criteria freely: they are ANDed. Use the returned uid + account_id + folder with mail_get_message to read one message. IMPORTANT: since/before filter the message Date header; use received_since/received_before only when you specifically mean arrival time, which is unreliable on migrated mailboxes. Reading never marks a message as seen.',
      inputSchema: {
        query: z.string().optional().describe('Free text across headers and body (IMAP TEXT)'),
        from: z.string().optional().describe('Sender contains'),
        to: z.string().optional().describe('Recipient contains'),
        cc: z.string().optional().describe('Cc contains'),
        subject: z.string().optional().describe('Subject contains'),
        body: z.string().optional().describe('Body contains (excludes headers)'),
        since: z.string().optional().describe('Date header on/after this date, YYYY-MM-DD'),
        before: z.string().optional().describe('Date header before this date, YYYY-MM-DD'),
        received_since: z.string().optional().describe('Arrival on/after YYYY-MM-DD (see the note above)'),
        received_before: z.string().optional().describe('Arrival before YYYY-MM-DD'),
        unseen_only: z.boolean().optional().describe('Only unseen messages'),
        flagged_only: z.boolean().optional().describe('Only flagged messages'),
        account_id: accountId,
        folder,
        all_folders: z
          .boolean()
          .optional()
          .describe('Search every mailbox instead of one. Skips All Mail, Trash and Junk.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAIL_LIMIT.max)
          .optional()
          .describe(`Max messages (default ${MAIL_LIMIT.default}, max ${MAIL_LIMIT.max})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const messages = await mailSearch({
          query: params.query,
          from: params.from,
          to: params.to,
          cc: params.cc,
          subject: params.subject,
          body: params.body,
          since: params.since,
          before: params.before,
          receivedSince: params.received_since,
          receivedBefore: params.received_before,
          unseen: params.unseen_only,
          flagged: params.flagged_only,
          accountId: params.account_id,
          folder: params.folder,
          allFolders: params.all_folders,
          limit: params.limit,
        });
        return mcpSuccess({ count: messages.length, messages });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  // ── mail_get_message ────────────────────────────────────────────────

  server.registerTool(
    'mail_get_message',
    {
      title: 'Get Mail Message (IMAP)',
      description:
        'Fetch one full message by IMAP uid: headers, plain-text body (truncated to a cap) and attachment metadata (filename, type, size — never attachment contents). Requires account_id and uid from mail_search; pass the same folder mail_search reported.',
      inputSchema: {
        account_id: z.string().describe('GOA mail account id the message belongs to (from mail_search)'),
        uid: z.string().describe('IMAP uid of the message (from mail_search)'),
        folder,
        max_body_chars: z
          .number()
          .int()
          .positive()
          .max(BODY_CHARS.max)
          .optional()
          .describe(`Max body characters to return (default ${BODY_CHARS.default}, max ${BODY_CHARS.max})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const message = await mailGetMessage({
          accountId: params.account_id,
          uid: params.uid,
          folder: params.folder,
          maxBodyChars: params.max_body_chars,
        });
        return mcpSuccess({ message });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  // ── mail_list_parts ─────────────────────────────────────────────────

  server.registerTool(
    'mail_list_parts',
    {
      title: 'List Message Parts',
      description:
        'List the MIME parts of one message — each with its IMAP section, type, filename, size and whether it counts as an attachment. Call this before mail_save_attachment to choose a section, and to see a size before transferring it.',
      inputSchema: {
        account_id: z.string().describe('GOA mail account id (from mail_search)'),
        uid: z.string().describe('IMAP uid of the message (from mail_search)'),
        folder,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const parts = await mailListParts({
          accountId: params.account_id,
          uid: params.uid,
          folder: params.folder,
        });
        return mcpSuccess({ count: parts.length, parts });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  // ── mail_save_attachment ────────────────────────────────────────────

  server.registerTool(
    'mail_save_attachment',
    {
      title: 'Save Attachment',
      description:
        "Download one attachment to the user's attachment directory and return the path it was written to. The bytes are decoded, the filename is sanitized, and an existing file is never overwritten. Returns a path, not contents — read the file separately if you need it. Omit section to take the first attachment.",
      inputSchema: {
        account_id: z.string().describe('GOA mail account id (from mail_search)'),
        uid: z.string().describe('IMAP uid of the message (from mail_search)'),
        folder,
        section: z
          .string()
          .optional()
          .describe('IMAP section from mail_list_parts; omit for the first attachment'),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(ATTACHMENT_BYTES.max)
          .optional()
          .describe(`Refuse a part larger than this (default ${ATTACHMENT_BYTES.default})`),
      },
      // Writing a file is a side effect, but the tool reads MAIL — it cannot alter the mailbox,
      // and the write goes only to the user's own attachment directory. Marked read-only so it
      // survives the default-deny gate; the directory is NOT caller-controllable (no `directory`
      // input here on purpose), so the blast radius is one known folder.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const saved = await mailSaveAttachment({
          accountId: params.account_id,
          uid: params.uid,
          folder: params.folder,
          section: params.section,
          maxBytes: params.max_bytes,
        });
        return mcpSuccess({ saved });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
