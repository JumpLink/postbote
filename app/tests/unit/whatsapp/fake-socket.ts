import type {
  SocketFactory,
  SocketOptions,
  WaEventMap,
  WaEventName,
  WaMessage,
  WaMessageContent,
  WaSocketHandle,
} from '@postbote/whatsapp';

/**
 * A scriptable stand-in for Baileys' socket, and a manual clock. The receive path, the login and
 * a whole sync run against these exactly as against WhatsApp — with no network, no phone and no
 * account. Every id, number and name here is synthetic.
 */

type Listener = (data: unknown) => void;

export class FakeSocket implements WaSocketHandle {
  private readonly listeners = new Map<string, Set<Listener>>();
  ended = false;
  pairingRequests: string[] = [];
  readonly options: SocketOptions;

  constructor(options: SocketOptions) {
    this.options = options;
  }

  readonly ev = {
    on: <E extends WaEventName>(event: E, listener: (data: WaEventMap[E]) => void) => {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener as Listener);
    },
    off: <E extends WaEventName>(event: E, listener: (data: WaEventMap[E]) => void) => {
      this.listeners.get(event)?.delete(listener as Listener);
    },
  };

  emit<E extends WaEventName>(event: E, data: WaEventMap[E]): void {
    // A snapshot: a listener may detach itself (or others) while the event is delivered.
    const listeners = [...(this.listeners.get(event) ?? [])];
    for (const listener of listeners) listener(data);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    this.pairingRequests.push(phoneNumber);
    return 'ABCD1234';
  }

  /** Events Baileys would still hold in its buffer; `end()` hands them over first, like the real handle. */
  readonly buffered: Array<() => void> = [];

  hold<E extends WaEventName>(event: E, data: WaEventMap[E]): void {
    this.buffered.push(() => this.emit(event, data));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const release of this.buffered.splice(0)) release();
    // Baileys reports its own close asynchronously, after the socket is down.
    queueMicrotask(() => this.emit('connection.update', { connection: 'close', lastDisconnect: {} }));
  }
}

/** A factory that records every socket it made; `onCreate` scripts what each one does. */
export function fakeFactory(onCreate: (socket: FakeSocket, index: number) => void = () => {}): {
  create: SocketFactory;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    create: (options) => {
      const socket = new FakeSocket(options);
      const index = sockets.length;
      sockets.push(socket);
      // Like Baileys: events come after construction, never synchronously inside it.
      queueMicrotask(() => onCreate(socket, index));
      return socket;
    },
  };
}

/** A clock that only moves when told to. */
export class ManualClock {
  private now = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pending(): number {
    return this.timers.size;
  }

  /** Move forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = until;
  }
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── synthetic identities ──────────────────────────────────────────────

export const ANNA_PN = '4915100000001@s.whatsapp.net';
export const ANNA_LID = '100000000000001@lid';
export const BEN_LID = '100000000000002@lid';
export const GROUP = '120363000000000001@g.us';

export function text(body: string): WaMessageContent {
  return { conversation: body };
}

export function waMessage(
  chat: string,
  id: string,
  seconds: number,
  content: WaMessageContent | null,
  extra: Partial<WaMessage> & { fromMe?: boolean; participant?: string; remoteJidAlt?: string } = {},
): WaMessage {
  const { fromMe, participant, remoteJidAlt, ...rest } = extra;
  return {
    key: {
      remoteJid: chat,
      id,
      fromMe: fromMe ?? false,
      ...(participant ? { participant } : {}),
      ...(remoteJidAlt ? { remoteJidAlt } : {}),
    },
    message: content,
    messageTimestamp: seconds,
    ...rest,
  };
}
