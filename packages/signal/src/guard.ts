/**
 * Read-only through a gate, not through good intentions.
 *
 * Everything postbote could ever SEND to Signal passes through one function: the `fetch` of a
 * libsignal chat connection (an HTTP-shaped request over Signal's pinned WebSocket). Nothing else
 * in this package holds a chat connection's `fetch`: the link gets `guardedFetch('link', …)`, the
 * sync gets no fetch at all. This allowlist is what the gate lets through, and it is FAIL-CLOSED —
 * a request that is not named here is refused before it reaches libsignal.
 *
 * What a linked device must send, verified in Signal-Desktop (`ts/textsecure/AccountManager`,
 * `WebAPI`, `MessageReceiver`) and libsignal (`node/ts/net/Chat.ts`):
 *
 * - at link time: `PUT /v1/devices/link` (the device's password, registration id, encrypted name,
 *   signed and last-resort Kyber pre-keys) and `PUT /v2/keys?identity=aci` (one-time pre-keys; a
 *   device without them still receives, senders fall back to the last-resort key);
 * - during a sync: the acknowledgement of each delivered envelope (a WebSocket response, not a
 *   request — libsignal's `ChatServerMessageAck`; without it the server keeps the message and
 *   redelivers it), and libsignal's own keep-alives.
 *
 * What a linked device does NOT have to send, and postbote therefore never sends: delivery and
 * read receipts, typing indicators, sync requests to the phone (contacts, groups, configuration),
 * retry requests for undecryptable messages (`DecryptionErrorMessage`), profile or group fetches,
 * signed pre-key rotation and one-time key refills. Widen this list only with a test naming the
 * request and a reason in this comment.
 */

export type GatePhase = 'link' | 'sync';

export interface ChatRequestLike {
  verb: string;
  path: string;
  headers: ReadonlyArray<[string, string]>;
  body?: Uint8Array;
}

const ALLOWED: Record<GatePhase, ReadonlyArray<{ verb: string; path: RegExp; why: string }>> = {
  link: [
    { verb: 'PUT', path: /^\/v1\/devices\/link$/, why: 'register this device with the code the phone sent' },
    { verb: 'PUT', path: /^\/v2\/keys\?identity=aci$/, why: 'publish one-time pre-keys once' },
  ],
  sync: [],
};

export class ReadOnlyViolation extends Error {
  constructor(phase: GatePhase, request: ChatRequestLike) {
    super(`postbote is read-only: refused ${request.verb} ${request.path.split('?')[0]} during ${phase}`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Throws unless the request is on the allowlist of `phase`. */
export function checkRequest(phase: GatePhase, request: ChatRequestLike): void {
  const allowed = ALLOWED[phase].some((rule) => rule.verb === request.verb && rule.path.test(request.path));
  if (!allowed) throw new ReadOnlyViolation(phase, request);
}

export interface ChatResponseLike {
  status: number;
  message?: string;
  body?: Uint8Array;
}

export type ChatFetch = (request: ChatRequestLike) => Promise<ChatResponseLike>;

/** Wrap a connection's `fetch` in the gate. */
export function guardedFetch(phase: GatePhase, fetch: ChatFetch): ChatFetch {
  return async (request) => {
    checkRequest(phase, request);
    return fetch(request);
  };
}
