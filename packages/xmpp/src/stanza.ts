// xmpp.js ships no types; the declarations must reach every program that bundles this package.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./xmpp-js.d.ts" />
/**
 * The XMPP grammar postbote reads — parsers and request builders, pure.
 *
 * Parsers take a structural `XmlElement`, which xmpp.js's (ltx) elements satisfy and which a
 * test gets by parsing a synthetic stanza. Builders return xmpp.js elements. No socket code here:
 * `client.ts` sends what is built here and hands back what arrived.
 */

import xml from '@xmpp/xml';

/** The slice of an ltx element the parsers read. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string | undefined>;
  getChild(name: string, xmlns?: string): XmlElement | undefined;
  getChildren(name: string, xmlns?: string): XmlElement[];
  getChildText(name: string, xmlns?: string): string | null;
  text(): string;
}

export const NS = {
  mam: 'urn:xmpp:mam:2',
  rsm: 'http://jabber.org/protocol/rsm',
  forward: 'urn:xmpp:forward:0',
  delay: 'urn:xmpp:delay',
  data: 'jabber:x:data',
  roster: 'jabber:iq:roster',
  discoInfo: 'http://jabber.org/protocol/disco#info',
  pubsub: 'http://jabber.org/protocol/pubsub',
  bookmarks: 'urn:xmpp:bookmarks:1',
  privateStorage: 'jabber:iq:private',
  legacyBookmarks: 'storage:bookmarks',
  client: 'jabber:client',
  correct: 'urn:xmpp:message-correct:0',
  retract: 'urn:xmpp:message-retract:1',
  retractLegacy: 'urn:xmpp:message-retract:0',
  fasten: 'urn:xmpp:fasten:0',
  moderate: 'urn:xmpp:message-moderate:1',
  moderateLegacy: 'urn:xmpp:message-moderate:0',
  sid: 'urn:xmpp:sid:0',
  oob: 'jabber:x:oob',
  reply: 'urn:xmpp:reply:0',
  mucUser: 'http://jabber.org/protocol/muc#user',
  omemoLegacy: 'eu.siacs.conversations.axolotl',
  omemo: 'urn:xmpp:omemo:2',
  openpgp: 'urn:xmpp:openpgp:0',
  pgpLegacy: 'jabber:x:encrypted',
} as const;

// ── JIDs ────────────────────────────────────────────────────────────────

/** The bare JID, lowercased in its local part and domain (the resource is dropped). */
export function bareJid(jid: string): string {
  return jid.split('/')[0].toLowerCase();
}

/** The resource of a full JID — a MUC occupant's nick — or null. */
export function resourceOf(jid: string): string | null {
  const slash = jid.indexOf('/');
  return slash === -1 ? null : jid.slice(slash + 1);
}

/** The domain of a JID. */
export function domainOf(jid: string): string {
  const bare = bareJid(jid);
  const at = bare.indexOf('@');
  return at === -1 ? bare : bare.slice(at + 1);
}

// ── roster, bookmarks, disco ────────────────────────────────────────────

export interface RosterItem {
  jid: string;
  name: string | null;
  subscription: string;
}

/** The items of a roster result (`<query xmlns='jabber:iq:roster'>`). */
export function parseRoster(query: XmlElement | undefined): RosterItem[] {
  if (!query) return [];
  const items: RosterItem[] = [];
  for (const item of query.getChildren('item')) {
    const jid = item.attrs.jid;
    const subscription = item.attrs.subscription ?? 'none';
    if (!jid || subscription === 'remove') continue;
    items.push({ jid: bareJid(jid), name: item.attrs.name?.trim() || null, subscription });
  }
  return items;
}

export interface Bookmark {
  /** The room's bare JID. */
  jid: string;
  name: string | null;
  /** The user's nick in the room, when the bookmark names one. */
  nick: string | null;
  /** Joined on login: the rooms the user is "in". */
  autojoin: boolean;
}

const truthy = (value: string | undefined): boolean => value === 'true' || value === '1';

/** PEP Native Bookmarks (XEP-0402): `<pubsub><items node='urn:xmpp:bookmarks:1'>`. */
export function parseBookmarks(pubsub: XmlElement | undefined): Bookmark[] {
  const items = pubsub?.getChild('items');
  if (!items) return [];
  const bookmarks: Bookmark[] = [];
  for (const item of items.getChildren('item')) {
    const conference = item.getChild('conference', NS.bookmarks);
    if (!item.attrs.id || !conference) continue;
    bookmarks.push({
      jid: bareJid(item.attrs.id),
      name: conference.attrs.name?.trim() || null,
      nick: conference.getChildText('nick')?.trim() || null,
      autojoin: truthy(conference.attrs.autojoin),
    });
  }
  return bookmarks;
}

/** Legacy bookmarks in private XML storage (XEP-0048 / XEP-0049): `<storage xmlns='storage:bookmarks'>`. */
export function parseLegacyBookmarks(storage: XmlElement | undefined): Bookmark[] {
  if (!storage) return [];
  const bookmarks: Bookmark[] = [];
  for (const conference of storage.getChildren('conference')) {
    if (!conference.attrs.jid) continue;
    bookmarks.push({
      jid: bareJid(conference.attrs.jid),
      name: conference.attrs.name?.trim() || null,
      nick: conference.getChildText('nick')?.trim() || null,
      autojoin: truthy(conference.attrs.autojoin),
    });
  }
  return bookmarks;
}

/** The feature namespaces of a disco#info result. */
export function parseDiscoFeatures(query: XmlElement | undefined): Set<string> {
  const features = new Set<string>();
  for (const feature of query?.getChildren('feature') ?? []) {
    if (feature.attrs.var) features.add(feature.attrs.var);
  }
  return features;
}

export const rosterQuery = () => xml('query', { xmlns: NS.roster });
export const discoInfoQuery = () => xml('query', { xmlns: NS.discoInfo });
export const bookmarksQuery = () => xml('pubsub', { xmlns: NS.pubsub }, xml('items', { node: NS.bookmarks }));
export const legacyBookmarksQuery = () =>
  xml('query', { xmlns: NS.privateStorage }, xml('storage', { xmlns: NS.legacyBookmarks }));

// ── MAM ─────────────────────────────────────────────────────────────────

export interface MamRequest {
  queryId: string;
  /** Only the conversation with this JID (the user's own archive). */
  with?: string;
  /** Only entries at or after this time (ISO 8601). */
  start?: string;
  /** RSM: the page after this archive id (walking forward). */
  after?: string;
  /** RSM: the page before this archive id; the empty string asks for the LAST page. */
  before?: string;
  max: number;
}

function field(name: string, value: string) {
  return xml('field', { var: name }, xml('value', {}, value));
}

/** `<query xmlns='urn:xmpp:mam:2'>` with its data form and result set (XEP-0313, XEP-0059). */
export function mamQuery(request: MamRequest) {
  const fields = [
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS.mam)),
    ...(request.with ? [field('with', request.with)] : []),
    ...(request.start ? [field('start', request.start)] : []),
  ];
  const set = xml(
    'set',
    { xmlns: NS.rsm },
    xml('max', {}, String(request.max)),
    ...(request.after !== undefined ? [xml('after', {}, request.after)] : []),
    ...(request.before !== undefined ? [xml('before', {}, request.before)] : []),
  );
  return xml(
    'query',
    { xmlns: NS.mam, queryid: request.queryId },
    xml('x', { xmlns: NS.data, type: 'submit' }, ...fields),
    set,
  );
}

export interface MamFin {
  /** The server says this page is the last one in the direction asked. */
  complete: boolean;
  first: string | null;
  last: string | null;
}

/** The `<fin/>` that ends a MAM query. */
export function parseFin(fin: XmlElement | undefined): MamFin {
  const set = fin?.getChild('set', NS.rsm);
  return {
    complete: truthy(fin?.attrs.complete),
    first: set?.getChildText('first') ?? null,
    last: set?.getChildText('last') ?? null,
  };
}

/** One archived stanza, reduced to what the index needs. */
export interface ArchivedEntry {
  /** The archive's id for it — for a MUC archive also the room's stanza-id. */
  archiveId: string;
  /** Archive time in ms since the epoch, or null when the result carried no delay stamp. */
  stampMs: number | null;
  from: string | null;
  to: string | null;
  type: string | null;
  /** The sender's own stanza id and origin-id (XEP-0359): what 1:1 corrections reference. */
  id: string | null;
  originId: string | null;
  body: string | null;
  /** XEP-0308: the id of the message this one corrects. */
  replaceId: string | null;
  /** XEP-0424 / XEP-0425: the message this one retracts, and whether a moderator did. */
  retract: { id: string; moderated: boolean } | null;
  /** The archive holds only a tombstone where a retracted message was. */
  tombstone: boolean;
  /** Out-of-band URLs (XEP-0066) — what HTTP upload attachments are. */
  attachmentUrls: string[];
  /** XEP-0461: the id of the message this one replies to. */
  replyToId: string | null;
  /** OMEMO / OpenPGP payload: the body is only the sender's fallback text. */
  encrypted: boolean;
  /** A MUC occupant's real JID, where the room discloses it. */
  occupantJid: string | null;
}

function retractOf(message: XmlElement): ArchivedEntry['retract'] {
  const retract = message.getChild('retract', NS.retract);
  if (retract?.attrs.id) {
    return { id: retract.attrs.id, moderated: retract.getChild('moderated', NS.moderate) !== undefined };
  }
  // The pre-2023 form: <apply-to xmlns='urn:xmpp:fasten:0' id='…'> with a retract or a
  // moderation inside.
  const applyTo = message.getChild('apply-to', NS.fasten);
  if (applyTo?.attrs.id) {
    if (applyTo.getChild('retract', NS.retractLegacy)) return { id: applyTo.attrs.id, moderated: false };
    const moderated = applyTo.getChild('moderated', NS.moderateLegacy);
    if (moderated?.getChild('retract', NS.retractLegacy)) return { id: applyTo.attrs.id, moderated: true };
  }
  return null;
}

function isTombstone(message: XmlElement): boolean {
  if (message.getChild('retracted', NS.retract)) return true;
  return (
    message.getChild('moderated', NS.moderateLegacy)?.getChild('retracted', NS.retractLegacy) !== undefined
  );
}

function stampOf(forwarded: XmlElement): number | null {
  const stamp = forwarded.getChild('delay', NS.delay)?.attrs.stamp;
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One `<message><result xmlns='urn:xmpp:mam:2' queryid='…' id='…'>` of the query `queryId`, or
 * null for any other stanza. `archive` is who must have sent it — the room for a MUC archive,
 * the user's own bare JID (or no `from`) for theirs — so a stranger cannot inject results.
 */
export function parseMamResult(
  stanza: XmlElement,
  queryId: string,
  archive: { jid: string; own: boolean },
): ArchivedEntry | null {
  if (stanza.name !== 'message') return null;
  const result = stanza.getChild('result', NS.mam);
  if (!result || result.attrs.queryid !== queryId || !result.attrs.id) return null;
  const sender = stanza.attrs.from ? bareJid(stanza.attrs.from) : null;
  if (archive.own ? sender !== null && sender !== archive.jid : sender !== archive.jid) return null;
  const forwarded = result.getChild('forwarded', NS.forward);
  const message = forwarded?.getChild('message', NS.client) ?? forwarded?.getChild('message');
  if (!forwarded || !message) return null;

  const oob = message.getChildren('x', NS.oob).flatMap((x) => {
    const url = x.getChildText('url')?.trim();
    return url ? [url] : [];
  });
  const occupant = message.getChild('x', NS.mucUser)?.getChild('item')?.attrs.jid;
  return {
    archiveId: result.attrs.id,
    stampMs: stampOf(forwarded),
    from: message.attrs.from ?? null,
    to: message.attrs.to ?? null,
    type: message.attrs.type ?? null,
    id: message.attrs.id ?? null,
    originId: message.getChild('origin-id', NS.sid)?.attrs.id ?? null,
    body: message.getChildText('body'),
    replaceId: message.getChild('replace', NS.correct)?.attrs.id ?? null,
    retract: retractOf(message),
    tombstone: isTombstone(message),
    attachmentUrls: oob,
    replyToId: message.getChild('reply', NS.reply)?.attrs.id ?? null,
    encrypted:
      message.getChild('encrypted', NS.omemoLegacy) !== undefined ||
      message.getChild('encrypted', NS.omemo) !== undefined ||
      message.getChild('openpgp', NS.openpgp) !== undefined ||
      message.getChild('x', NS.pgpLegacy) !== undefined,
    occupantJid: occupant ? bareJid(occupant) : null,
  };
}
