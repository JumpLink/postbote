/**
 * Where to connect, and whether that is allowed — pure policy plus the discovery lookups.
 *
 * Preference (encryption from the first byte first):
 *   1. Direct TLS (XEP-0368): SRV `_xmpps-client._tcp.<domain>`, `xmpps://host:port`.
 *   2. WebSocket (RFC 7395) over TLS, found through `/.well-known/host-meta.json` (XEP-0156).
 *   3. STARTTLS: SRV `_xmpp-client._tcp.<domain>`, else `<domain>:5222`.
 *
 * On GJS with gjsify 0.49.0 only (2) works — see `TLS_SOCKET_GAP`.
 *
 * The certificate is always checked against the XMPP DOMAIN (sent as SNI), not against the host
 * an SRV record points to: that is what XEP-0368 and RFC 6120 §13.7.2 require, and it is what
 * keeps a forged SRV answer from redirecting the login to someone else's certificate.
 *
 * Unencrypted transport is allowed only to a loopback address (a local test server, a local
 * proxy) — and even there no password is sent in the clear (`client.ts` refuses PLAIN).
 */

export type EndpointKind = 'direct-tls' | 'websocket' | 'starttls';

export interface Endpoint {
  kind: EndpointKind;
  /** What xmpp.js connects to: `xmpps://…`, `wss://…`/`ws://…`, `xmpp://…`. */
  uri: string;
  host: string;
  port: number;
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * A server address the user typed (`accounts add xmpp`): `xmpps://host[:port]` (direct TLS),
 * `wss://host/path` (WebSocket), `xmpp://host[:port]` (STARTTLS), or a bare `host[:port]`,
 * read as direct TLS. `ws://` only to a loopback address.
 */
export function parseService(service: string): Endpoint {
  const raw = service.trim();
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `xmpps://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`not a server address: ${JSON.stringify(service)} — e.g. xmpps://xmpp.example.org:5223`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error(`the server address has no host: ${JSON.stringify(service)}`);
  switch (url.protocol) {
    case 'xmpps:': {
      const port = Number(url.port) || 5223;
      return { kind: 'direct-tls', uri: `xmpps://${formatHost(host)}:${port}`, host, port };
    }
    case 'xmpp:': {
      const port = Number(url.port) || 5222;
      return { kind: 'starttls', uri: `xmpp://${formatHost(host)}:${port}`, host, port };
    }
    case 'wss:':
    case 'ws:': {
      if (url.protocol === 'ws:' && !isLoopback(host)) {
        throw new Error(
          `refusing unencrypted ws:// to ${host} — use wss:// (ws:// is accepted only for a loopback address)`,
        );
      }
      const port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
      return { kind: 'websocket', uri: url.toString(), host, port };
    }
    default:
      throw new Error(`unsupported server address scheme ${url.protocol} — use xmpps://, wss:// or xmpp://`);
  }
}

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

/** What discovery needs from the outside world — injected so the order is testable. */
export interface DiscoveryDeps {
  /** DNS SRV lookup; resolves to [] (or rejects) when there is no record. */
  resolveSrv(name: string): Promise<SrvRecord[]>;
  /** GET a JSON document over HTTPS; resolves to null when there is none. */
  fetchJson(url: string): Promise<unknown>;
}

function sortSrv(records: readonly SrvRecord[]): SrvRecord[] {
  // RFC 2782: "." as the only target means the service is decidedly not available.
  return records
    .filter((r) => r.name && r.name !== '.')
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

async function srv(deps: DiscoveryDeps, name: string): Promise<SrvRecord[]> {
  try {
    return sortSrv(await deps.resolveSrv(name));
  } catch {
    return [];
  }
}

/** WebSocket endpoints from XEP-0156's JSON host-meta. Only `wss://` counts. */
export function websocketLinks(hostMeta: unknown): string[] {
  const links = (hostMeta as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return [];
  return links
    .filter(
      (l): l is { rel: string; href: string } =>
        typeof l?.rel === 'string' &&
        typeof l?.href === 'string' &&
        l.rel === 'urn:xmpp:alt-connections:websocket',
    )
    .map((l) => l.href)
    .filter((href) => href.startsWith('wss://'));
}

/** Every way to reach `domain`, most preferred first. */
export async function discoverEndpoints(domain: string, deps: DiscoveryDeps): Promise<Endpoint[]> {
  const [direct, hostMeta, starttls] = await Promise.all([
    srv(deps, `_xmpps-client._tcp.${domain}`),
    deps.fetchJson(`https://${domain}/.well-known/host-meta.json`).catch(() => null),
    srv(deps, `_xmpp-client._tcp.${domain}`),
  ]);
  const endpoints: Endpoint[] = [
    ...direct.map((r) => parseService(`xmpps://${formatHost(r.name.replace(/\.$/, ''))}:${r.port}`)),
    ...websocketLinks(hostMeta).map((href) => parseService(href)),
    ...starttls.map((r) => parseService(`xmpp://${formatHost(r.name.replace(/\.$/, ''))}:${r.port}`)),
  ];
  // RFC 6120 §3.2.2: no SRV record at all — try the domain itself on the default port.
  if (direct.length === 0 && starttls.length === 0) endpoints.push(parseService(`xmpp://${domain}:5222`));
  const seen = new Set<string>();
  return endpoints.filter((e) => !seen.has(e.uri) && seen.add(e.uri));
}

/**
 * gjsify gap (unfixed, gjsify#1837): on 0.49.0 no raw TLS socket works — `tls.connect()` fails
 * its handshake with G_IO_ERROR_PENDING (the plain socket's own read is still in flight on the
 * stream TLS wants), measured against a local Prosody and a public HTTPS host alike, and
 * `tls.connect({ socket })` ignores the socket, so STARTTLS cannot work either. WebSocket
 * (Soup) is unaffected.
 */
export const TLS_SOCKET_GAP =
  'direct TLS and STARTTLS need a gjsify release with working TLS sockets (gjsify#1837, after 0.49.0)';

/**
 * Drop what the runtime cannot do: on GJS every raw-TLS endpoint until gjsify ships #1837. A
 * server that offers nothing else gets one clear error instead of a failed handshake per
 * endpoint.
 */
export function usableEndpoints(endpoints: readonly Endpoint[], canUseTlsSockets: boolean): Endpoint[] {
  const usable = canUseTlsSockets ? [...endpoints] : endpoints.filter((e) => e.kind === 'websocket');
  if (usable.length === 0 && endpoints.length > 0) {
    throw new Error(
      `the server offers no WebSocket endpoint (found ${endpoints.map((e) => e.uri).join(', ')}), and ${TLS_SOCKET_GAP} — ` +
        'give its WebSocket address (wss://…) with `postbote accounts add xmpp` if it has one',
    );
  }
  return usable;
}
