/**
 * Mail tools — IMAP search and single-message fetch.
 *
 * Two tools, not one with a flag: `mail_search` is structurally incapable of returning a body,
 * so no query however broad can dump message contents. Reading a message is a second, explicit
 * call naming its uid. IMAP is spoken with BODY.PEEK, so reading here never marks mail as seen.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { BODY_CHARS, MAIL_LIMIT, mailGetMessage, mailSearch } from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerMailTools(server: McpServer): void {
  // ── mail_search ─────────────────────────────────────────────────────

  server.registerTool(
    'mail_search',
    {
      title: 'Search Mail (IMAP)',
      description:
        'Search mail via IMAP through GNOME Online Accounts, newest first. Returns header/metadata summaries only (subject, from, to, date, flags, IMAP uid) — never message bodies. Use the returned uid + account_id with mail_get_message to read one message. Scope with account_id (omit to search all mail accounts), folder (default INBOX), query (free text), unseen_only and since. Reading never marks a message as seen.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text IMAP search (TEXT); omit for the most recent messages'),
        account_id: z
          .string()
          .optional()
          .describe('Restrict to a GOA mail account id (from accounts_list); omit to search all'),
        folder: z.string().optional().describe('Mailbox to search (default INBOX)'),
        unseen_only: z.boolean().optional().describe('Only unseen messages'),
        since: z.string().optional().describe('Only messages since this date, YYYY-MM-DD'),
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
          accountId: params.account_id,
          folder: params.folder,
          unseenOnly: params.unseen_only,
          since: params.since,
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
        'Fetch one full message by IMAP uid: headers, plain-text body (truncated to a cap) and attachment metadata (filename, type, size — never attachment contents). Requires account_id and uid from mail_search.',
      inputSchema: {
        account_id: z.string().describe('GOA mail account id the message belongs to (from mail_search)'),
        uid: z.string().describe('IMAP uid of the message (from mail_search)'),
        folder: z.string().optional().describe('Mailbox the uid belongs to (default INBOX)'),
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
}
