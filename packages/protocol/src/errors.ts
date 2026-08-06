/**
 * GNOME binding error classes.
 *
 * Note: no TypeScript parameter properties — Node's --experimental-strip-types
 * does not support them (same constraint as @buchhaltung/eric).
 */

/** Thrown when a data function is called but GOA/EDS is not reachable. */
export class GnomeUnavailableError extends Error {
  readonly name = 'GnomeUnavailableError';

  constructor(message: string) {
    super(message);
  }
}

/** Wraps a native GError (GLib.Error) surfaced from a GOA/EDS call. */
export class GnomeError extends Error {
  readonly name = 'GnomeError';
  readonly domain?: string;
  readonly code?: number;

  constructor(message: string, domain?: string, code?: number) {
    super(message);
    this.domain = domain;
    this.code = code;
  }
}

/**
 * Extract a human-readable message from a thrown GLib.Error / unknown. Shared by
 * the GJS modules (goa/eds/mail) so they surface native errors uniformly.
 */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
