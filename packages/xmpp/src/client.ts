// xmpp.js ships no types; the declarations must reach every program that bundles this package.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./xmpp-js.d.ts" />
/**
 * The real client: xmpp.js composed from its parts, with only what a read-only archive reader
 * needs — the one file that touches the network, so the tests never do.
 *
 * Composed by hand instead of `@xmpp/client` because three of that bundle's defaults are wrong
 * here: it verifies the direct-TLS certificate against the SRV target instead of the XMPP
 * domain, it would upgrade a plain socket with a STARTTLS gjsify 0.49.0 cannot do, and it adds
 * SASL2/FAST/stream management whose state postbote would then have to keep.
 *
 * What goes over the wire, and what never does: the stream, SASL, resource binding, and IQ
 * queries (roster, bookmarks, disco, MAM). NO presence — so the server treats the session as
 * unavailable: no messages are routed to it, offline messages stay queued for the user's real
 * clients, and contacts see nothing. No chat markers, no receipts, no messages. The only
 * stanzas postbote answers are IQs the server sends it (ping), because RFC 6120 §8.2.3 requires
 * an answer to every IQ.
 */

import { Client, jid as makeJid } from '@xmpp/client-core';
import iqCallee from '@xmpp/iq/callee.js';
import iqCaller from '@xmpp/iq/caller.js';
import middleware from '@xmpp/middleware';
import resourceBinding from '@xmpp/resource-binding';
import sasl from '@xmpp/sasl';
import plain from '@xmpp/sasl-plain';
import scramSha1 from '@xmpp/sasl-scram-sha-1';
import streamFeatures from '@xmpp/stream-features';
import tcp from '@xmpp/tcp';
import ConnectionTLS from '@xmpp/tls/lib/Connection.js';
import TlsSocket from '@xmpp/tls/lib/Socket.js';
import websocket from '@xmpp/websocket';
import xml, { type Element } from '@xmpp/xml';
import SASLFactory from 'saslmechanisms';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { type MamPage, type MamQuery, type XmppApi, XmppQueryError } from './api.ts';
import {
  type DiscoveryDeps,
  discoverEndpoints,
  type Endpoint,
  chooseMechanism,
  parseService,
  TLS_SOCKET_GAP,
  usableEndpoints,
} from './transport.ts';
import {
  type ArchivedEntry,
  bareJid,
  bookmarksQuery,
  discoInfoQuery,
  domainOf,
  legacyBookmarksQuery,
  mamQuery,
  NS,
  parseBookmarks,
  parseDiscoFeatures,
  parseFin,
  parseLegacyBookmarks,
  parseMamResult,
  parseRoster,
  rosterQuery,
} from './stanza.ts';

export interface XmppLogin {
  /** The account's bare JID. */
  jid: string;
  password: string;
  /** The server address the user gave, or null to discover it from the domain. */
  service: string | null;
}

export interface ClientOptions {
  login: XmppLogin;
  /** A PEM file with an extra CA to trust (a self-hosted server with its own CA). */
  caFile: string | null;
}

/** Connect, authenticate and bind — resolves with a ready connection or rejects. */
export type ClientFactory = (options: ClientOptions) => Promise<XmppApi>;

const NS_TLS = 'urn:ietf:params:xml:ns:xmpp-tls';
const CONNECT_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2_000;

/** GJS exposes the legacy `imports` object; Node does not (the probe `app` uses as well). */
function onGjs(): boolean {
  return typeof (globalThis as { imports?: unknown }).imports !== 'undefined';
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Direct TLS whose certificate is checked against the XMPP domain (XEP-0368), not the host. */
function directTlsTransport(servername: string, ca: string | undefined): unknown {
  class DomainTlsSocket extends TlsSocket {
    override connect(params: Record<string, unknown>): void {
      this._attachSocket(
        tls.connect({ ...params, servername, ALPNProtocols: ['xmpp-client'], ...(ca ? { ca } : {}) }),
      );
    }
  }
  class Transport extends ConnectionTLS {}
  (Transport.prototype as unknown as { Socket: unknown }).Socket = DomainTlsSocket;
  return Transport;
}

/** The reason a query failed, as the RFC 6120 condition — never the stanza, which may quote data. */
function queryError(err: unknown): Error {
  const condition = (err as { condition?: unknown })?.condition;
  if (typeof condition === 'string') return new XmppQueryError(condition);
  return err instanceof Error ? err : new Error(String(err));
}

function loginError(err: unknown, jid: string): Error {
  const condition = (err as { condition?: unknown })?.condition;
  if (
    condition === 'not-authorized' ||
    condition === 'credentials-expired' ||
    condition === 'account-disabled'
  ) {
    return new Error(
      `the server refused the login for ${jid} (${condition}) — check the address and password`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

let queryCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(queryCounter++).toString(36)}`;

class XmppConnection implements XmppApi {
  readonly jid: string;
  private readonly entity: Client;
  private readonly iq: ReturnType<typeof iqCaller>;
  private closed = false;

  constructor(jid: string, entity: Client, iq: ReturnType<typeof iqCaller>) {
    this.jid = jid;
    this.entity = entity;
    this.iq = iq;
  }

  async roster() {
    try {
      return parseRoster(await this.iq.get(rosterQuery(), undefined, QUERY_TIMEOUT_MS));
    } catch (err) {
      throw queryError(err);
    }
  }

  async bookmarks() {
    try {
      return parseBookmarks(await this.iq.get(bookmarksQuery(), undefined, QUERY_TIMEOUT_MS));
    } catch {
      // No PEP bookmarks node: the older private-storage bookmarks, else none.
    }
    try {
      const query = await this.iq.get(legacyBookmarksQuery(), undefined, QUERY_TIMEOUT_MS);
      return parseLegacyBookmarks(query.getChild('storage', NS.legacyBookmarks));
    } catch {
      return [];
    }
  }

  async features(jid: string) {
    try {
      return parseDiscoFeatures(await this.iq.get(discoInfoQuery(), jid, QUERY_TIMEOUT_MS));
    } catch (err) {
      throw queryError(err);
    }
  }

  async mam(query: MamQuery): Promise<MamPage> {
    const queryId = nextId('mam');
    const own = query.archive === null;
    const archive = { jid: own ? this.jid : bareJid(query.archive ?? ''), own };
    const entries: ArchivedEntry[] = [];
    // Results arrive as <message> stanzas BEFORE the IQ result that ends the query, and xmpp.js
    // emits elements synchronously in arrival order: collected here, complete when it resolves.
    const onStanza = (stanza: Element) => {
      const entry = parseMamResult(stanza, queryId, archive);
      if (entry) entries.push(entry);
    };
    this.entity.on('stanza', onStanza);
    try {
      const iq = xml(
        'iq',
        { type: 'set', id: nextId('iq'), ...(own ? {} : { to: query.archive ?? undefined }) },
        mamQuery({ queryId, ...query }),
      );
      const result = await this.iq.request(iq, QUERY_TIMEOUT_MS);
      return { entries, complete: parseFin(result.getChild('fin', NS.mam)).complete };
    } catch (err) {
      throw queryError(err);
    } finally {
      this.entity.removeListener('stanza', onStanza);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Send </stream:stream> and give the server a moment to close its side.
      await withTimeout(
        this.entity._closeStream(CLOSE_TIMEOUT_MS),
        CLOSE_TIMEOUT_MS + 500,
        'closing the stream',
      );
    } catch {
      // A server that does not answer the close is gone either way.
    }
    destroySocket(this.entity);
  }
}

/**
 * Tear the socket down without a graceful TLS close.
 *
 * gjsify gap (unfixed, gjsify#1837): on 0.49.0 a TLS socket's `end()` never sends close_notify
 * and never emits 'close', so xmpp.js's `stop()` would wait forever on a direct-TLS connection.
 * The stream is closed above; destroying the socket afterwards loses nothing.
 */
function destroySocket(entity: Client): void {
  const socket = entity.socket;
  entity.removeAllListeners('stanza');
  if (!socket) return;
  try {
    if (socket.socket?.destroy) socket.socket.destroy();
    else if (socket.destroy) socket.destroy();
    else socket.end();
  } catch {
    // Already gone.
  }
}

async function connectEndpoint(
  endpoint: Endpoint,
  options: ClientOptions,
  ca: string | undefined,
): Promise<XmppApi> {
  const bare = bareJid(options.login.jid);
  const domain = domainOf(bare);
  const local = bare.slice(0, bare.indexOf('@'));
  const entity = new Client({ service: endpoint.uri, domain });
  entity.jid = makeJid(local, domain);
  let lastError: unknown = null;
  // An EventEmitter without an 'error' listener throws; xmpp.js reports socket trouble there.
  entity.on('error', (err: unknown) => {
    lastError = err;
  });

  if (endpoint.kind === 'direct-tls') entity.transports.push(directTlsTransport(domain, ca));
  else if (endpoint.kind === 'websocket') websocket({ entity });
  else tcp({ entity });

  const mw = middleware({ entity });
  const features = streamFeatures({ middleware: mw });
  const caller = iqCaller({ middleware: mw, entity });
  iqCallee({ middleware: mw, entity }).get('urn:xmpp:ping', 'ping', () => ({}));

  // Registration order is priority order: STARTTLS before SASL.
  features.use('starttls', NS_TLS, async ({ entity: e }, next) => {
    if (e.isSecure()) return next();
    // gjsify gap (unfixed, gjsify#1837): no tls.connect({ socket }) on 0.49.0. STARTTLS
    // endpoints are filtered out on GJS before connecting; this is the backstop.
    if (onGjs()) throw new Error(TLS_SOCKET_GAP);
    const answer = await e.sendReceive(xml('starttls', { xmlns: NS_TLS }));
    if (!answer.is('proceed', NS_TLS)) throw new Error('the server refused STARTTLS');
    const upgraded = new TlsSocket();
    upgraded.connect({ socket: e.socket, host: domain, servername: domain, ...(ca ? { ca } : {}) });
    await new Promise<void>((resolve, reject) => {
      upgraded.once('connect', () => resolve());
      upgraded.once('error', (err) => reject(err));
    });
    e._attachSocket(upgraded);
    await e.restart();
  });

  const factory = new SASLFactory();
  scramSha1(factory);
  plain(factory);
  sasl({ streamFeatures: features, saslFactory: factory }, async (authenticate, mechanisms, _fast, e) => {
    // A WebSocket to localhost counts as "secure" to xmpp.js; it is not encrypted, so decide
    // from the scheme.
    const encrypted = endpoint.kind === 'websocket' ? endpoint.uri.startsWith('wss:') : e.isSecure();
    const mechanism = chooseMechanism(mechanisms, { encrypted, host: endpoint.host });
    await authenticate({ username: local, password: options.login.password }, mechanism);
  });
  resourceBinding(
    { streamFeatures: features, iqCaller: caller },
    `postbote-${Math.random().toString(36).slice(2, 10)}`,
  );

  try {
    await withTimeout(entity.start(), CONNECT_TIMEOUT_MS, `connecting to ${endpoint.uri}`);
  } catch (err) {
    destroySocket(entity);
    throw loginError(lastError ?? err, bare);
  }
  return new XmppConnection(bare, entity, caller);
}

/** DNS SRV and the host-meta document, over whatever node:dns and fetch the runtime has. */
export const networkDiscovery: DiscoveryDeps = {
  async resolveSrv(name) {
    const dns = await import('node:dns/promises');
    return dns.resolveSrv(name);
  },
  async fetchJson(url) {
    const response = await withTimeout(fetch(url, { redirect: 'follow' }), 10_000, `fetching ${url}`);
    return response.ok ? response.json() : null;
  },
};

/** Candidate endpoints for a login, filtered by what this runtime can do. */
export async function endpointsFor(
  login: XmppLogin,
  discovery: DiscoveryDeps = networkDiscovery,
  canUseTlsSockets = !onGjs(),
): Promise<Endpoint[]> {
  const all = login.service
    ? [parseService(login.service)]
    : await discoverEndpoints(domainOf(login.jid), discovery);
  return usableEndpoints(all, canUseTlsSockets);
}

/**
 * Try each endpoint until one connects. A login refusal stops at once: the password is the
 * same on every endpoint, and retrying it elsewhere only multiplies failed-login counters.
 */
export const createXmppClient: ClientFactory = async (options) => {
  const ca = options.caFile ? readFileSync(options.caFile, 'utf8') : undefined;
  const endpoints = await endpointsFor(options.login);
  let failure: Error | null = null;
  for (const endpoint of endpoints) {
    try {
      return await connectEndpoint(endpoint, options, ca);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      if (/refused the login|refusing to log in|no login mechanism/.test(failure.message)) throw failure;
    }
  }
  throw failure ?? new Error(`no way to reach the server of ${options.login.jid}`);
};
