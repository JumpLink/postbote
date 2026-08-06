/**
 * Result caps for every action — ONE place, because they are asserted in three:
 * the action clamps, the MCP input schema declares `.max()`, and the CLI `--help` text
 * quotes them. Three hand-written copies of "100" is three chances to drift, and the one
 * that drifts is the schema, which then rejects a limit the action would happily serve.
 */

export interface LimitSpec {
  /** Applied when the caller passes nothing. */
  default: number;
  /** Hard ceiling — a larger request is clamped, never rejected. */
  max: number;
}

export const CONTACT_LIMIT: LimitSpec = { default: 20, max: 100 };
export const EVENT_LIMIT: LimitSpec = { default: 100, max: 500 };
export const MAIL_LIMIT: LimitSpec = { default: 20, max: 100 };
export const BODY_CHARS: LimitSpec = { default: 50_000, max: 200_000 };

/** Default calendar window when the caller gives neither `from` nor `to`. */
export const EVENT_WINDOW_DAYS = 31;

/**
 * Clamp a caller-supplied limit into a spec.
 *
 * The lower bound matters: MCP input schemas say `.positive()`, but the CLI's `--limit` is a
 * bare number, and a 0 or negative value would reach `.slice(0, n)` and silently return
 * nothing — indistinguishable from "no results". Non-integers are floored for the same reason.
 */
export function capLimit(value: number | undefined, spec: LimitSpec): number {
  if (value === undefined || !Number.isFinite(value)) return spec.default;
  return Math.max(1, Math.min(Math.floor(value), spec.max));
}
