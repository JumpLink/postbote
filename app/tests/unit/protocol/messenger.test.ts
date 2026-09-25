import { describe, expect, it } from '@gjsify/unit';

import {
  type BackendManifest,
  isMailBackend,
  normalizeAddress,
  PLUGIN_API_VERSION,
  storeTierFor,
  validateManifest,
} from '@postbote/protocol';
import { MAIL_MANIFEST } from '@postbote/imap';

// The network-neutral plugin API: typed addresses, manifests, sync models. All synthetic.

function manifest(overrides: Partial<BackendManifest> = {}): BackendManifest {
  return { ...MAIL_MANIFEST, name: 'example', displayName: 'Example', ...overrides };
}

export default async () => {
  await describe('normalizeAddress', async () => {
    await it('folds a mail address to lower case and strips mailto: and brackets', async () => {
      expect(normalizeAddress('email', ' Anna.Beispiel@Example.ORG ')).toBe('anna.beispiel@example.org');
      expect(normalizeAddress('email', 'mailto:anna@example.org')).toBe('anna@example.org');
      expect(normalizeAddress('email', '<anna@example.org>')).toBe('anna@example.org');
    });

    await it('rejects what is not a mail address', async () => {
      expect(normalizeAddress('email', 'anna')).toBe(null);
      expect(normalizeAddress('email', '@example.org')).toBe(null);
      expect(normalizeAddress('email', 'anna@')).toBe(null);
      expect(normalizeAddress('email', 'an na@example.org')).toBe(null);
      expect(normalizeAddress('email', '   ')).toBe(null);
    });

    await it('strips phone formatting and turns 00 into +', async () => {
      expect(normalizeAddress('phone', '+49 (0151) 234-5678')).toBe('+4901512345678');
      expect(normalizeAddress('phone', '0049 151 2345678')).toBe('+491512345678');
      expect(normalizeAddress('phone', 'tel:+49.151.2345678')).toBe('+491512345678');
      expect(normalizeAddress('phone', 'call me')).toBe(null);
    });

    await it('drops the @ of a Telegram handle and folds its case; keeps numeric ids', async () => {
      expect(normalizeAddress('telegram', '@Anna_Example')).toBe('anna_example');
      expect(normalizeAddress('telegram', '123456789')).toBe('123456789');
      expect(normalizeAddress('telegram', '@ab')).toBe(null);
    });

    await it('accepts a Matrix user id only in @local:server form', async () => {
      expect(normalizeAddress('matrix', '@Anna:Example.org')).toBe('@anna:example.org');
      expect(normalizeAddress('matrix', 'anna:example.org')).toBe(null);
    });

    await it('keeps a national phone number national — it does not merge with E.164', async () => {
      expect(normalizeAddress('phone', '0151 2345678')).toBe('01512345678');
    });

    await it('accepts a Signal ACI UUID or username, lower-cased', async () => {
      expect(normalizeAddress('signal', 'ACI:0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9')).toBe(
        '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9',
      );
      expect(normalizeAddress('signal', 'Anna_E.42')).toBe('anna_e.42');
      expect(normalizeAddress('signal', 'anna')).toBe(null);
      expect(normalizeAddress('signal', '+491512345678')).toBe(null);
    });

    await it('maps WhatsApp numbers and JIDs to one form, keeping LIDs apart', async () => {
      expect(normalizeAddress('whatsapp', '+491512345678')).toBe('491512345678@s.whatsapp.net');
      expect(normalizeAddress('whatsapp', '491512345678:3@s.whatsapp.net')).toBe(
        '491512345678@s.whatsapp.net',
      );
      expect(normalizeAddress('whatsapp', '491512345678@c.us')).toBe('491512345678@s.whatsapp.net');
      expect(normalizeAddress('whatsapp', '123456789012345@LID')).toBe('123456789012345@lid');
      expect(normalizeAddress('whatsapp', 'anna@example.org')).toBe(null);
    });

    await it('reduces a JID to its bare form — the resource is a device, not the person', async () => {
      expect(normalizeAddress('jid', 'Anna@Example.org/phone')).toBe('anna@example.org');
      expect(normalizeAddress('jid', 'xmpp:anna@example.org')).toBe('anna@example.org');
      expect(normalizeAddress('jid', 'example.org')).toBe(null);
    });
  });

  await describe('validateManifest', async () => {
    await it('accepts the built-in mail manifest', async () => {
      expect(validateManifest(MAIL_MANIFEST)).toEqualArray([]);
    });

    await it('rejects a plugin built for another plugin API version', async () => {
      const problems = validateManifest(manifest({ pluginApi: PLUGIN_API_VERSION + 1 }));
      expect(problems.length).toBe(1);
      expect(problems[0]).toMatch(/plugin API/);
    });

    await it('reports every problem at once, not only the first', async () => {
      const bad = manifest({
        name: 'Not A Name',
        syncModel: 'sometimes' as never,
        addressKinds: ['fax' as never],
        terms: { summary: '  ' },
      });
      expect(validateManifest(bad).length).toBe(4);
    });

    await it('rejects a manifest that leaves a capability undeclared', async () => {
      const { e2ee: _dropped, ...partial } = MAIL_MANIFEST.capabilities;
      const problems = validateManifest(manifest({ capabilities: partial as never }));
      expect(problems.join()).toMatch(/e2ee/);
    });
  });

  await describe('sync model', async () => {
    await it('maps server-archive to a derived store and delivery-only to state', async () => {
      // The ADR's table: an index the server can rebuild is `derived`; a store that holds the
      // only copy of delivered messages is `state` and must be backed up.
      expect(storeTierFor('server-archive')).toBe('derived');
      expect(storeTierFor('delivery-only')).toBe('state');
    });

    await it('isMailBackend narrows on the driver kind, not on the name', async () => {
      const base = { manifest: manifest({ name: 'mail' }), listAccounts: async () => [] };
      expect(isMailBackend({ ...base, kind: 'mailbox' })).toBe(true);
      expect(isMailBackend({ ...base, kind: 'archive' })).toBe(false);
    });
  });
};
