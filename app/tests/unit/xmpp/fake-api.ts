import parse from '@xmpp/xml/lib/parse.js';

import type {
  ArchivedEntry,
  Bookmark,
  ClientFactory,
  MamPage,
  MamQuery,
  RosterItem,
  XmppApi,
} from '@postbote/xmpp';
import { NS, parseMamResult, XmppQueryError } from '@postbote/xmpp';

/**
 * A scriptable XMPP server behind `XmppApi`: roster, bookmarks, disco features and MAM archives,
 * answered from synthetic stanzas. Entries are built as XML and run through `parseMamResult`, so
 * every test exercises the real parser too. All addresses are example.org / example.net.
 */

export const ME = 'me@example.org';
export const ANNA = 'anna@example.org';
export const BEN = 'ben@example.net';
export const ROOM = 'orga@rooms.example.org';

const QUERY = 'q1';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface EntrySpec {
  id: string;
  /** ISO time. */
  at: string;
  from: string;
  to?: string;
  body?: string;
  stanzaId?: string;
  type?: 'chat' | 'groupchat';
  /** Raw XML children added to the archived message. */
  extra?: string;
  occupantJid?: string;
}

/** The `<message><result>` wrapper an archive sends for one entry, as XML text. */
export function resultXml(spec: EntrySpec, archive: string, queryId = QUERY): string {
  const type = spec.type ?? (spec.from.startsWith(ROOM) ? 'groupchat' : 'chat');
  const occupant = spec.occupantJid
    ? `<x xmlns="${NS.mucUser}"><item affiliation="member" jid="${spec.occupantJid}/phone" role="participant"/></x>`
    : '';
  return (
    `<message xmlns="jabber:client" to="${ME}/postbote" from="${archive}">` +
    `<result xmlns="${NS.mam}" queryid="${queryId}" id="${spec.id}">` +
    `<forwarded xmlns="${NS.forward}"><delay xmlns="${NS.delay}" stamp="${spec.at}"/>` +
    `<message xmlns="jabber:client" from="${spec.from}" to="${spec.to ?? ME}" type="${type}"` +
    `${spec.stanzaId ? ` id="${spec.stanzaId}"` : ''}>` +
    (spec.body !== undefined ? `<body>${escape(spec.body)}</body>` : '') +
    (spec.extra ?? '') +
    occupant +
    `</message></forwarded></result></message>`
  );
}

export function entry(spec: EntrySpec, archive = ME): ArchivedEntry {
  const parsed = parseMamResult(parse(resultXml(spec, archive)), QUERY, {
    jid: archive,
    own: archive === ME,
  });
  if (!parsed) throw new Error(`fixture did not parse: ${spec.id}`);
  return parsed;
}

export interface FakeServer {
  roster: RosterItem[];
  bookmarks: Bookmark[];
  features: Set<string>;
  /** The user's own archive (every direct chat), oldest first. */
  own: ArchivedEntry[];
  /** Room archives by room JID; a room missing here answers `forbidden`. */
  rooms: Map<string, ArchivedEntry[]>;
  /** Every MAM query asked, for assertions on what went over the wire. */
  queries: MamQuery[];
  closed: number;
}

export function fakeServer(partial: Partial<FakeServer> = {}): FakeServer {
  return {
    roster: [],
    bookmarks: [],
    features: new Set([NS.mam]),
    own: [],
    rooms: new Map(),
    queries: [],
    closed: 0,
    ...partial,
  };
}

function withJid(entry: ArchivedEntry, jid: string): boolean {
  const from = entry.from?.split('/')[0].toLowerCase();
  return from === jid || (from === ME && entry.to === jid);
}

/** MAM semantics over an array: RSM after/before, start, max; results always oldest first. */
function answer(all: readonly ArchivedEntry[], query: MamQuery): MamPage {
  let entries = [...all];
  if (query.with) entries = entries.filter((e) => withJid(e, query.with ?? ''));
  if (query.start) {
    const start = Date.parse(query.start);
    entries = entries.filter((e) => (e.stampMs ?? 0) >= start);
  }
  if (query.after !== undefined) {
    const at = entries.findIndex((e) => e.archiveId === query.after);
    if (at === -1) throw new XmppQueryError('item-not-found');
    const rest = entries.slice(at + 1);
    return { entries: rest.slice(0, query.max), complete: rest.length <= query.max };
  }
  if (query.before !== undefined) {
    const end = query.before === '' ? entries.length : entries.findIndex((e) => e.archiveId === query.before);
    if (end === -1) throw new XmppQueryError('item-not-found');
    const older = entries.slice(0, end);
    return { entries: older.slice(-query.max), complete: older.length <= query.max };
  }
  return { entries: entries.slice(0, query.max), complete: entries.length <= query.max };
}

export function fakeApi(server: FakeServer): XmppApi {
  return {
    jid: ME,
    roster: async () => server.roster,
    bookmarks: async () => server.bookmarks,
    features: async (jid) => (jid === ME ? server.features : new Set()),
    mam: async (query) => {
      server.queries.push(query);
      if (query.archive === null) return answer(server.own, query);
      const room = server.rooms.get(query.archive);
      if (!room) throw new XmppQueryError('forbidden');
      return answer(room, query);
    },
    close: async () => {
      server.closed++;
    },
  };
}

/** A client factory over the fake; `password` is the one it accepts. */
export function fakeFactory(
  server: FakeServer,
  password = 'correct horse',
): ClientFactory & { logins: number } {
  const factory = (async (options) => {
    factory.logins++;
    if (options.login.password !== password) {
      throw new Error(
        `the server refused the login for ${options.login.jid} (not-authorized) — check the address and password`,
      );
    }
    return fakeApi(server);
  }) as ClientFactory & { logins: number };
  factory.logins = 0;
  return factory;
}
