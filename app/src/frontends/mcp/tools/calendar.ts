/**
 * Calendar tools — Evolution Data Server calendars (CalDAV/local).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { calendarListEvents, EVENT_LIMIT, EVENT_WINDOW_DAYS } from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    'calendar_list_events',
    {
      title: 'List Calendar Events',
      description: `List calendar events occurring in a date window (CalDAV/local) via Evolution Data Server. Returns summary, start/end (ISO-8601), all-day flag, location, organizer and attendees. Defaults to today..+${EVENT_WINDOW_DAYS} days.`,
      inputSchema: {
        from: z.string().optional().describe('Window start YYYY-MM-DD (default: today)'),
        to: z.string().optional().describe(`Window end YYYY-MM-DD (default: +${EVENT_WINDOW_DAYS} days)`),
        limit: z
          .number()
          .int()
          .positive()
          .max(EVENT_LIMIT.max)
          .optional()
          .describe(`Max events (default ${EVENT_LIMIT.default}, max ${EVENT_LIMIT.max})`),
        calendar_uid: z.string().optional().describe('Restrict to a single calendar source uid'),
        account_id: z.string().optional().describe('Restrict to a GOA account id (from accounts_list)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const events = await calendarListEvents({
          from: params.from,
          to: params.to,
          limit: params.limit,
          calendarUid: params.calendar_uid,
          accountId: params.account_id,
        });
        return mcpSuccess({ count: events.length, events });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
