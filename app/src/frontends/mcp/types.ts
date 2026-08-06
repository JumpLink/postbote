/**
 * MCP response helpers.
 *
 * Every tool returns JSON as a single text block — one shape for both success and failure, so a
 * client never has to guess. Errors carry the message only: the underlying errors are protocol
 * and GOA failures whose stack traces contain hostnames and paths, and an MCP error string ends
 * up in a transcript.
 */

export function mcpError(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** Error response built from a caught value (the common catch handler). */
export function mcpErrorFrom(err: unknown) {
  return mcpError(err instanceof Error ? err.message : String(err));
}

export function mcpSuccess(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}
