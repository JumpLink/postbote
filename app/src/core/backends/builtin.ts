/**
 * The backends that ship with postbote. Each is registered exactly like a third-party plugin
 * would be: a manifest and a factory. Nothing constructs a backend except through the registry.
 */

import { ImapBackend, MAIL_MANIFEST } from '@postbote/imap';
import { BackendRegistry, type BackendPlugin } from './registry.ts';

export const BUILTIN_PLUGINS: readonly BackendPlugin[] = [
  { manifest: MAIL_MANIFEST, create: () => new ImapBackend() },
];

export function builtinRegistry(): BackendRegistry {
  return new BackendRegistry(BUILTIN_PLUGINS);
}
