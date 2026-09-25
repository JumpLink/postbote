import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type BackendManifest, type MessageBackend } from '@postbote/protocol';
import { MAIL_MANIFEST } from '@postbote/imap';
import { BUILTIN_PLUGINS } from '../../../src/core/backends/builtin.ts';
import { BackendRegistry, type BackendPlugin } from '../../../src/core/backends/registry.ts';
import { conversationsClassify } from '../../../src/core/actions/conversations.ts';
import { defaultConfig, loadConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';

// The registry gate and the config it reads. No backend here is ever constructed for real;
// the factories count how often they are called, which is the point: disabled means not loaded.

const TERMS = {
  summary: 'Unofficial client. The network may ban accounts that use it.',
  url: 'https://example.org/terms',
};

function plugin(name: string, manifest: Partial<BackendManifest> = {}): BackendPlugin & { created: number } {
  const entry = {
    created: 0,
    manifest: { ...MAIL_MANIFEST, name, displayName: name, ...manifest },
    create(): MessageBackend {
      entry.created++;
      return { manifest: entry.manifest, kind: 'archive', listAccounts: async () => [] };
    },
  };
  return entry;
}

function tempConfigPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'postbote-config-'));
  return { dir, path: join(dir, 'nested', 'config.json') };
}

export default async () => {
  await describe('BackendRegistry', async () => {
    await it('registers the built-in mail backend, enabled by the default config', async () => {
      const registry = new BackendRegistry(BUILTIN_PLUGINS);
      const [mail] = registry.status(defaultConfig());
      expect(mail.name).toBe('mail');
      expect(mail.enabled).toBe(true);
      expect(mail.storeTier).toBe('derived');
      expect(registry.enabled(defaultConfig()).length).toBe(1);
    });

    await it('loads nothing the config does not enable — mail included', async () => {
      const registry = new BackendRegistry(BUILTIN_PLUGINS);
      expect(registry.enabled({ backends: {}, senders: {} }).length).toBe(0);
      expect(registry.enabled({ backends: { mail: { enabled: false } }, senders: {} }).length).toBe(0);
    });

    await it('refuses the first enable of a backend with terms, and changes nothing', async () => {
      const chat = plugin('chat', { terms: TERMS });
      const registry = new BackendRegistry([chat]);
      const config = defaultConfig();
      const result = registry.enable(config, 'chat');
      expect(result.outcome).toBe('terms-required');
      expect(result.terms?.summary).toBe(TERMS.summary);
      expect(result.config).toBe(config);
      expect(registry.enabled(result.config).length).toBe(0);
      expect(chat.created).toBe(0);
    });

    await it('enables with accepted terms, and records when', async () => {
      const registry = new BackendRegistry([plugin('chat', { terms: TERMS })]);
      const now = new Date('2026-09-25T10:00:00Z');
      const result = registry.enable(defaultConfig(), 'chat', { acceptTerms: true, now });
      expect(result.outcome).toBe('enabled');
      expect(result.config.backends.chat.termsAcceptedAt).toBe(now.toISOString());
      expect(registry.enabled(result.config).map((p) => p.manifest.name)).toEqualArray(['chat']);
    });

    await it('does not honour a hand-edited `enabled: true` without accepted terms', async () => {
      const registry = new BackendRegistry([plugin('chat', { terms: TERMS })]);
      const config = { backends: { chat: { enabled: true } }, senders: {} };
      expect(registry.enabled(config).length).toBe(0);
      expect(registry.status(config)[0].termsAccepted).toBe(false);
    });

    await it('keeps the acceptance across disable, so re-enabling does not ask again', async () => {
      const registry = new BackendRegistry([plugin('chat', { terms: TERMS })]);
      const on = registry.enable(defaultConfig(), 'chat', { acceptTerms: true }).config;
      const off = registry.disable(on, 'chat');
      expect(registry.enabled(off).length).toBe(0);
      expect(registry.enable(off, 'chat').outcome).toBe('enabled');
    });

    await it('rejects an invalid manifest, a duplicate name and an unknown backend', async () => {
      expect(() => new BackendRegistry([plugin('Bad Name')])).toThrow(/invalid manifest/);
      expect(() => new BackendRegistry([plugin('dup'), plugin('dup')])).toThrow(/two backends/);
      expect(() => new BackendRegistry([plugin('one')]).enable(defaultConfig(), 'two')).toThrow(
        /unknown backend/,
      );
    });
  });

  await describe('built-in Telegram backend', async () => {
    await it('is registered, off by default, and gated behind its terms', async () => {
      const registry = new BackendRegistry(BUILTIN_PLUGINS);
      const telegram = registry.status(defaultConfig()).find((s) => s.name === 'telegram');
      expect(telegram?.enabled).toBe(false);
      expect(telegram?.syncModel).toBe('server-archive');
      expect(telegram?.terms !== null).toBe(true);
      expect(registry.enable(defaultConfig(), 'telegram').outcome).toBe('terms-required');
    });

    await it('cannot be constructed while disabled — the gate holds for create() too', async () => {
      const registry = new BackendRegistry(BUILTIN_PLUGINS);
      const context = { settings: {}, env: {}, secretsDir: join(tmpdir(), 'postbote-never-created') };
      expect(() => registry.create(defaultConfig(), 'telegram', context)).toThrow(/not enabled/);
      const enabled = registry.enable(defaultConfig(), 'telegram', { acceptTerms: true }).config;
      expect(registry.create(enabled, 'telegram', context).kind).toBe('chat');
    });
  });

  await describe('config', async () => {
    await it('parses and normalizes sender overrides', async () => {
      const config = parseConfig(
        '{"backends":{"mail":{"enabled":true}},"senders":{"Anna@Example.org":"automated"}}',
      );
      expect(config.senders['anna@example.org']).toBe('automated');
      expect(config.backends.mail.enabled).toBe(true);
    });

    await it('rejects a malformed file with the offending key named', async () => {
      expect(() => parseConfig('not json')).toThrow(/not valid JSON/);
      expect(() => parseConfig('{"backends":{"mail":{"enabled":"yes"}}}')).toThrow(/backends.mail.enabled/);
      expect(() => parseConfig('{"senders":{"anna@example.org":"spam"}}')).toThrow(/senders/);
      expect(() => parseConfig('{"senders":{"not-an-address":"automated"}}')).toThrow(/not a mail address/);
    });

    await it('an absent file means the default config', async () => {
      const { dir, path } = tempConfigPath();
      try {
        expect(loadConfig(path).backends.mail.enabled).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('round-trips through the file, mode 0600', async () => {
      const { dir, path } = tempConfigPath();
      try {
        saveConfig({ backends: { mail: { enabled: false } }, senders: {} }, path);
        expect(loadConfig(path).backends.mail.enabled).toBe(false);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('parses a backend settings block and rejects a nested value', async () => {
      const config = parseConfig(
        JSON.stringify({ backends: { telegram: { enabled: true, settings: { historyDepth: 50, label: 'x' } } } }),
      );
      expect(config.backends.telegram.settings?.historyDepth).toBe(50);
      expect(() =>
        parseConfig(
          JSON.stringify({ backends: { telegram: { enabled: true, settings: { label: { a: 1 } } } } }),
        ),
      ).toThrow(/settings\.label/);
    });

    await it('classify writes the override to the config, and `auto` removes it', async () => {
      const { dir, path } = tempConfigPath();
      try {
        conversationsClassify('Ben@Example.net', 'conversational', path);
        expect(JSON.parse(readFileSync(path, 'utf8')).senders['ben@example.net']).toBe('conversational');
        conversationsClassify('ben@example.net', 'auto', path);
        expect(loadConfig(path).senders['ben@example.net']).toBe(undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
