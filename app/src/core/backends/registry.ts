/**
 * The backend registry — the one way a backend gets loaded (ADR 0001 §5).
 *
 * A backend is loaded only when the config enables it, and one that ships a terms notice only
 * once the user has accepted it; `enable` refuses and returns the notice instead. Built-in mail
 * goes through here like any other, so the plugin API is exercised from day one rather than
 * being a path nothing uses. Plugins are never fetched from the network: the registry knows
 * exactly the list it was constructed with.
 *
 * Pure over (plugins, config) — no file access — so every gate is tested on Node.
 */

import {
  type BackendCapabilities,
  type BackendContext,
  type BackendManifest,
  type MessageBackend,
  type SyncModel,
  type TermsNotice,
  storeTierFor,
  validateManifest,
} from '@postbote/protocol';
import type { PostboteConfig } from '../config.ts';

/** A registry entry: the manifest, readable without running the backend, and its factory. */
export interface BackendPlugin<B extends MessageBackend = MessageBackend> {
  manifest: BackendManifest;
  create(context: BackendContext): B;
}

export interface BackendStatus {
  name: string;
  displayName: string;
  enabled: boolean;
  syncModel: SyncModel;
  /** The backup tier of its message store: `derived` (rebuildable) or `state` (only copy). */
  storeTier: 'derived' | 'state';
  native: boolean;
  capabilities: BackendCapabilities;
  terms: TermsNotice | null;
  termsAccepted: boolean;
}

export type EnableOutcome =
  | { outcome: 'enabled' | 'already-enabled'; config: PostboteConfig; terms: TermsNotice | null }
  /** The backend has terms the user has not accepted: nothing was changed. */
  | { outcome: 'terms-required'; config: PostboteConfig; terms: TermsNotice };

export class BackendRegistry {
  private readonly plugins = new Map<string, BackendPlugin>();

  constructor(plugins: readonly BackendPlugin[]) {
    for (const plugin of plugins) {
      const problems = validateManifest(plugin.manifest);
      if (problems.length > 0) {
        throw new Error(
          `backend ${JSON.stringify(plugin.manifest.name)} has an invalid manifest: ${problems.join('; ')}`,
        );
      }
      if (this.plugins.has(plugin.manifest.name)) {
        throw new Error(`two backends are named ${JSON.stringify(plugin.manifest.name)}`);
      }
      this.plugins.set(plugin.manifest.name, plugin);
    }
  }

  names(): string[] {
    return [...this.plugins.keys()];
  }

  private require(name: string): BackendPlugin {
    const plugin = this.plugins.get(name);
    if (!plugin)
      throw new Error(`unknown backend ${JSON.stringify(name)} — known: ${this.names().join(', ')}`);
    return plugin;
  }

  private static termsAccepted(manifest: BackendManifest, config: PostboteConfig): boolean {
    return manifest.terms === null || typeof config.backends[manifest.name]?.termsAcceptedAt === 'string';
  }

  /** Every known backend with its state under `config`. */
  status(config: PostboteConfig): BackendStatus[] {
    return [...this.plugins.values()].map(({ manifest }) => {
      const accepted = BackendRegistry.termsAccepted(manifest, config);
      return {
        name: manifest.name,
        displayName: manifest.displayName,
        // A hand-edited `enabled: true` without accepted terms does not count: the gate is the
        // acceptance, not the flag.
        enabled: config.backends[manifest.name]?.enabled === true && accepted,
        syncModel: manifest.syncModel,
        storeTier: storeTierFor(manifest.syncModel),
        native: manifest.native,
        capabilities: manifest.capabilities,
        terms: manifest.terms,
        termsAccepted: accepted,
      };
    });
  }

  /**
   * Construct one ENABLED backend. Refuses a disabled one or one whose terms are not accepted,
   * so no code path can reach a backend around the gate.
   */
  create(config: PostboteConfig, name: string, context: BackendContext): MessageBackend {
    const plugin = this.enabled(config).find((p) => p.manifest.name === name);
    if (!plugin) {
      this.require(name);
      throw new Error(
        `backend ${name} is not enabled — \`postbote backends enable ${name}\` turns it on (and shows its terms)`,
      );
    }
    return plugin.create(context);
  }

  /** The plugins `config` enables — the only ones any code path may construct. */
  enabled(config: PostboteConfig): BackendPlugin[] {
    const on = new Set(
      this.status(config)
        .filter((s) => s.enabled)
        .map((s) => s.name),
    );
    return [...this.plugins.values()].filter((p) => on.has(p.manifest.name));
  }

  /**
   * Enable a backend. The first enable of one with a terms notice needs `acceptTerms`; without
   * it the config is returned unchanged together with the notice to show.
   */
  enable(
    config: PostboteConfig,
    name: string,
    options: { acceptTerms?: boolean; now?: Date } = {},
  ): EnableOutcome {
    const { manifest } = this.require(name);
    const current = config.backends[name];
    const accepted = BackendRegistry.termsAccepted(manifest, config);
    if (current?.enabled && accepted) return { outcome: 'already-enabled', config, terms: manifest.terms };
    if (!accepted && manifest.terms && !options.acceptTerms) {
      return { outcome: 'terms-required', config, terms: manifest.terms };
    }
    const entry = {
      enabled: true,
      ...(current?.termsAcceptedAt ? { termsAcceptedAt: current.termsAcceptedAt } : {}),
      ...(!accepted && manifest.terms ? { termsAcceptedAt: (options.now ?? new Date()).toISOString() } : {}),
    };
    return {
      outcome: 'enabled',
      config: { ...config, backends: { ...config.backends, [name]: entry } },
      terms: manifest.terms,
    };
  }

  /** Disable a backend. Keeps the recorded acceptance: re-enabling does not re-ask. */
  disable(config: PostboteConfig, name: string): PostboteConfig {
    this.require(name);
    const current = config.backends[name];
    return { ...config, backends: { ...config.backends, [name]: { ...current, enabled: false } } };
  }
}
