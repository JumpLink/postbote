/**
 * Backend actions — what is installed, what is enabled, and the terms gate on enabling.
 *
 * These write the CONFIG file, never the index: enabling a backend is a user decision, and
 * `postbote sync` stays the only thing that writes to the index.
 */

import type { TermsNotice } from '@postbote/protocol';
import { configPath } from '@postbote/store';
import { builtinRegistry } from '../backends/builtin.ts';
import type { BackendStatus, EnableOutcome } from '../backends/registry.ts';
import { loadConfig, saveConfig } from '../config.ts';

export function backendsList(path = configPath()): { configPath: string; backends: BackendStatus[] } {
  return { configPath: path, backends: builtinRegistry().status(loadConfig(path)) };
}

export function backendsEnable(
  name: string,
  options: { acceptTerms?: boolean; path?: string } = {},
): { name: string; outcome: EnableOutcome['outcome']; terms: TermsNotice | null } {
  const path = options.path ?? configPath();
  const result = builtinRegistry().enable(loadConfig(path), name, { acceptTerms: options.acceptTerms });
  if (result.outcome === 'enabled') saveConfig(result.config, path);
  return { name, outcome: result.outcome, terms: result.terms };
}

export function backendsDisable(name: string, path = configPath()): { name: string; enabled: false } {
  saveConfig(builtinRegistry().disable(loadConfig(path), name), path);
  return { name, enabled: false };
}
