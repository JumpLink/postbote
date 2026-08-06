/**
 * `postbote calendar` — list Evolution Data Server calendar events (CalDAV/local).
 */

import type { CommandModule } from 'yargs';

import { calendarListEvents, EVENT_LIMIT, EVENT_WINDOW_DAYS } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const calendarCommand: CommandModule = {
  command: 'calendar',
  describe: 'List calendar events in a date range (CalDAV/local)',
  builder: (yargs) =>
    yargs
      .option('from', { type: 'string', describe: 'Window start YYYY-MM-DD (default: today)' })
      .option('to', {
        type: 'string',
        describe: `Window end YYYY-MM-DD (default: +${EVENT_WINDOW_DAYS} days)`,
      })
      .option('limit', {
        type: 'number',
        describe: `Max events (default ${EVENT_LIMIT.default}, max ${EVENT_LIMIT.max})`,
      })
      .option('calendar', { type: 'string', describe: 'Restrict to a calendar source uid' })
      .option('account', { type: 'string', describe: 'Restrict to a GOA account id (from "accounts")' }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      calendarListEvents({
        from: pickArgv<string>(raw, 'from'),
        to: pickArgv<string>(raw, 'to'),
        limit: pickArgv<number>(raw, 'limit'),
        calendarUid: pickArgv<string>(raw, 'calendar'),
        accountId: pickArgv<string>(raw, 'account'),
      }),
    );
  },
};
