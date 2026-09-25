/**
 * The slice of an XMPP connection postbote uses — and nothing else.
 *
 * The session and the backend work on this interface; `client.ts` implements it on xmpp.js, and
 * a test implements it with synthetic stanzas. Read-only by construction: nothing here sends a
 * message, a presence, a marker or a receipt. Every method is an IQ query the server answers
 * for the user's own account or a room's public archive.
 */

import type { ArchivedEntry, Bookmark, RosterItem } from './stanza.ts';

export interface MamQuery {
  /** The archive to ask: null for the user's own, else a room's bare JID. */
  archive: string | null;
  /** Only the conversation with this JID (the user's own archive). */
  with?: string;
  /** Only entries at or after this time (ISO 8601). */
  start?: string;
  /** The page after this archive id. */
  after?: string;
  /** The page before this archive id; the empty string asks for the newest page. */
  before?: string;
  max: number;
}

export interface MamPage {
  /** Oldest first. */
  entries: ArchivedEntry[];
  /** No further page in the direction asked. */
  complete: boolean;
}

/** An error the server answered a query with — `condition` is the RFC 6120 condition name. */
export class XmppQueryError extends Error {
  readonly condition: string;

  constructor(condition: string, message?: string) {
    super(message ?? `the server answered ${condition}`);
    this.name = 'XmppQueryError';
    this.condition = condition;
  }
}

export interface XmppApi {
  /** The user's own bare JID. */
  readonly jid: string;
  roster(): Promise<RosterItem[]>;
  /** PEP bookmarks (XEP-0402), else the legacy private-storage ones (XEP-0048). */
  bookmarks(): Promise<Bookmark[]>;
  /** disco#info features of an entity (the user's own account for MAM support). */
  features(jid: string): Promise<Set<string>>;
  mam(query: MamQuery): Promise<MamPage>;
  close(): Promise<void>;
}

/** What `postbote accounts add xmpp` asks for. */
export interface LoginPrompts {
  jid(): Promise<string>;
  password(): Promise<string>;
  /** Empty: discover the server from the JID's domain. */
  service(): Promise<string>;
  notify(message: string): void;
}
