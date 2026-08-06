import { describe, expect, it } from '@gjsify/unit';

import { shiftDate, todayUtc } from '../../../src/core/lib/date.ts';

// The calendar window default runs through shiftDate, so a DST or month-end slip here would
// silently move the window a day. Both helpers take their clock as a parameter precisely so this
// can be asserted against fixed instants rather than "whatever today is".
export default async () => {
  await describe('shiftDate', async () => {
    await it('shifts forwards and backwards', async () => {
      expect(shiftDate('2026-08-06', 31)).toBe('2026-09-06');
      expect(shiftDate('2026-08-06', -6)).toBe('2026-07-31');
      expect(shiftDate('2026-08-06', 0)).toBe('2026-08-06');
    });

    await it('crosses month, year and leap-day boundaries', async () => {
      expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
      expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
      expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29'); // 2028 is a leap year
      expect(shiftDate('2027-02-28', 1)).toBe('2027-03-01'); // 2027 is not
    });

    await it('is UTC-based, so a local DST switch cannot move it', async () => {
      // Central European DST ends on 2026-10-25. A local-time implementation lands on 10-25 here.
      expect(shiftDate('2026-10-24', 2)).toBe('2026-10-26');
      expect(shiftDate('2026-03-28', 2)).toBe('2026-03-30'); // and starts on 2026-03-29
    });

    await it('throws on an unparseable date rather than yielding "Invalid Date"', async () => {
      expect(() => shiftDate('not-a-date', 1)).toThrow('Invalid date');
      expect(() => shiftDate('', 1)).toThrow('Invalid date');
    });
  });

  await describe('todayUtc', async () => {
    await it('formats an instant as YYYY-MM-DD in UTC', async () => {
      expect(todayUtc(new Date('2026-08-06T14:23:45.123Z'))).toBe('2026-08-06');
      // Late-evening UTC: a local-time implementation in CEST would already say the 7th.
      expect(todayUtc(new Date('2026-08-06T23:59:59Z'))).toBe('2026-08-06');
    });
  });
};
