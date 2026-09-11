/**
 * A tool that MUST NOT be served — the read-only gate's discriminator.
 *
 * The gate in runtime.ts is the one safety-critical piece of this server, and until this file
 * existed nothing could tell a working gate from an absent one. Every real tool declares
 * `readOnlyHint: true`, so a gate that had silently stopped wrapping `registerTool` — an SDK
 * rename, a registration path that bypasses the wrapper, a bundler transform — would serve the
 * exact same catalogue and every assertion in the suite would stay green. That is a guard whose
 * failure is invisible, which is the same as no guard.
 *
 * So this registers a tool that declares itself MUTATING and must therefore be dropped. Absent
 * from `tools/list` = the gate closed. Present = the gate is open and everything else the suite
 * claims about read-only-ness is worthless.
 *
 * Off unless `POSTBOTE_MCP_GATE_CANARY=1`, so it costs the shipped server nothing, and the
 * handler is inert in any case: it performs no write, it only reports that it should never have
 * been reachable. Enabling it can therefore never grant a capability — the worst case is one
 * tool that returns an error string.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { mcpError } from '../types.ts';

/**
 * TWO canaries, because one does not cover the failure that actually happens.
 *
 * Measured, not reasoned: with only the `readOnlyHint: false` canary in place, the gate was
 * rewritten to the fail-open spelling its own comment warns about —
 * `readOnlyHint === false ? undefined : register` — and the entire integration suite stayed
 * GREEN. Both spellings drop a tool that declares itself mutating, so that canary cannot tell
 * them apart. The difference between them is the UNANNOTATED tool: the correct gate drops it,
 * the fail-open one serves it. That is also the realistic defect, since an unannotated tool is
 * what a forgetful author produces, whereas nobody writes `readOnlyHint: false` by accident.
 *
 * So the second canary carries no `annotations` key at all, and it is the one with teeth.
 */
export const GATE_CANARY_TOOLS = ['gate_canary_write', 'gate_canary_unannotated'] as const;

export function registerGateCanary(server: McpServer): void {
  if (process.env.POSTBOTE_MCP_GATE_CANARY !== '1') return;

  // Catches a gate that has stopped intercepting registration altogether.
  server.registerTool(
    'gate_canary_write',
    {
      title: 'Gate canary, declared mutating (must never be served)',
      description:
        'Test-only probe. Declares itself mutating so the read-only gate has something it MUST drop. If you can see this tool, the gate is not intercepting registration at all.',
      // The whole point: false, never true. Flipping this to true destroys the test.
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => mcpError('gate canary reached — the read-only gate is NOT closing'),
  );

  // Catches the gate pointed the wrong way. Deliberately carries NO annotations: a
  // default-deny gate drops it, a fail-open one serves it.
  server.registerTool(
    'gate_canary_unannotated',
    {
      title: 'Gate canary, unannotated (must never be served)',
      description:
        'Test-only probe with no readOnlyHint at all. A default-DENY gate drops it; a gate that only drops explicit writes serves it. If you can see this tool, the gate fails OPEN on every tool whose author forgot the annotation.',
    },
    async () => mcpError('gate canary reached — the read-only gate fails OPEN on unannotated tools'),
  );
}
