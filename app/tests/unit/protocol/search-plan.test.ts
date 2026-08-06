import { describe, expect, it } from '@gjsify/unit';

import { buildSearchPlan, planHasLiterals, renderSearchPlan } from '@postbote/protocol';

export default async () => {
  await describe('buildSearchPlan', async () => {
    await it('falls back to ALL when nothing is asked for', async () => {
      const plan = buildSearchPlan();
      expect(renderSearchPlan(plan)).toBe('ALL');
      expect(plan.charset).toBe(null);
    });

    await it('quotes ASCII criteria onto the command line', async () => {
      expect(renderSearchPlan(buildSearchPlan({ from: 'berater@example.com' }))).toBe(
        'FROM "berater@example.com"',
      );
      expect(renderSearchPlan(buildSearchPlan({ subject: 'Invoice 2025' }))).toBe('SUBJECT "Invoice 2025"');
    });

    await it('escapes quotes and backslashes in a value', async () => {
      // Unescaped, the closing quote would end the argument early and the rest would be parsed
      // as further SEARCH keys — a syntax error at best, a different search at worst.
      expect(renderSearchPlan(buildSearchPlan({ subject: 'say "hi"' }))).toBe('SUBJECT "say \\"hi\\""');
      expect(renderSearchPlan(buildSearchPlan({ subject: 'a\\b' }))).toBe('SUBJECT "a\\\\b"');
    });

    await it('emits a fixed order regardless of the object literal', async () => {
      // Reproducible commands make failures diffable, and it puts the cheap flag/date narrowing
      // before the expensive full-text scan.
      const a = renderSearchPlan(buildSearchPlan({ text: 'x', unseen: true, since: '2025-01-01' }));
      const b = renderSearchPlan(buildSearchPlan({ since: '2025-01-01', text: 'x', unseen: true }));
      expect(a).toBe(b);
      expect(a).toBe('UNSEEN SENTSINCE 1-Jan-2025 TEXT "x"');
    });

    await it('uses SENTSINCE/SENTBEFORE for since/before — the Date header, not arrival', async () => {
      // After a mailbox migration every message's INTERNALDATE is the migration timestamp, so an
      // arrival filter returns everything or nothing. Arrival is available, but only on request.
      expect(renderSearchPlan(buildSearchPlan({ since: '2025-06-14' }))).toBe('SENTSINCE 14-Jun-2025');
      expect(renderSearchPlan(buildSearchPlan({ before: '2026-01-05' }))).toBe('SENTBEFORE 5-Jan-2026');
      expect(renderSearchPlan(buildSearchPlan({ receivedSince: '2025-06-14' }))).toBe('SINCE 14-Jun-2025');
      expect(renderSearchPlan(buildSearchPlan({ receivedBefore: '2025-06-14' }))).toBe('BEFORE 14-Jun-2025');
    });

    await it('rejects an unparseable date instead of searching the wrong window', async () => {
      expect(() => buildSearchPlan({ since: '14.06.2025' })).toThrow('invalid date');
    });

    await it('combines flags, dates and text', async () => {
      expect(
        renderSearchPlan(
          buildSearchPlan({ unseen: true, flagged: true, since: '2025-01-01', from: 'a@b.c', subject: 'Q1' }),
        ),
      ).toBe('UNSEEN FLAGGED SENTSINCE 1-Jan-2025 FROM "a@b.c" SUBJECT "Q1"');
    });

    await it('ignores blank and whitespace-only text criteria', async () => {
      // `search ""` must not become `TEXT ""`, which matches every message on some servers and
      // nothing on others.
      expect(renderSearchPlan(buildSearchPlan({ text: '', from: '   ' }))).toBe('ALL');
    });

    await it('emits HEADER for arbitrary header matches', async () => {
      expect(renderSearchPlan(buildSearchPlan({ header: [{ name: 'List-Id', value: 'announce' }] }))).toBe(
        'HEADER "List-Id" "announce"',
      );
    });
  });

  await describe('non-ASCII criteria', async () => {
    await it('sends a non-ASCII value as a literal and asks for UTF-8', async () => {
      const plan = buildSearchPlan({ subject: 'Grüße' });
      expect(plan.charset).toBe('UTF-8');
      expect(planHasLiterals(plan)).toBe(true);
      expect(plan.parts.length).toBe(2);
      expect(plan.parts[0]).toBe('SUBJECT ');
      expect(plan.parts[1]).toStrictEqual({ literal: 'Grüße' });
    });

    await it('leaves an all-ASCII plan on the fast path', async () => {
      const plan = buildSearchPlan({ subject: 'Gruesse', from: 'a@b.c' });
      expect(plan.charset).toBe(null);
      expect(planHasLiterals(plan)).toBe(false);
    });

    await it('supports MORE THAN ONE literal in one command', async () => {
      // The previous implementation hard-coded a single literal as the final TEXT argument, so
      // any second non-ASCII criterion was silently impossible.
      const plan = buildSearchPlan({ from: 'Müller', subject: 'Grüße', text: 'Straße' });
      expect(plan.parts.filter((p) => typeof p !== 'string').length).toBe(3);
      expect(plan.charset).toBe('UTF-8');
    });

    await it('mixes ASCII and non-ASCII criteria in one plan', async () => {
      const plan = buildSearchPlan({ unseen: true, from: 'a@b.c', subject: 'Grüße' });
      expect(plan.parts[0]).toBe('UNSEEN');
      expect(plan.parts[1]).toBe('FROM "a@b.c"');
      expect(plan.parts[2]).toBe('SUBJECT ');
      expect(plan.parts[3]).toStrictEqual({ literal: 'Grüße' });
    });

    await it('refuses to render a literal plan as a single line', async () => {
      // Rendering it away would produce a valid-looking SEARCH missing the very criterion the
      // caller asked for — a search that quietly ignores half its query.
      expect(() => renderSearchPlan(buildSearchPlan({ subject: 'Grüße' }))).toThrow('literals');
    });
  });
};
