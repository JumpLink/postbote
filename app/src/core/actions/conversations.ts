/**
 * Conversation actions — the per-person view over the local index.
 *
 * Read-only against the index, like `index search`: conversations are built by `postbote sync`.
 * Per-sender corrections go to the config file and apply at read time, so a correction shows
 * immediately and still never writes to the index.
 */

import type { Classification, Conversation, ConversationMessage } from '@postbote/protocol';
import { normalizeAddress } from '@postbote/protocol';
import { configPath, getConversation, indexDbPath, listConversations, syncStatus } from '@postbote/store';
import { loadConfig, saveConfig } from '../config.ts';
import { MAX_STALENESS_HOURS, openIndex } from './index-sync.ts';
import { CONVERSATION_BODY_CHARS, CONVERSATION_LIMIT, capLimit } from './limits.ts';

export interface ConversationsListParams {
  peopleOnly?: boolean;
  accountId?: string;
  limit?: number;
  dbPath?: string;
  configPath?: string;
}

export function conversationsList(params: ConversationsListParams = {}): {
  count: number;
  source: 'local-index';
  indexedAt: string | null;
  conversations: Conversation[];
} {
  const { senders } = loadConfig(params.configPath ?? configPath());
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    const conversations = listConversations(db, {
      peopleOnly: params.peopleOnly,
      accountId: params.accountId,
      limit: capLimit(params.limit, CONVERSATION_LIMIT),
      overrides: senders,
    });
    return {
      count: conversations.length,
      source: 'local-index',
      indexedAt: syncStatus(db, MAX_STALENESS_HOURS, new Date()).newestSync,
      conversations,
    };
  } finally {
    db.close();
  }
}

export interface ConversationShowParams {
  id: string;
  includeBodies?: boolean;
  maxBodyChars?: number;
  dbPath?: string;
  configPath?: string;
}

export function conversationsShow(params: ConversationShowParams): {
  conversation: Conversation;
  messages: ConversationMessage[];
} {
  const { senders } = loadConfig(params.configPath ?? configPath());
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    const found = getConversation(db, params.id, {
      includeBodies: params.includeBodies,
      maxBodyChars: capLimit(params.maxBodyChars, CONVERSATION_BODY_CHARS),
      overrides: senders,
    });
    if (!found) throw new Error(`no conversation with id ${params.id} — run \`postbote conversations list\``);
    return found;
  } finally {
    db.close();
  }
}

/**
 * Correct the classification of one sender, or hand it back to the automatic rules (`auto`).
 * Writes the config, not the index.
 */
export function conversationsClassify(
  address: string,
  as: Classification | 'auto',
  path = configPath(),
): { address: string; classification: Classification | 'auto' } {
  const key = normalizeAddress('email', address);
  if (!key) throw new Error(`${JSON.stringify(address)} is not a mail address`);
  const config = loadConfig(path);
  const senders = { ...config.senders };
  if (as === 'auto') delete senders[key];
  else senders[key] = as;
  saveConfig({ ...config, senders }, path);
  return { address: key, classification: as };
}
