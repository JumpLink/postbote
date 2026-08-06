import { describe, expect, it } from '@gjsify/unit';

import {
  BODY_CHARS,
  capLimit,
  CONTACT_LIMIT,
  EVENT_LIMIT,
  MAIL_LIMIT,
} from '../../../src/core/actions/index.ts';

// These caps are the only thing standing between a broad query and a mailbox dump, so the
// boundaries are pinned rather than assumed. The lower bound is the interesting one: the CLI's
// `--limit` is a bare number, and an unclamped 0 would reach `.slice(0, 0)` and return nothing —
// which reads as "no results found", not as "you asked for none".
export default async () => {
  await describe('capLimit', async () => {
    await it('uses the default when nothing is given', async () => {
      expect(capLimit(undefined, MAIL_LIMIT)).toBe(MAIL_LIMIT.default);
      expect(capLimit(Number.NaN, MAIL_LIMIT)).toBe(MAIL_LIMIT.default);
      expect(capLimit(Number.POSITIVE_INFINITY, MAIL_LIMIT)).toBe(MAIL_LIMIT.default);
    });

    await it('passes a value through untouched inside the range', async () => {
      expect(capLimit(1, MAIL_LIMIT)).toBe(1);
      expect(capLimit(7, MAIL_LIMIT)).toBe(7);
      expect(capLimit(MAIL_LIMIT.max, MAIL_LIMIT)).toBe(MAIL_LIMIT.max);
    });

    await it('clamps above the max instead of rejecting', async () => {
      expect(capLimit(MAIL_LIMIT.max + 1, MAIL_LIMIT)).toBe(MAIL_LIMIT.max);
      expect(capLimit(10_000_000, MAIL_LIMIT)).toBe(MAIL_LIMIT.max);
    });

    await it('never yields a limit that would silently return nothing', async () => {
      expect(capLimit(0, MAIL_LIMIT)).toBe(1);
      expect(capLimit(-1, MAIL_LIMIT)).toBe(1);
      expect(capLimit(-10_000, MAIL_LIMIT)).toBe(1);
      // A fractional limit floors rather than reaching .slice() as e.g. 2.5.
      expect(capLimit(2.9, MAIL_LIMIT)).toBe(2);
      expect(capLimit(0.4, MAIL_LIMIT)).toBe(1);
    });
  });

  await describe('limit specs', async () => {
    await it('are internally coherent', async () => {
      for (const spec of [CONTACT_LIMIT, EVENT_LIMIT, MAIL_LIMIT, BODY_CHARS]) {
        expect(spec.default > 0).toBe(true);
        expect(spec.default <= spec.max).toBe(true);
        expect(Number.isInteger(spec.default)).toBe(true);
        expect(Number.isInteger(spec.max)).toBe(true);
      }
    });
  });
};
