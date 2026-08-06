/**
 * Shared Evolution Data Server helpers (GJS-only): the process-wide source
 * registry and the GOA-account resolution used by both contacts and calendar.
 */

import EDataServer from 'gi://EDataServer?version=1.2';

let registry: EDataServer.SourceRegistry | null = null;

/**
 * One process-wide EDS source registry, created on first use. `new_sync` is
 * acceptable here: it is a one-time setup against the already-running
 * evolution-source-registry D-Bus service, not a per-request call.
 */
export function getRegistry(): EDataServer.SourceRegistry {
  if (!registry) {
    registry = EDataServer.SourceRegistry.new_sync(null);
  }
  return registry;
}

/**
 * Resolve which GOA account a source belongs to. The GOA extension may sit on
 * the leaf source or on a collection parent, so walk up the parent chain.
 * Returns the GOA account id, or null if the source is not GOA-backed.
 */
export function sourceGoaAccountId(
  reg: EDataServer.SourceRegistry,
  source: EDataServer.Source,
): string | null {
  let current: EDataServer.Source | null = source;
  const seen = new Set<string>();
  while (current) {
    if (current.has_extension(EDataServer.SOURCE_EXTENSION_GOA)) {
      const ext = current.get_extension(EDataServer.SOURCE_EXTENSION_GOA) as EDataServer.SourceGoa;
      return ext.get_account_id();
    }
    const parentUid = current.get_parent();
    if (!parentUid || seen.has(parentUid)) break;
    seen.add(parentUid);
    current = reg.ref_source(parentUid);
  }
  return null;
}

/**
 * Normalize the result of a promisified EDS list call. GJS marshals the
 * `(gboolean success, out GSList list)` pattern (e.g. get_contacts_finish,
 * get_object_list_finish) as a `[success, list]` tuple, while the @girs types
 * optimistically declare `Promise<T[]>`. This unwraps either shape to `T[]`.
 */
export function extractList<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  // [success: boolean, list: T[]]
  if (result.length === 2 && typeof result[0] === 'boolean' && Array.isArray(result[1])) {
    return result[1] as T[];
  }
  // [list: T[]] — single out-arg wrapped in a tuple
  if (result.length === 1 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  // T[] directly
  return result as T[];
}
