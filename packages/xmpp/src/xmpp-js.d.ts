/**
 * Types for the slice of xmpp.js (ISC, untyped JavaScript) this package uses. Declared here
 * rather than as `any` so a call that does not exist fails the type check.
 */

declare module '@xmpp/xml' {
  /** Structurally the `XmlElement` of stanza.ts, plus what building and sending needs. */
  export interface Element {
    name: string;
    attrs: Record<string, string | undefined>;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string, xmlns?: string): Element[];
    getChildText(name: string, xmlns?: string): string | null;
    text(): string;
    children: Array<Element | string>;
    getChildElements(): Element[];
    is(name: string, xmlns?: string): boolean;
    toString(): string;
  }

  type Child = Element | string | null | undefined | false;
  function xml(
    name: string,
    attrs?: Record<string, string | undefined> | null,
    ...children: Child[]
  ): Element;
  export default xml;
}

declare module '@xmpp/xml/lib/parse.js' {
  import type { Element } from '@xmpp/xml';
  export default function parse(data: string): Element;
}

declare module '@xmpp/client-core' {
  import type { Element } from '@xmpp/xml';

  export class Client {
    constructor(options: { service: string; domain: string; timeout?: number });
    jid: unknown;
    options: { domain: string; service: string };
    status: string;
    transports: unknown[];
    socket: { secure?: boolean; end(): void; destroy?(): void; socket?: { destroy(): void } | null } | null;
    isSecure(): boolean;
    start(): Promise<unknown>;
    send(element: Element): Promise<void>;
    sendReceive(element: Element, timeout?: number): Promise<Element>;
    restart(): Promise<void>;
    _attachSocket(socket: unknown): void;
    _closeStream(timeout?: number): Promise<unknown>;
    on(event: string, listener: (...args: never[]) => void): this;
    removeListener(event: string, listener: (...args: never[]) => void): this;
    removeAllListeners(event?: string): this;
  }
  export function jid(local: string, domain: string): unknown;
  export { default as xml } from '@xmpp/xml';
}

declare module '@xmpp/middleware' {
  export default function middleware(deps: { entity: unknown }): unknown;
}

declare module '@xmpp/stream-features' {
  import type { Client } from '@xmpp/client-core';

  export interface StreamFeatures {
    use(
      name: string,
      xmlns: string,
      handler: (context: { entity: Client }, next: () => unknown, feature: unknown) => unknown,
    ): unknown;
  }
  export default function streamFeatures(deps: { middleware: unknown }): StreamFeatures;
}

declare module '@xmpp/iq/caller.js' {
  import type { Element } from '@xmpp/xml';
  export interface IqCaller {
    request(stanza: Element, timeout?: number): Promise<Element>;
    get(element: Element, to?: string, timeout?: number): Promise<Element>;
    set(element: Element, to?: string, timeout?: number): Promise<Element>;
  }
  export default function iqCaller(deps: { middleware: unknown; entity: unknown }): IqCaller;
}

declare module '@xmpp/iq/callee.js' {
  export interface IqCallee {
    get(xmlns: string, name: string, handler: () => unknown): void;
  }
  export default function iqCallee(deps: { middleware: unknown; entity: unknown }): IqCallee;
}

declare module '@xmpp/sasl' {
  import type { Client } from '@xmpp/client-core';
  import type { StreamFeatures } from '@xmpp/stream-features';
  export type Authenticate = (
    credentials: { username: string; password: string },
    mechanism: string,
  ) => Promise<void>;
  export default function sasl(
    deps: { streamFeatures: StreamFeatures; saslFactory: unknown },
    onAuthenticate: (
      authenticate: Authenticate,
      mechanisms: string[],
      fast: unknown,
      entity: Client,
    ) => Promise<void>,
  ): void;
}

declare module '@xmpp/sasl-scram-sha-1' {
  export default function scramSha1(factory: unknown): void;
}

declare module '@xmpp/sasl-plain' {
  export default function plain(factory: unknown): void;
}

declare module '@xmpp/resource-binding' {
  export default function resourceBinding(
    deps: { streamFeatures: unknown; iqCaller: unknown },
    resource?: string,
  ): void;
}

declare module '@xmpp/websocket' {
  export default function websocket(deps: { entity: unknown }): void;
}

declare module '@xmpp/tls/lib/Connection.js' {
  export default class ConnectionTLS {
    socketParameters(service: string): { host: string; port: number } | undefined;
  }
}

declare module '@xmpp/tls/lib/Socket.js' {
  export default class TlsSocket {
    secure: boolean;
    socket: { destroy(): void } | null;
    connect(options: Record<string, unknown>): void;
    _attachSocket(socket: unknown): void;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }
}

declare module '@xmpp/tcp' {
  export default function tcp(deps: { entity: unknown }): void;
}

declare module 'saslmechanisms' {
  export default class SASLFactory {}
}
