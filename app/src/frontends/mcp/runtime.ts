/**
 * MCP server lifecycle for a gjsify/GJS process: the read-only gate and the stdio serve loop.
 *
 * EXTRACTION CANDIDATE → `@gjsify/mcp`. Keep this file postbote-free — no import from anywhere
 * else in this repo — so it can move verbatim. It is not extracted yet on purpose: nothing here
 * imports gjsify, so it is a consumer-side lifecycle pattern rather than a missing gjsify
 * capability, and a new `@gjsify/*` name costs a manual first-publish plus a release cut.
 *
 * Both halves are the surviving version of a mistake made in an earlier copy of this file
 * elsewhere in the workspace. Neither is a style preference; read the comments before changing
 * either one.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Gate mutating tools, DEFAULT-DENY.
 *
 * Unless writes are explicitly allowed, a tool is registered ONLY if it proves it is read-only
 * (`readOnlyHint === true`). A tool that omits the annotation, or mis-sets it, is DROPPED.
 *
 * The direction matters and is the whole point: the obvious spelling — drop only when
 * `readOnlyHint === false` — fails OPEN, silently exposing every tool whose author forgot the
 * annotation. This one fails CLOSED: the failure mode is a tool mysteriously missing from
 * `tools/list`, which gets noticed and fixed, instead of a mutation quietly reachable.
 *
 * Identifying tools by their own annotation rather than a name list means there is no second
 * list to drift as tools are added.
 *
 * Call this BEFORE registering anything — it wraps `registerTool`, so tools registered earlier
 * are already through.
 */
export function applyReadOnlyGate(server: McpServer, allowWrite: boolean): void {
  if (allowWrite) return;
  const orig = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    ...rest: unknown[]
  ) =>
    config?.annotations?.readOnlyHint === true
      ? (orig as (...a: unknown[]) => unknown)(name, config, ...rest)
      : undefined) as typeof server.registerTool;
}

/**
 * Serve over stdio until the client goes away, then exit the process.
 *
 * Park until EOF — NOT forever. The naive `await new Promise<never>(() => {})` is unsettleable,
 * so a server whose client died just keeps running. The evidence that this actually happens is
 * the parent pointer: such processes have been found REPARENTED TO `systemd --user`, which only
 * occurs once the process that spawned them is gone. A live client holds the write end of the
 * pipe open, so without EOF handling the process can only ever be reaped by hand.
 *
 * Do NOT treat concurrently-running servers as leaks: several editor sessions can be open at
 * once and each legitimately owns one. The liveness test is whether a process still has a live
 * client ancestor — not whether it belongs to the session doing the counting. Getting that
 * backwards kills healthy servers out from under parallel sessions.
 *
 * stdin EOF is the signal: for a stdio child, the parent closing the pipe IS "you are done".
 * The MCP SDK will not report it — its StdioServerTransport attaches only `data` and `error` to
 * stdin and calls `close()` solely on an explicit shutdown, so EOF is left to the server author.
 */
export async function serveStdio(server: McpServer, label = 'mcp'): Promise<never> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // @gjsify/process (0.11+) auto-resumes the stdin read stream when the SDK attaches its
  // `.on('data')` listener, exactly like Node — no manual process.stdin.resume() is needed
  // any more (that was the pre-0.11 GJS workaround).
  await new Promise<void>((resolve) => {
    // CHAIN, never clobber: `server.connect()` already installed the Protocol's own `onclose`
    // for its bookkeeping, and overwriting it would silently disable the SDK's cleanup.
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      sdkOnClose?.();
      resolve();
    };
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  console.error(`[${label}] client disconnected (stdin closed) — exiting`);
  // An explicit exit, because returning is not enough: the GLib main loop this CLI arms keeps
  // the process parked at 0 % CPU with nothing left to serve, and only process.exit() tears it
  // down. `return` in front is the house rule — a bare process.exit() under GJS schedules the
  // exit and keeps running, which double-exits.
  return process.exit(0);
}
