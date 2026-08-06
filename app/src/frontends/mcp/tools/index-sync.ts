/**
 * Index tools — searching the local index offline, and reporting its freshness.
 *
 * `mail_sync_status` is read-only. Building the index is NOT exposed as a tool: it is a
 * long-running network operation the user should start deliberately (`postbote sync`), and a
 * write besides.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { MAIL_LIMIT, indexSearch, indexStatus } from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerIndexTools(server: McpServer): void {
  server.registerTool(
    'mail_sync_status',
    {
      title: 'Local Index Status',
      description:
        'Report what the local full-text index holds (accounts, mailboxes, message count) and how fresh it is, including which mailboxes are stale. Check this before relying on mail_search_local — an empty or stale index means results are incomplete, and the user needs to run `postbote sync`.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return mcpSuccess(indexStatus());
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  server.registerTool(
    'mail_search_local',
    {
      title: 'Search the Local Index (offline)',
      description:
        'Search the local full-text index instead of contacting the mail servers. Much faster than mail_search and works offline, but only covers what `postbote sync` has indexed — always check mail_sync_status first, and fall back to mail_search when the index is empty or stale. Full-text covers subject, sender, recipients AND message bodies; diacritics are folded, so "marz" finds "März".',
      inputSchema: {
        query: z.string().optional().describe('Full text across subject, sender, recipients and body'),
        from: z.string().optional().describe('Sender contains (substring, not full text)'),
        subject: z.string().optional().describe('Subject contains (substring, not full text)'),
        since: z.string().optional().describe('Date header on/after this date, YYYY-MM-DD'),
        before: z.string().optional().describe('Date header before this date, YYYY-MM-DD'),
        unseen_only: z.boolean().optional().describe('Only unseen messages'),
        flagged_only: z.boolean().optional().describe('Only flagged messages'),
        has_attachment: z.boolean().optional().describe('Only messages carrying an attachment'),
        account_id: z.string().optional().describe('Restrict to a GOA account id'),
        folder: z.string().optional().describe('Restrict to one mailbox, by its wire path'),
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
        const result = indexSearch({
          query: params.query,
          from: params.from,
          subject: params.subject,
          since: params.since,
          before: params.before,
          unseen: params.unseen_only,
          flagged: params.flagged_only,
          hasAttachment: params.has_attachment,
          accountId: params.account_id,
          folderPath: params.folder,
          limit: params.limit ?? MAIL_LIMIT.default,
        });
        // The provenance travels with the answer: a caller must be able to tell a complete
        // result from one drawn out of a half-built index.
        return mcpSuccess({
          count: result.messages.length,
          source: 'local-index',
          indexedAt: result.indexedAt,
          staleFolders: result.staleFolders,
          messages: result.messages,
        });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
