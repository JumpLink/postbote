/**
 * The receive path: one WhatsApp connection as a `DeliverySession`.
 *
 * It listens to Baileys' events, maps them (`map.ts`) and queues the result; the store engine
 * pulls batches with `nextBatch()` and writes each before asking for the next. The same class
 * serves `postbote sync` (`catch-up`) and a later daemon (`follow`) — they differ only in when
 * `nextBatch()` stops.
 *
 * When is `catch-up` done? WhatsApp has no "you are up to date" answer to ask for. What Baileys
 * reports is `receivedPendingNotifications` (the offline queue was handed over) and, on a freshly
 * linked device, history-sync chunks with a progress and a `messaging-history.status` when a
 * phase is complete. So: done once the offline queue was handed over, the first sync of a new
 * device has ended (Baileys raises `accountSyncCounter`), no history phase is still running,
 * and nothing arrived for `quietMs` — or, as a last resort, after `maxMs`
 * (reported as not caught up; what arrived is written either way).
 *
 * A dropped connection is reconnected (a fresh socket on the same auth state) up to
 * `maxReconnects` times; a logout is final. Nothing here sends anything.
 */

import type { DeliveryEvent, DeliveryMode, DeliveryOutcome, DeliverySession } from '@postbote/protocol';
import type { WaEventMap, WaEventName, WaSocketHandle } from './api.ts';
import { disconnectReason, disconnectStatus, LOGGED_OUT } from './api.ts';
import type { WhatsAppMapper } from './map.ts';

export const RELINK_HINT = 'link it again with `postbote accounts add whatsapp`';

export interface ReceiverOptions {
  mode: DeliveryMode;
  /** Silence after which a caught-up backlog counts as complete. */
  quietMs?: number;
  /** The longest a `catch-up` run waits for the backlog. */
  maxMs?: number;
  /** How long a batch collects further events before it is handed out. */
  coalesceMs?: number;
  /** Reconnects after a dropped connection (not after a logout). */
  maxReconnects?: number;
  /**
   * The device has not finished its first sync yet (Baileys' `creds.accountSyncCounter` is 0).
   * Baileys then holds every event back while it waits up to 20 s for the phone's history, and
   * reports the end by raising `accountSyncCounter` — so until that `creds.update`, silence
   * means "still waiting", not "done".
   */
  initialSync?: boolean;
  /** How long closing waits for Baileys to hand over what it still holds. */
  drainMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Listener<E extends WaEventName> = (data: WaEventMap[E]) => void;

export class WhatsAppReceiver implements DeliverySession {
  private readonly connect: () => WaSocketHandle;
  private readonly mapper: WhatsAppMapper;
  private readonly mode: DeliveryMode;
  private readonly quietMs: number;
  private readonly maxMs: number;
  private readonly coalesceMs: number;
  private readonly maxReconnects: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private socket: WaSocketHandle | null = null;
  private detach: (() => void) | null = null;
  private queue: DeliveryEvent[] = [];
  private waiter: (() => void) | null = null;
  /** No more events will be queued: the socket is gone. `nextBatch` drains what is left. */
  private ended = false;
  /** The session decided to stop and is closing the socket; events still arriving are kept. */
  private finishing = false;
  private readonly endWaiters: Array<() => void> = [];
  private result: DeliveryOutcome = { caughtUp: false, error: null };
  private reconnects = 0;
  private pendingReceived = false;
  private historyRunning = false;
  private awaitingInitialSync: boolean;
  private quietTimer: unknown = null;
  private maxTimer: unknown = null;
  private drainTimer: unknown = null;
  private readonly drainMs: number;

  constructor(connect: () => WaSocketHandle, mapper: WhatsAppMapper, options: ReceiverOptions) {
    this.connect = connect;
    this.mapper = mapper;
    this.mode = options.mode;
    this.quietMs = options.quietMs ?? 8_000;
    this.maxMs = options.maxMs ?? 10 * 60_000;
    this.coalesceMs = options.coalesceMs ?? 250;
    this.maxReconnects = options.maxReconnects ?? 3;
    this.awaitingInitialSync = options.initialSync ?? false;
    this.drainMs = options.drainMs ?? 5_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Open the first connection and start the clock. */
  start(): void {
    this.open();
    if (this.mode === 'catch-up') {
      this.touch();
      this.maxTimer = this.setTimer(() => this.finish({ caughtUp: false, error: null }), this.maxMs);
    }
  }

  private open(): void {
    const socket = this.connect();
    this.socket = socket;
    const listeners: Array<[WaEventName, Listener<WaEventName>]> = [];
    const on = <E extends WaEventName>(event: E, listener: Listener<E>) => {
      socket.ev.on(event, listener);
      listeners.push([event, listener as Listener<WaEventName>]);
    };
    on('connection.update', (u) => this.onConnection(u));
    on('messages.upsert', ({ messages, type }) =>
      // `notify`: arrived live; `append`: from the offline queue or the phone. Neither is read yet.
      this.push(
        messages.flatMap((m) => this.mapper.message(m, false)),
        type === 'notify' || type === 'append',
      ),
    );
    on('messaging-history.set', (set) => {
      this.historyRunning = typeof set.progress === 'number' && set.progress < 100;
      this.push(this.mapper.history(set), true);
    });
    on('messaging-history.status', () => {
      this.historyRunning = false;
      this.touch();
    });
    on('messages.update', (u) => this.push(this.mapper.receipts(u), false));
    on('message-receipt.update', (u) => this.push(this.mapper.userReceipts(u), false));
    on('messages.delete', (d) => this.push(this.mapper.deletion(d), true));
    on('chats.upsert', (chats) =>
      this.push(
        chats.flatMap((c) => this.mapper.chat(c, false)),
        false,
      ),
    );
    on('chats.update', (chats) =>
      this.push(
        chats.flatMap((c) => this.mapper.chat(c, false)),
        false,
      ),
    );
    on('chats.delete', (ids) => this.push(this.mapper.chatDeletion(ids), true));
    on('contacts.upsert', (cs) =>
      this.push(
        cs.flatMap((c) => this.mapper.contact(c)),
        false,
      ),
    );
    on('contacts.update', (cs) =>
      this.push(
        cs.flatMap((c) => this.mapper.contact(c)),
        false,
      ),
    );
    on('groups.upsert', (gs) =>
      this.push(
        gs.flatMap((g) => this.mapper.group(g)),
        false,
      ),
    );
    on('groups.update', (gs) =>
      this.push(
        gs.flatMap((g) => this.mapper.group(g)),
        false,
      ),
    );
    on('lid-mapping.update', ({ lid, pn }) => this.mapper.resolver.learn(lid, pn));
    on('creds.update', (update) => {
      if (typeof update.accountSyncCounter === 'number' && update.accountSyncCounter > 0) {
        this.awaitingInitialSync = false;
        this.touch();
      }
    });
    this.detach = () => {
      for (const [event, listener] of listeners) socket.ev.off(event, listener);
    };
  }

  private onConnection(update: WaConnectionUpdateLike): void {
    if (update.receivedPendingNotifications) {
      this.pendingReceived = true;
      this.touch();
    }
    if (update.connection !== 'close' || this.ended) return;
    if (this.finishing) {
      // Our own `end()`: everything Baileys emitted up to here is queued.
      this.closed();
      return;
    }
    this.detach?.();
    this.detach = null;
    this.socket = null;
    if (disconnectStatus(update) === LOGGED_OUT) {
      this.finish({
        caughtUp: false,
        error: `WhatsApp logged this device out (${disconnectReason(update)}) — ${RELINK_HINT}`,
      });
      return;
    }
    if (this.reconnects >= this.maxReconnects) {
      this.finish({ caughtUp: false, error: `the WhatsApp connection closed: ${disconnectReason(update)}` });
      return;
    }
    this.reconnects++;
    // The offline queue is handed over again by the new connection.
    this.pendingReceived = false;
    this.open();
  }

  /**
   * Queue events. `activity` marks traffic that proves the backlog is still flowing — a read
   * receipt or a contact update is not, so it does not keep a finished catch-up alive.
   */
  private push(events: DeliveryEvent[], activity: boolean): void {
    if (this.ended) return;
    if (events.length > 0) {
      this.queue.push(...events);
      this.wake();
    }
    if (activity || events.length > 0) this.touch();
  }

  /** Restart the quiet period. */
  private touch(): void {
    if (this.mode !== 'catch-up' || this.ended || this.finishing) return;
    if (this.quietTimer !== null) this.clearTimer(this.quietTimer);
    this.quietTimer = this.setTimer(() => {
      this.quietTimer = null;
      if (this.pendingReceived && !this.historyRunning && !this.awaitingInitialSync)
        this.finish({ caughtUp: true, error: null });
      else this.touch();
    }, this.quietMs);
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /**
   * Stop receiving. With a socket still open this is a DRAIN, not a cut: Baileys may hold events
   * back in its buffer (it does during a first sync), and destroys that buffer on close — while
   * the messages in it were already acknowledged to the server. So `end()` first hands the
   * buffer over (the handle flushes it), the listeners stay attached until Baileys reports the
   * close, and only then is the session over. `drainMs` bounds the wait.
   */
  private finish(outcome: DeliveryOutcome): void {
    if (this.ended || this.finishing) return;
    this.result = outcome;
    for (const timer of [this.quietTimer, this.maxTimer]) if (timer !== null) this.clearTimer(timer);
    this.quietTimer = null;
    this.maxTimer = null;
    const socket = this.socket;
    if (!socket) {
      this.closed();
      return;
    }
    this.finishing = true;
    this.drainTimer = this.setTimer(() => this.closed(), this.drainMs);
    socket.end();
  }

  private closed(): void {
    if (this.ended) return;
    this.ended = true;
    this.finishing = false;
    if (this.drainTimer !== null) this.clearTimer(this.drainTimer);
    this.drainTimer = null;
    this.detach?.();
    this.detach = null;
    this.socket = null;
    this.wake();
    for (const resolve of this.endWaiters.splice(0)) resolve();
  }

  async nextBatch(): Promise<DeliveryEvent[] | null> {
    for (;;) {
      if (this.queue.length > 0) {
        // Let a burst (a history chunk, a flushed buffer) land in one batch: one transaction.
        if (!this.ended && this.coalesceMs > 0) {
          await new Promise<void>((resolve) => this.setTimer(resolve, this.coalesceMs));
        }
        const batch = this.queue;
        this.queue = [];
        return batch;
      }
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  outcome(): DeliveryOutcome {
    return this.result;
  }

  async close(): Promise<void> {
    // Closed before the backlog was in: it is not "caught up". Events that still arrive while
    // the socket closes are dropped here — the caller stopped reading; a normal run ends through
    // `nextBatch()` returning null, which only happens after the drain.
    this.finish({ caughtUp: false, error: null });
    if (!this.ended) await new Promise<void>((resolve) => this.endWaiters.push(resolve));
  }
}

type WaConnectionUpdateLike = WaEventMap['connection.update'];
