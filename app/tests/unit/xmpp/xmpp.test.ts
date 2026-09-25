import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import parse from '@xmpp/xml/lib/parse.js';

import type { AccountPrompter, BackendContext } from '@postbote/protocol';
import { isChatBackend, validateManifest } from '@postbote/protocol';
import {
  chatConversationId,
  getConversation,
  listConversations,
  rebuildConversations,
  syncChats,
} from '@postbote/store';
import {
  accountIdFor,
  assignSeqs,
  buildPage,
  type ChatContext,
  discoverEndpoints,
  endpointsFor,
  mamQuery,
  NS,
  parseBookmarks,
  parseFin,
  parseLegacyBookmarks,
  parseMamResult,
  parseRoster,
  parseService,
  unresolvedReferences,
  usableEndpoints,
  windowEntries,
  websocketLinks,
  XMPP_MANIFEST,
  XmppBackend,
  XmppChatSession,
} from '@postbote/xmpp';
import { freshDb } from '../store/fixtures.ts';
import { ANNA, BEN, entry, fakeApi, fakeFactory, fakeServer, ME, resultXml, ROOM } from './fake-api.ts';

/**
 * The XMPP backend without a server: the stanza grammar, the mapping of archive entries into
 * pages (sequence numbers, corrections, retractions), transport policy, the session over a fake
 * archive, the login and what it leaves on disk, and a full sync into the conversation view.
 * All data is synthetic.
 */

const direct: ChatContext = { kind: 'direct', chatJid: ANNA, selfJid: ME, selfNick: null, name: 'Anna' };
const room: ChatContext = { kind: 'group', chatJid: ROOM, selfJid: ME, selfNick: 'me', name: 'Orga' };

const at = (minute: number, second = 0) =>
  `2026-01-10T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postbote-xmpp-'));
}

function context(dir: string, settings: BackendContext['settings'] = {}): BackendContext {
  return { settings, env: {}, secretsDir: join(dir, 'secrets', 'xmpp') };
}

function prompter(answers: string[]): AccountPrompter & { asked: string[]; notes: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    async ask(label, options) {
      asked.push(`${label}${options?.secret ? ' (secret)' : ''}`);
      const next = queue.shift();
      if (next === undefined) throw new Error('no answer left');
      return next;
    },
    notify: (message) => notes.push(message),
  };
}

async function rejects(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected a rejection');
}

export default async () => {
  await describe('XMPP manifest', async () => {
    await it('is a valid server-archive chat manifest with truthful capabilities', async () => {
      expect(validateManifest(XMPP_MANIFEST).length).toBe(0);
      expect(XMPP_MANIFEST.syncModel).toBe('server-archive');
      expect(XMPP_MANIFEST.addressKinds.join(',')).toBe('jid');
      expect(XMPP_MANIFEST.terms).toBe(null);
      const c = XMPP_MANIFEST.capabilities;
      expect(c.e2ee).toBe(false);
      expect(c.edits && c.reactions && c.readReceipts && c.groups && c.attachments).toBe(true);
      expect(c.subject || c.folders || c.threads).toBe(false);
    });
  });

  await describe('XMPP stanza grammar', async () => {
    await it('reads an archived direct message with its stamp, ids and body', async () => {
      const e = entry({
        id: 'a1',
        at: at(1),
        from: `${ANNA}/phone`,
        body: 'Hallo <du> & ich',
        stanzaId: 's1',
        extra: `<origin-id xmlns="${NS.sid}" id="o1"/>`,
      });
      expect(e.archiveId).toBe('a1');
      expect(e.stampMs).toBe(Date.parse(at(1)));
      expect(e.body).toBe('Hallo <du> & ich');
      expect(e.id).toBe('s1');
      expect(e.originId).toBe('o1');
      expect(e.to).toBe(ME);
      expect(e.encrypted).toBe(false);
    });

    await it('ignores results of another query and results a stranger sent', async () => {
      const xml = resultXml({ id: 'a1', at: at(1), from: ANNA, body: 'x' }, ME);
      expect(parseMamResult(parse(xml), 'other', { jid: ME, own: true })).toBe(null);
      const spoofed = resultXml({ id: 'a1', at: at(1), from: ANNA, body: 'x' }, 'mallory@example.net');
      expect(parseMamResult(parse(spoofed), 'q1', { jid: ME, own: true })).toBe(null);
      // A room archive must come from the room itself.
      const fromRoom = resultXml({ id: 'r1', at: at(1), from: `${ROOM}/anna`, body: 'x' }, ROOM);
      expect(parseMamResult(parse(fromRoom), 'q1', { jid: ROOM, own: false })?.archiveId).toBe('r1');
      expect(parseMamResult(parse(fromRoom), 'q1', { jid: 'other@rooms.example.org', own: false })).toBe(
        null,
      );
    });

    await it('reads corrections, both retraction forms, tombstones, OOB, replies and encryption', async () => {
      const correction = entry({
        id: 'a2',
        at: at(2),
        from: ANNA,
        body: 'fixed',
        extra: `<replace xmlns="${NS.correct}" id="s1"/>`,
      });
      expect(correction.replaceId).toBe('s1');
      const retract = entry({
        id: 'a3',
        at: at(3),
        from: ANNA,
        extra: `<retract xmlns="${NS.retract}" id="s1"/>`,
      });
      expect(retract.retract?.id).toBe('s1');
      expect(retract.retract?.moderated).toBe(false);
      const legacy = entry({
        id: 'a4',
        at: at(4),
        from: ANNA,
        extra: `<apply-to xmlns="${NS.fasten}" id="s1"><retract xmlns="${NS.retractLegacy}"/></apply-to>`,
      });
      expect(legacy.retract?.id).toBe('s1');
      const moderated = entry(
        {
          id: 'r5',
          at: at(5),
          from: ROOM,
          extra: `<retract xmlns="${NS.retract}" id="r1"><moderated xmlns="${NS.moderate}" by="${ROOM}/mod"/></retract>`,
        },
        ROOM,
      );
      expect(moderated.retract?.moderated).toBe(true);
      const tombstone = entry(
        {
          id: 'r6',
          at: at(6),
          from: `${ROOM}/anna`,
          extra: `<retracted xmlns="${NS.retract}" stamp="${at(7)}"/>`,
        },
        ROOM,
      );
      expect(tombstone.tombstone).toBe(true);
      const upload = entry({
        id: 'a7',
        at: at(7),
        from: ANNA,
        body: 'https://upload.example.org/x.jpg',
        extra: `<x xmlns="${NS.oob}"><url>https://upload.example.org/x.jpg</url></x><reply xmlns="${NS.reply}" to="${ANNA}" id="s1"/>`,
      });
      expect(upload.attachmentUrls.join()).toBe('https://upload.example.org/x.jpg');
      expect(upload.replyToId).toBe('s1');
      const omemo = entry({
        id: 'a8',
        at: at(8),
        from: ANNA,
        body: 'I sent you an OMEMO encrypted message',
        extra: `<encrypted xmlns="${NS.omemoLegacy}"><header sid="1"/></encrypted>`,
      });
      expect(omemo.encrypted).toBe(true);
    });

    await it('reads the roster, both bookmark forms and the fin', async () => {
      const roster = parseRoster(
        parse(
          `<query xmlns="${NS.roster}"><item jid="Anna@Example.org" name=" Anna " subscription="both"/>` +
            `<item jid="gone@example.org" subscription="remove"/><item jid="ben@example.net"/></query>`,
        ),
      );
      expect(roster.map((r) => `${r.jid}:${r.name}:${r.subscription}`).join()).toBe(
        'anna@example.org:Anna:both,ben@example.net:null:none',
      );
      const pep = parseBookmarks(
        parse(
          `<pubsub xmlns="${NS.pubsub}"><items node="${NS.bookmarks}"><item id="${ROOM}">` +
            `<conference xmlns="${NS.bookmarks}" name="Orga" autojoin="true"><nick>me</nick></conference></item></items></pubsub>`,
        ),
      );
      expect(pep[0].jid).toBe(ROOM);
      expect(pep[0].nick).toBe('me');
      expect(pep[0].autojoin).toBe(true);
      const legacy = parseLegacyBookmarks(
        parse(
          `<storage xmlns="${NS.legacyBookmarks}"><conference jid="${ROOM}" autojoin="1" name="Orga"/></storage>`,
        ),
      );
      expect(legacy[0].autojoin).toBe(true);
      expect(legacy[0].nick).toBe(null);
      const fin = parseFin(
        parse(
          `<fin xmlns="${NS.mam}" complete="true"><set xmlns="${NS.rsm}"><first>a</first><last>b</last></set></fin>`,
        ),
      );
      expect(fin.complete).toBe(true);
      expect(fin.last).toBe('b');
      expect(parseFin(parse(`<fin xmlns="${NS.mam}"/>`)).complete).toBe(false);
    });

    await it('builds a MAM query with its form and result set', async () => {
      const text = mamQuery({ queryId: 'q', with: ANNA, after: 'a9', max: 50 }).toString();
      expect(text.includes(`<value>${NS.mam}</value>`)).toBe(true);
      expect(text.includes(`<field var="with"><value>${ANNA}</value></field>`)).toBe(true);
      expect(text.includes('<max>50</max><after>a9</after>')).toBe(true);
      expect(mamQuery({ queryId: 'q', before: '', max: 1 }).toString().includes('<before/>')).toBe(true);
    });
  });

  await describe('XMPP page mapping', async () => {
    await it('orders by archive time and gives entries of one second their own numbers', async () => {
      const entries = [
        entry({ id: 'a', at: at(1), from: ANNA, body: '1' }),
        entry({ id: 'b', at: at(1), from: ANNA, body: '2' }),
        entry({ id: 'c', at: at(2), from: ANNA, body: '3' }),
      ];
      const t = Date.parse(at(1));
      expect(assignSeqs(entries, null).join()).toBe(`${t},${t + 1},${Date.parse(at(2))}`);
      // A walk that continues mid-second gives the same numbers as one that saw the whole second.
      expect(assignSeqs(entries.slice(1), t).join()).toBe(`${t + 1},${Date.parse(at(2))}`);
      // A window whose sentinel shares a millisecond with its first entries drops them.
      const ids = (r: { entries: Array<{ archiveId: string }> }) => r.entries.map((e) => e.archiveId).join();
      expect(ids(windowEntries(entries, 2, false))).toBe('c');
      // Sentinel in another millisecond: the whole window stays.
      expect(
        ids(
          windowEntries(
            entries.slice(1).concat(entry({ id: 'd', at: at(3), from: ANNA, body: '4' })),
            2,
            false,
          ),
        ),
      ).toBe('c,d');
      // The whole chat fits: nothing is cut.
      expect(windowEntries(entries, 3, true).reachedStart).toBe(true);
      expect(ids(windowEntries(entries, 3, true))).toBe('a,b,c');
      // A server that capped the page (fewer than asked, not complete) loses its first millisecond.
      expect(ids(windowEntries(entries, 10, false))).toBe('c');
    });

    await it('maps a direct chat: self, peer, attachments, replies, encrypted text withheld', async () => {
      const page = buildPage(
        direct,
        [
          entry({ id: 'a1', at: at(1), from: `${ANNA}/phone`, body: 'Kommst du?', stanzaId: 's1' }),
          entry({ id: 'a2', at: at(2), from: `${ME}/laptop`, to: ANNA, body: 'Ja', stanzaId: 's2' }),
          entry({
            id: 'a3',
            at: at(3),
            from: ANNA,
            body: 'https://upload.example.org/p.jpg',
            extra: `<x xmlns="${NS.oob}"><url>https://upload.example.org/p.jpg</url></x><reply xmlns="${NS.reply}" to="${ME}" id="s2"/>`,
          }),
          entry({
            id: 'a4',
            at: at(4),
            from: ANNA,
            body: 'fallback',
            extra: `<encrypted xmlns="${NS.omemo}"/>`,
          }),
          entry({
            id: 'a5',
            at: at(5),
            from: ANNA,
            extra: `<displayed xmlns="urn:xmpp:chat-markers:0" id="s2"/>`,
          }),
        ],
        { afterSeq: null, exhausted: true, reachedStart: true },
      );
      expect(page.messages.length).toBe(4);
      const [first, mine, upload, secret] = page.messages;
      expect(first.fromSelf).toBe(false);
      expect(first.sender?.addresses[0].value).toBe(ANNA);
      expect(first.sender?.displayName).toBe('Anna');
      expect(mine.fromSelf).toBe(true);
      expect(mine.sender).toBe(null);
      expect(upload.hasAttachments).toBe(true);
      expect(upload.replyToRemoteId).toBe('a2');
      expect(secret.text).toBe(null);
      // The marker is an archive entry, not a message — but the page covers it.
      expect(page.highestSeq).toBe(Date.parse(at(5)));
      expect(page.highestCursor).toBe('a5');
    });

    await it('applies a correction and a retraction inside the page, only from the author', async () => {
      const page = buildPage(
        direct,
        [
          entry({ id: 'a1', at: at(1), from: ANNA, body: 'Tipfehler', stanzaId: 's1' }),
          entry({
            id: 'a2',
            at: at(2),
            from: ANNA,
            body: 'Tippfehler',
            extra: `<replace xmlns="${NS.correct}" id="s1"/>`,
          }),
          entry({ id: 'a3', at: at(3), from: `${ME}/x`, to: ANNA, body: 'weg damit', stanzaId: 's3' }),
          entry({
            id: 'a4',
            at: at(4),
            from: `${ME}/x`,
            to: ANNA,
            extra: `<retract xmlns="${NS.retract}" id="s3"/>`,
          }),
          // Anna cannot rewrite what the user wrote.
          entry({
            id: 'a5',
            at: at(5),
            from: ANNA,
            body: 'hacked',
            extra: `<replace xmlns="${NS.correct}" id="s3"/>`,
          }),
        ],
        { afterSeq: null, exhausted: true, reachedStart: true },
      );
      expect(page.messages.map((m) => `${m.remoteId}:${m.text}`).join()).toBe('a1:Tippfehler');
      expect(page.messages[0].editedAt).toBe(at(2).replace('Z', '.000Z'));
      expect(page.edits?.length).toBe(0);
      expect(page.retracted?.length).toBe(0);
    });

    await it('turns references to older messages into edits and retractions, via the lookback', async () => {
      const older = [
        entry({ id: 'a1', at: at(1), from: ANNA, body: 'alt', stanzaId: 's1' }),
        entry({ id: 'a2', at: at(2), from: ANNA, body: 'auch alt', stanzaId: 's2' }),
      ];
      const entries = [
        entry({
          id: 'a3',
          at: at(3),
          from: ANNA,
          body: 'neu',
          extra: `<replace xmlns="${NS.correct}" id="s1"/>`,
        }),
        entry({ id: 'a4', at: at(4), from: ANNA, extra: `<retract xmlns="${NS.retract}" id="s2"/>` }),
      ];
      expect(unresolvedReferences(direct, entries).join()).toBe('s1,s2');
      const page = buildPage(
        direct,
        entries,
        { afterSeq: Date.parse(at(2)), exhausted: true, reachedStart: false },
        older,
      );
      expect(page.messages.length).toBe(0);
      expect(page.edits?.map((e) => `${e.remoteId}:${e.text}`).join()).toBe('a1:neu');
      expect(page.retracted?.join()).toBe('a2');
    });

    await it('maps a room: occupants, self by nick or real JID, moderation, tombstones', async () => {
      const page = buildPage(
        room,
        [
          entry(
            { id: 'r1', at: at(1), from: `${ROOM}/anna`, body: 'Wer bringt Salat?', occupantJid: ANNA },
            ROOM,
          ),
          entry({ id: 'r2', at: at(2), from: `${ROOM}/me`, body: 'Ich' }, ROOM),
          entry({ id: 'r3', at: at(3), from: `${ROOM}/troll`, body: 'Spam' }, ROOM),
          // Someone else cannot retract Anna's message …
          entry(
            { id: 'r4', at: at(4), from: `${ROOM}/troll`, extra: `<retract xmlns="${NS.retract}" id="r1"/>` },
            ROOM,
          ),
          // … the room's moderation can remove the troll's.
          entry(
            {
              id: 'r5',
              at: at(5),
              from: ROOM,
              extra: `<retract xmlns="${NS.retract}" id="r3"><moderated xmlns="${NS.moderate}" by="${ROOM}/mod"/></retract>`,
            },
            ROOM,
          ),
          entry(
            { id: 'r6', at: at(6), from: `${ROOM}/ben`, extra: `<retracted xmlns="${NS.retract}"/>` },
            ROOM,
          ),
        ],
        { afterSeq: null, exhausted: true, reachedStart: true },
      );
      expect(page.messages.map((m) => m.remoteId).join()).toBe('r1,r2');
      const [anna, me] = page.messages;
      expect(anna.sender?.remoteId).toBe(ANNA);
      expect(anna.sender?.displayName).toBe('anna');
      expect(anna.sender?.addresses[0].value).toBe(ANNA);
      expect(me.fromSelf).toBe(true);
      expect(page.retracted?.join()).toBe('r6');
      const other = buildPage(room, [entry({ id: 'r7', at: at(7), from: `${ROOM}/ben`, body: 'hi' }, ROOM)], {
        afterSeq: null,
        exhausted: true,
        reachedStart: true,
      });
      // A semi-anonymous room gives only the nick: no address, the occupant JID as id.
      expect(other.messages[0].sender?.addresses.length).toBe(0);
      expect(other.messages[0].sender?.remoteId).toBe(`${ROOM}/ben`);
    });
  });

  await describe('XMPP transport policy', async () => {
    await it('parses server addresses and refuses unencrypted ones off loopback', async () => {
      expect(parseService('xmpp.example.org').uri).toBe('xmpps://xmpp.example.org:5223');
      expect(parseService('xmpps://xmpp.example.org:443').port).toBe(443);
      expect(parseService('xmpp://xmpp.example.org').kind).toBe('starttls');
      expect(parseService('wss://example.org/xmpp-websocket').kind).toBe('websocket');
      expect(parseService('ws://localhost:5280/xmpp-websocket').kind).toBe('websocket');
      expect((await rejects(async () => parseService('ws://example.org/ws'))).includes('refusing')).toBe(
        true,
      );
      expect((await rejects(async () => parseService('http://example.org'))).includes('unsupported')).toBe(
        true,
      );
    });

    await it('discovers direct TLS, then WebSocket, then STARTTLS', async () => {
      const endpoints = await discoverEndpoints('example.org', {
        resolveSrv: async (name) =>
          name.startsWith('_xmpps-client')
            ? [
                { name: 'b.example.org', port: 443, priority: 10, weight: 0 },
                { name: 'a.example.org.', port: 5223, priority: 5, weight: 0 },
              ]
            : [{ name: 'c.example.org', port: 5222, priority: 5, weight: 0 }],
        fetchJson: async () => ({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://example.org/ws' },
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'ws://example.org/plain' },
          ],
        }),
      });
      expect(endpoints.map((e) => e.uri).join()).toBe(
        'xmpps://a.example.org:5223,xmpps://b.example.org:443,wss://example.org/ws,xmpp://c.example.org:5222',
      );
      const bare = await discoverEndpoints('example.org', {
        resolveSrv: async () => {
          throw new Error('ENOTFOUND');
        },
        fetchJson: async () => null,
      });
      expect(bare.map((e) => e.uri).join()).toBe('xmpp://example.org:5222');
      expect(websocketLinks({ links: 'nope' }).length).toBe(0);
    });

    await it('keeps only WebSocket where TLS sockets do not work, with a clear error when nothing is left', async () => {
      const all = [
        parseService('xmpps://a.example.org'),
        parseService('wss://a.example.org/ws'),
        parseService('xmpp://a.example.org'),
      ];
      expect(
        usableEndpoints(all, false)
          .map((e) => e.kind)
          .join(),
      ).toBe('websocket');
      expect(usableEndpoints(all, true).length).toBe(3);
      const message = await rejects(async () =>
        usableEndpoints([parseService('xmpps://a.example.org'), parseService('xmpp://a.example.org')], false),
      );
      expect(message.includes('gjsify#1837')).toBe(true);
      expect(message.includes('wss://')).toBe(true);
      const configured = await endpointsFor(
        { jid: ANNA, password: 'x', service: 'wss://example.org/ws' },
        { resolveSrv: async () => [], fetchJson: async () => null },
        false,
      );
      expect(configured[0].uri).toBe('wss://example.org/ws');
    });
  });

  await describe('XmppChatSession', async () => {
    await it('lists roster contacts and joined rooms, newest first, rooms without archive included', async () => {
      const server = fakeServer({
        roster: [
          { jid: ANNA, name: 'Anna', subscription: 'both' },
          { jid: BEN, name: null, subscription: 'to' },
          { jid: 'gateway.example.org', name: null, subscription: 'both' },
          { jid: ME, name: null, subscription: 'both' },
        ],
        bookmarks: [
          { jid: ROOM, name: 'Orga', nick: 'me', autojoin: true },
          { jid: 'closed@rooms.example.org', name: 'Closed', nick: 'me', autojoin: true },
          { jid: 'old@rooms.example.org', name: 'Old', nick: 'me', autojoin: false },
        ],
        own: [
          entry({ id: 'a1', at: at(1), from: ANNA, body: 'x' }),
          entry({ id: 'a2', at: at(9), from: BEN, body: 'y' }),
        ],
        rooms: new Map([[ROOM, [entry({ id: 'r1', at: at(5), from: `${ROOM}/anna`, body: 'z' }, ROOM)]]]),
      });
      const session = new XmppChatSession(fakeApi(server));
      const chats = await session.listChats();
      expect(chats.map((c) => `${c.remoteId}:${c.kind}:${c.lastCursor}`).join()).toBe(
        `${BEN}:direct:a2,${ROOM}:group:r1,${ANNA}:direct:a1,closed@rooms.example.org:group:null`,
      );
      expect(chats[0].title).toBe(BEN);
      const closed = await session.fetchHistory('closed@rooms.example.org', null, 50);
      expect(closed.messages.length).toBe(0);
      // Only archive queries went out — no presence, no markers (there is no API for them).
      expect(server.queries.every((q) => q.max === 1 && q.before === '')).toBe(true);
    });

    await it('takes a window, walks forward by archive id, and resumes by time when the id expired', async () => {
      const server = fakeServer({
        roster: [{ jid: ANNA, name: 'Anna', subscription: 'both' }],
        own: [1, 2, 3, 4, 5].map((n) => entry({ id: `a${n}`, at: at(n), from: ANNA, body: `m${n}` })),
      });
      const session = new XmppChatSession(fakeApi(server));
      await session.listChats();
      const window = await session.fetchHistory(ANNA, null, 3);
      expect(window.messages.map((m) => m.text).join()).toBe('m3,m4,m5');
      expect(window.reachedStart).toBe(false);
      server.own.push(entry({ id: 'a6', at: at(6), from: ANNA, body: 'm6' }));
      const next = await session.fetchHistory(ANNA, window.highestSeq, 10, window.highestCursor);
      expect(next.messages.map((m) => m.text).join()).toBe('m6');
      expect(server.queries.at(-1)?.after).toBe('a5');
      // The archive forgot the id: resume from the stored time instead of failing forever.
      const resumed = await session.fetchHistory(ANNA, next.highestSeq, 10, 'expired');
      expect(server.queries.at(-1)?.start).toBe(new Date(Date.parse(at(6))).toISOString());
      expect(resumed.messages.map((m) => m.remoteId).join()).toBe('a6');
    });
  });

  await describe('XmppBackend', async () => {
    await it('logs in, keeps the password in a 0600 file only, and lists the account', async () => {
      const dir = tempDir();
      try {
        const server = fakeServer();
        const backend = new XmppBackend(context(dir), fakeFactory(server));
        const ask = prompter(['Me@Example.org', 'correct horse', '']);
        const account = await backend.addAccount(ask);
        expect(account.id).toBe(accountIdFor(ME));
        expect(account.identity).toBe(ME);
        expect(ask.asked[1]).toBe('Password (secret)');
        expect(server.closed).toBe(1);
        const files = readdirSync(context(dir).secretsDir);
        expect(files.join()).toBe(`${account.id}.db`);
        const file = join(context(dir).secretsDir, files[0]);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(await backend.listAccounts()).includes('correct horse')).toBe(false);
        expect(readFileSync(file).includes('correct horse')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('leaves nothing behind on a refused login or a server without an archive', async () => {
      const dir = tempDir();
      try {
        const refused = await rejects(() =>
          new XmppBackend(context(dir), fakeFactory(fakeServer())).addAccount(prompter([ME, 'wrong', ''])),
        );
        expect(refused.includes('not-authorized')).toBe(true);
        expect(refused.includes('wrong')).toBe(false);
        const noMam = await rejects(() =>
          new XmppBackend(context(dir), fakeFactory(fakeServer({ features: new Set() }))).addAccount(
            prompter([ME, 'correct horse', '']),
          ),
        );
        expect(noMam.includes('MAM, XEP-0313')).toBe(true);
        expect(noMam.includes('offline')).toBe(true);
        expect(existsSync(context(dir).secretsDir) && readdirSync(context(dir).secretsDir).length > 0).toBe(
          false,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a password in the config file', async () => {
      const dir = tempDir();
      try {
        const message = await rejects(() =>
          new XmppBackend(context(dir, { password: 'x' }), fakeFactory(fakeServer())).addAccount(
            prompter([]),
          ),
        );
        expect(message.includes('does not belong in the config file')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('syncs through the port: corrections and retractions land on stored messages', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        const server = fakeServer({
          roster: [{ jid: ANNA, name: 'Anna', subscription: 'both' }],
          bookmarks: [{ jid: ROOM, name: 'Orga', nick: 'me', autojoin: true }],
          own: [
            entry({ id: 'a1', at: at(1), from: `${ANNA}/phone`, body: 'Kommst du?', stanzaId: 's1' }),
            entry({ id: 'a2', at: at(2), from: `${ME}/laptop`, to: ANNA, body: 'Ja', stanzaId: 's2' }),
          ],
          rooms: new Map([
            [
              ROOM,
              [entry({ id: 'r1', at: at(3), from: `${ROOM}/ben`, body: 'Salat?', occupantJid: BEN }, ROOM)],
            ],
          ]),
        });
        const backend = new XmppBackend(context(dir), fakeFactory(server));
        expect(isChatBackend(backend)).toBe(true);
        const account = await backend.addAccount(prompter([ME, 'correct horse', '']));
        const first = await syncChats(db, backend);
        expect(first.added).toBe(3);
        expect(first.errors).toBe(0);

        // Anna corrects her message and the user retracts theirs, from another client.
        server.own.push(
          entry({
            id: 'a3',
            at: at(4),
            from: ANNA,
            body: 'Kommst du morgen?',
            extra: `<replace xmlns="${NS.correct}" id="s1"/>`,
          }),
          entry({
            id: 'a4',
            at: at(5),
            from: `${ME}/laptop`,
            to: ANNA,
            extra: `<retract xmlns="${NS.retract}" id="s2"/>`,
          }),
        );
        const second = await syncChats(db, backend);
        expect(second.errors).toBe(0);
        // Unchanged room: caught up by its archive id, not fetched again.
        expect(second.accounts[0].chatsFetched).toBe(1);

        rebuildConversations(db, {
          contacts: [{ uid: 'c-anna', name: 'Anna E.', org: null, emails: [ANNA], phones: [] }],
        });
        const chat = getConversation(db, chatConversationId('xmpp', account.id, ANNA), {
          includeBodies: true,
        });
        expect(chat?.messages.map((m) => m.bodyText).join('|')).toBe('Kommst du morgen?');
        expect(chat?.messages[0].editedAt).toBe(new Date(Date.parse(at(4))).toISOString());
        expect(chat?.messages[0].presentation).toBe('bubble');
        expect(chat?.messages[0].ref.remoteId).toBe('a1');
        // The JID equals the contact's mail address: it is that contact.
        expect(chat?.conversation.participants[0].contactUid).toBe('c-anna');
        const all = listConversations(db);
        expect(all.length).toBe(2);
        expect(all.every((c) => c.backend === 'xmpp')).toBe(true);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('links a JID from the address book (IMPP / X-JABBER)', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        const server = fakeServer({
          roster: [{ jid: BEN, name: null, subscription: 'both' }],
          own: [entry({ id: 'b1', at: at(1), from: BEN, body: 'Hallo' })],
        });
        const backend = new XmppBackend(context(dir), fakeFactory(server));
        const account = await backend.addAccount(prompter([ME, 'correct horse', '']));
        await syncChats(db, backend);
        rebuildConversations(db, {
          contacts: [{ uid: 'c-ben', name: 'Ben', org: null, emails: [], phones: [], jids: [`xmpp:${BEN}`] }],
        });
        const chat = getConversation(db, chatConversationId('xmpp', account.id, BEN));
        expect(chat?.conversation.participants[0].contactUid).toBe('c-ben');
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
