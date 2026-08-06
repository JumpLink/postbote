/**
 * A stand-in for McpServer that records registrations instead of serving them.
 *
 * Lets the tool catalogue and the read-only gate be asserted on BOTH runtimes without a
 * transport, a client, or a live GOA session — the handlers are never invoked.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** The parts of a tool config these tests care about. */
export interface RecordedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
}

export interface Recorder {
  server: McpServer;
  tools: RecordedTool[];
  names(): string[];
  find(name: string): RecordedTool | undefined;
}

export function createRecorder(): Recorder {
  const tools: RecordedTool[] = [];
  const server = {
    registerTool: (name: string, config: Omit<RecordedTool, 'name'>) => {
      tools.push({ name, ...config });
      return undefined;
    },
  } as unknown as McpServer;
  return {
    server,
    tools,
    names: () => tools.map((t) => t.name),
    find: (name) => tools.find((t) => t.name === name),
  };
}
