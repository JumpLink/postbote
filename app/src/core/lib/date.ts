/**
 * Small pure date helpers for the action layer.
 *
 * Deliberately NOT in @postbote/protocol: that package is RFC grammar, and a calendar window
 * default is application policy. `formatImapDate` lives there because the wire format IS the
 * protocol; this does not.
 */

/** Today as YYYY-MM-DD in UTC. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Shift a YYYY-MM-DD date by ±days, UTC-safe. Throws on an unparseable input rather than
 * returning "Invalid Date" downstream, where it would surface as a confusing IMAP/EDS error.
 */
export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
