/**
 * Postbote MCP server — mail, contacts and calendar from GNOME Online Accounts, over stdio.
 *
 * v1 registers read-only tools only, and the gate in runtime.ts enforces that rather than
 * trusting it: every tool must carry `readOnlyHint: true` or it is dropped. IMAP is spoken with
 * BODY.PEEK throughout, so even a read never marks a message as seen.
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerAccountsTools } from './tools/accounts.ts';
import { registerCalendarTools } from './tools/calendar.ts';
import { registerContactsTools } from './tools/contacts.ts';
import { registerMailTools } from './tools/mail.ts';
import { applyReadOnlyGate, serveStdio } from './runtime.ts';

const SERVER_NAME = 'postbote';
const SERVER_VERSION = '0.1.0';

/** Every registrar, in the order their tools should appear. */
const REGISTRARS: Array<(server: McpServer) => void> = [
  registerMailTools,
  registerContactsTools,
  registerCalendarTools,
  registerAccountsTools,
];

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // Before any registration — the gate works by wrapping registerTool, so anything registered
  // earlier would slip past it.
  applyReadOnlyGate(server, process.env.POSTBOTE_MCP_ALLOW_WRITE === '1');
  for (const register of REGISTRARS) register(server);
  return server;
}

/** Start the stdio server and serve until the client disconnects. Does not return. */
export async function startMcpServer(): Promise<void> {
  await serveStdio(createMcpServer(), SERVER_NAME);
}
