/**
 * The read-only gate: every HTTP request matrix-js-sdk makes for postbote goes through
 * `readOnlyFetch`, and anything that would change what other people see is refused before it
 * leaves the process.
 *
 * A client library does not know it is meant to be read-only. matrix-js-sdk marks the user
 * online on every `/sync` unless told otherwise (an omitted `set_presence` means `online`, per the
 * client-server spec), and one wrong call elsewhere could send a read receipt, a typing notice or
 * a message. Configuring the SDK right (`disablePresence`) is the first line; this allowlist is the
 * second, and it fails closed: a request that matches no rule is refused with an error that stops
 * the sync, instead of being sent.
 *
 * Allowed, besides every GET:
 *   - login/logout (the login flow and cleaning up a failed one)
 *   - creating the sync filter (server-side, private to the user)
 *   - the E2EE key protocol: uploading this device's keys, querying and claiming others', and
 *     to-device messages (room-key requests and Olm session repair). None of it is visible as
 *     content; without it the device could decrypt nothing.
 * GET `/sync` is allowed only with `set_presence=offline`.
 *
 * Pure: a function over (method, URL), so it is unit-tested on both runtimes.
 */

const CLIENT = String.raw`^/_matrix/client/(?:v3|r0|v1|unstable)`;

const ALLOWED: ReadonlyArray<{ method: string; path: RegExp; why: string }> = [
  { method: 'POST', path: new RegExp(`${CLIENT}/login$`), why: 'log in' },
  { method: 'POST', path: new RegExp(`${CLIENT}/logout$`), why: 'log a failed login out again' },
  { method: 'POST', path: new RegExp(`${CLIENT}/user/[^/]+/filter$`), why: 'the sync filter' },
  { method: 'POST', path: new RegExp(`${CLIENT}/keys/(?:upload|query|claim)$`), why: 'E2EE keys' },
  { method: 'PUT', path: new RegExp(`${CLIENT}/sendToDevice/[^/]+/[^/]+$`), why: 'E2EE to-device' },
];

/** Why a request is refused, or null when it may go out. */
export function refusal(method: string, url: string): string | null {
  const verb = method.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  const path = parsed.pathname;
  if (verb === 'GET' || verb === 'HEAD') {
    if (new RegExp(`${CLIENT}/sync$`).test(path) && parsed.searchParams.get('set_presence') !== 'offline') {
      return 'a /sync without set_presence=offline would mark the user online';
    }
    return null;
  }
  if (ALLOWED.some((rule) => rule.method === verb && rule.path.test(path))) return null;
  return `${verb} ${path} is not on postbote's read-only allowlist`;
}

export class ReadOnlyViolation extends Error {
  constructor(reason: string) {
    super(`postbote is read-only: refused to send ${reason}`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Every refusal of this process, for a caller (and a test) to prove the gate never tripped. */
export const refusals: string[] = [];

/** Wrap a fetch so it refuses every request `refusal` names. */
export function readOnlyFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const reason = refusal(method, url);
    if (reason) {
      refusals.push(reason);
      return Promise.reject(new ReadOnlyViolation(reason));
    }
    return inner(input, init);
  };
}
