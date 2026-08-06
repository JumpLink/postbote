/**
 * Calendar actions — Evolution Data Server calendars (CalDAV/local).
 */

import { listEvents } from '@postbote/gnome';
import type { CalendarEventDTO } from '@postbote/protocol';
import { shiftDate, todayUtc } from '../lib/date.ts';
import { capLimit, EVENT_LIMIT, EVENT_WINDOW_DAYS } from './limits.ts';

/** Calendar listing params; `from`/`to` are optional and default to today..+31d. */
export interface CalendarListEventsParams {
  from?: string;
  to?: string;
  calendarUid?: string;
  accountId?: string;
  limit?: number;
}

/** List calendar events; defaults the window to today..+31d and caps the count. */
export async function calendarListEvents(params: CalendarListEventsParams = {}): Promise<CalendarEventDTO[]> {
  const from = params.from ?? todayUtc();
  return listEvents({
    from,
    to: params.to ?? shiftDate(from, EVENT_WINDOW_DAYS),
    calendarUid: params.calendarUid,
    accountId: params.accountId,
    limit: capLimit(params.limit, EVENT_LIMIT),
  });
}
