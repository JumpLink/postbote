/**
 * Conversation tools — the per-person view over the local index, offline.
 *
 * Same privacy split as the mail tools: `conversations_list` cannot return a body at all, and
 * `conversations_get` returns bodies only when `include_bodies` is set, capped per message.
 * Everything here is other people's words; the default answer is who, when and what about.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  CONVERSATION_BODY_CHARS,
  CONVERSATION_LIMIT,
  conversationsList,
  conversationsShow,
} from '../../../core/actions/index.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

export function registerConversationTools(server: McpServer): void {
  server.registerTool(
    'conversations_list',
    {
      title: 'List Conversations (offline)',
      description:
        'List conversations from the local index, newest first, across every enabled backend: mail threads grouped by Message-ID/References and chats (e.g. Telegram direct chats, groups, channels). Each has its backend, participants (typed addresses — email, phone, telegram, … — and the linked address-book contact), message and unread counts, and a classification — conversational (a person) or automated (lists, notifications, no-reply, broadcast channels, bots). Set people_only to hide automated ones. No message bodies. Built by `postbote sync`; check mail_sync_status when the list looks incomplete.',
      inputSchema: {
        people_only: z.boolean().optional().describe('Only conversations with a person in them'),
        account_id: z.string().optional().describe('Restrict to one account id'),
        limit: z
          .number()
          .int()
          .positive()
          .max(CONVERSATION_LIMIT.max)
          .optional()
          .describe(
            `Max conversations (default ${CONVERSATION_LIMIT.default}, max ${CONVERSATION_LIMIT.max})`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return mcpSuccess(
          conversationsList({
            peopleOnly: params.people_only,
            accountId: params.account_id,
            limit: params.limit,
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  server.registerTool(
    'conversations_get',
    {
      title: 'Get One Conversation (offline)',
      description:
        'One conversation from the local index with its messages, oldest first: sender, date, subject, presentation (bubble for chat, document for mail), classification with its reason, and a ref — for mail (account, folder, uid), which mail_get_message accepts for the full message; for chats the network message id (remoteId), plus edit time, reply and thread ids and, on your own messages, whether the other side has read them. Bodies are omitted unless include_bodies is true, and then capped per message.',
      inputSchema: {
        id: z.string().min(1).describe('Conversation id from conversations_list'),
        include_bodies: z.boolean().optional().describe('Include each message body (default false)'),
        max_body_chars: z
          .number()
          .int()
          .positive()
          .max(CONVERSATION_BODY_CHARS.max)
          .optional()
          .describe(
            `Per-message body cap (default ${CONVERSATION_BODY_CHARS.default}, max ${CONVERSATION_BODY_CHARS.max})`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return mcpSuccess(
          conversationsShow({
            id: params.id,
            includeBodies: params.include_bodies,
            maxBodyChars: params.max_body_chars,
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
