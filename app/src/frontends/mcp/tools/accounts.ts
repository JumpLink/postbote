/**
 * Account tools — which mailboxes, address books and calendars exist.
 *
 * Every other tool is scoped by the `account_id` values this one returns, so it is the natural
 * first call. No credentials are ever part of the result.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { accountsList } from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerAccountsTools(server: McpServer): void {
  server.registerTool(
    'accounts_list',
    {
      title: 'List GNOME Online Accounts',
      description:
        'List the configured GNOME Online Accounts (GOA) and which data domains each exposes (mail/calendar/contacts/files) plus available auth mechanisms. Start here: the returned id is the account_id every other tool accepts. No credentials are returned.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const accounts = await accountsList();
        return mcpSuccess({ count: accounts.length, accounts });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
