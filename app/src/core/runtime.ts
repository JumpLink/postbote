/**
 * Runtime detection — pure, so it is testable on both runtimes.
 *
 * GJS exposes the legacy `imports` object as a global; Node does not. This is the same probe
 * the gjsify examples use, and it deliberately adds no dependency: the check has to work
 * inside a bundle that may be built for either target.
 */

/** True when running under GJS (as opposed to Node). */
export function isGjs(global: object = globalThis): boolean {
  return typeof (global as { imports?: unknown }).imports !== 'undefined';
}

/** Human-readable runtime name, for `postbote check` and error messages. */
export function runtimeName(global: object = globalThis): 'gjs' | 'node' {
  return isGjs(global) ? 'gjs' : 'node';
}
