/**
 * Contact tools — Evolution Data Server address books (CardDAV/local).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CONTACT_LIMIT, contactsSearch } from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerContactsTools(server: McpServer): void {
  server.registerTool(
    'contacts_search',
    {
      title: 'Search Contacts',
      description:
        'Search contacts across enabled address books (CardDAV/local) via Evolution Data Server. Returns name, organization, emails and phones. Use account_id to scope to one GOA account.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text search (any field contains); omit to list all, subject to limit'),
        limit: z
          .number()
          .int()
          .positive()
          .max(CONTACT_LIMIT.max)
          .optional()
          .describe(`Max contacts (default ${CONTACT_LIMIT.default}, max ${CONTACT_LIMIT.max})`),
        account_id: z.string().optional().describe('Restrict to a GOA account id (from accounts_list)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const contacts = await contactsSearch({
          query: params.query,
          limit: params.limit,
          accountId: params.account_id,
        });
        return mcpSuccess({ count: contacts.length, contacts });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
