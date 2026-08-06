/**
 * `postbote mcp` — serve the read-only tools over stdio for an MCP client.
 *
 * Long-lived by design: it parks until the client closes stdin. Not wired through runAndExit,
 * which exits as soon as its promise settles.
 */

import type { CommandModule } from 'yargs';

import { startMcpServer } from '../mcp/server.ts';

export const mcpCommand: CommandModule = {
  command: 'mcp',
  describe: 'Run the MCP server over stdio (read-only tools; for Claude Code and other clients)',
  handler: () => {
    startMcpServer().catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      return process.exit(1);
    });
  },
};
