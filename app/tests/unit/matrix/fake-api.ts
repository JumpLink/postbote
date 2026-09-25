/**
 * A fake `MatrixApi`: rooms and their timelines in memory, `/messages` served backwards with
 * index tokens, every call recorded. Synthetic users on `example.org` only.
 */

import type {
  MatrixApi,
  MatrixConnector,
  MatrixSession,
  MxEvent,
  MxMessagesPage,
  MxRoom,
} from '@postbote/matrix';

export const ME = '@me:example.org';
export const ANNA = '@anna:example.org';
export const BEN = '@ben:example.org';

let counter = 0;

/** A text message event. */
export function text(sender: string, ts: number, body: string, extra: Record<string, unknown> = {}): MxEvent {
  return event('m.room.message', sender, ts, { msgtype: 'm.text', body, ...extra });
}

export function event(
  type: string,
  sender: string,
  ts: number,
  content: Record<string, unknown>,
  more: Partial<MxEvent> = {},
): MxEvent {
  counter++;
  return {
    eventId: `$e${counter}:example.org`,
    type,
    sender,
    ts,
    content,
    redacted: false,
    undecryptable: null,
    ...more,
  };
}

export function edit(sender: string, ts: number, target: string, body: string): MxEvent {
  return event('m.room.message', sender, ts, {
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  });
}

export function redaction(sender: string, ts: number, target: string): MxEvent {
  return event('m.room.redaction', sender, ts, { redacts: target });
}

export class FakeMatrixApi implements MatrixApi {
  readonly userId = ME;
  readonly rooms = new Map<string, { room: MxRoom; timeline: MxEvent[] }>();
  readonly calls: string[] = [];
  readonly names = new Map<string, string>([
    [ANNA, 'Anna Example'],
    [BEN, 'Ben Example'],
  ]);
  closed = 0;
  /** What `fetchEvent` returns instead of the timeline's event: a key that arrived later. */
  readonly decryptsNow = new Map<string, MxEvent>();
  readonly fetched: string[] = [];

  addRoom(room: Partial<MxRoom> & { roomId: string }): void {
    this.rooms.set(room.roomId, {
      room: {
        name: null,
        direct: false,
        members: [],
        lastEventTs: null,
        readUpToTs: null,
        peerReadUpToTs: null,
        ...room,
      },
      timeline: [],
    });
  }

  post(roomId: string, ...events: MxEvent[]): void {
    const entry = this.rooms.get(roomId);
    if (!entry) throw new Error(`no room ${roomId}`);
    entry.timeline.push(...events);
    entry.room = { ...entry.room, lastEventTs: events[events.length - 1].ts };
  }

  async listRooms(): Promise<MxRoom[]> {
    return [...this.rooms.values()].map((r) => r.room);
  }

  async messages(roomId: string, from: string | null, limit: number): Promise<MxMessagesPage> {
    this.calls.push(`${roomId}:${from ?? 'end'}:${limit}`);
    const timeline = this.rooms.get(roomId)?.timeline ?? [];
    const top = from === null ? timeline.length : Number(from);
    const bottom = Math.max(0, top - limit);
    const events = timeline.slice(bottom, top).reverse();
    const displayNames = new Map<string, string>();
    for (const e of events) {
      const name = this.names.get(e.sender);
      if (name) displayNames.set(e.sender, name);
    }
    return { events, end: bottom === 0 ? null : String(bottom), displayNames };
  }

  async fetchEvent(roomId: string, eventId: string): Promise<MxEvent | null> {
    this.fetched.push(eventId);
    const replaced = this.decryptsNow.get(eventId);
    if (replaced) return replaced;
    return this.rooms.get(roomId)?.timeline.find((e) => e.eventId === eventId) ?? null;
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

/** A connector that hands out the fake and remembers what it was connected with. */
export function fakeConnector(api: FakeMatrixApi): MatrixConnector & { sessions: MatrixSession[] } {
  const sessions: MatrixSession[] = [];
  const connect = async (session: MatrixSession): Promise<MatrixApi> => {
    sessions.push(session);
    return api;
  };
  return Object.assign(connect, { sessions });
}

/** An encrypted event this device has no key for. */
export function undecryptable(sender: string, ts: number): MxEvent {
  return event(
    'm.room.encrypted',
    sender,
    ts,
    { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'synthetic' },
    { undecryptable: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' },
  );
}
