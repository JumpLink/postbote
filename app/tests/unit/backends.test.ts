import { describe, expect, it, on } from '@gjsify/unit';

import { check, listAccounts, listEvents, listMailTargets, searchContacts } from '@postbote/gnome';
import { getMessage, searchMail } from '@postbote/imap';

// On Node both packages resolve to their "unavailable" stubs (GOA/EDS/Gio are GJS-only). These
// assert the graceful-degradation contract without needing GJS, GOA, EDS, a session bus, or any
// real (PII) data — and they are what keeps the two entry points' surfaces from drifting: a
// function exported by the GJS entry but missing from the Node one fails to import here.
// On GJS the real implementations are active (they would need a live session + real data), so
// this suite runs on Node only.
export default async () => {
  await on('Node.js', async () => {
    await describe('@postbote/gnome (Node stub)', async () => {
      await it('check() reports that the GJS runtime is required', async () => {
        const result = await check();
        expect(result.name).toBe('GNOME');
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/GJS runtime/i);
      });

      await it('data functions throw instead of returning empty results', async () => {
        await expect(listAccounts()).rejects.toThrow(/GJS runtime/i);
        await expect(searchContacts({})).rejects.toThrow(/GJS runtime/i);
        await expect(listEvents({ from: '2026-01-01', to: '2026-01-31' })).rejects.toThrow(/GJS runtime/i);
        await expect(listMailTargets()).rejects.toThrow(/GJS runtime/i);
      });
    });

    await describe('@postbote/imap (Node stub)', async () => {
      await it('mail functions throw instead of returning empty results', async () => {
        await expect(searchMail({})).rejects.toThrow(/GJS runtime/i);
        await expect(getMessage({ accountId: 'x', uid: '1' })).rejects.toThrow(/GJS runtime/i);
      });
    });
  });
};
