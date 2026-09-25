/**
 * The receive path: one authenticated Signal chat connection as a `DeliverySession`.
 *
 * Signal's server pushes the envelopes queued for this device and deletes each one once the device
 * acknowledges it. So the one rule this class exists for is the ORDER of a commit:
 *
 *   decrypt → journal (fsync) → protocol store (flush) → acknowledge
 *
 * An envelope is acknowledged only after what it said is on disk in the journal AND the ratchet
 * step its decryption took is in the session file. A crash anywhere before the acknowledgement
 * leaves the envelope on the server, and the next run gets it again: either it decrypts again
 * (the ratchet step was not saved — the journal replay and the redelivery write the same keyed
 * rows) or libsignal reports it as a duplicate (the step was saved), and it is only acknowledged.
 * Either way, nothing is lost and nothing is stored twice.
 *
 * Unlike WhatsApp's Baileys, libsignal does not acknowledge on its own — the acknowledgement is
 * ours to send — so this receiver has back-pressure for free: stopping early (the time cap, the
 * memory cap, `close`) leaves everything not yet committed on the server for the next sync.
 *
 * `catch-up` ends when the server says the queue that existed at connect time was delivered
 * (`onQueueEmpty`) and everything before that signal is committed; `follow` keeps going. A
 * dropped connection is reconnected up to `maxReconnects` times; the server redelivers what was
 * not acknowledged. A device the server no longer knows (unlinked on the phone) ends the session.
 *
 * Envelopes that cannot be decrypted are acknowledged and counted — they would never decrypt on
 * a later run either, and postbote sends no retry request (`guard.ts`) — and the count is reported
 * as the session's error, so a sync that lost messages says so.
 */

import type { DeliveryEvent, DeliveryMode, DeliveryOutcome, DeliverySession } from '@postbote/protocol';
import type { AttachmentDownloader } from './contacts.ts';
import { readContactsSync } from './contacts.ts';
import type { DecryptResult } from './decrypt.ts';
import type { EventJournal } from './journal.ts';
import type { SignalMapper } from './map.ts';
import { decodeEnvelope, type Envelope } from './schema.ts';

export const RELINK_HINT = 'link it again with `postbote accounts add signal`';

/** The acknowledgement handle of one delivered envelope (libsignal's `ChatServerMessageAck`). */
export interface EnvelopeAck {
  send(status: number): void;
}

/** What the receiver listens to — libsignal's `ChatServiceListener`, structurally. */
export interface ChatListenerLike {
  onIncomingMessage(envelope: Uint8Array, timestamp: number, ack: EnvelopeAck): void;
  onQueueEmpty(): void;
  onConnectionInterrupted(cause: Error | null): void;
}

/**
 * One open chat connection. No `fetch`: the sync holds no way to send a request (`guard.ts`).
 */
export interface ChatHandle {
  disconnect(): Promise<void>;
}

export type ChatConnector = (listener: ChatListenerLike) => Promise<ChatHandle>;

/** The decrypting side, injected so the receiver is testable around a real or scripted one. */
export interface EnvelopeDecryptorLike {
  decrypt(envelope: Envelope): Promise<DecryptResult>;
}

/** The protocol store's write step. */
export interface Flushable {
  flush(): void;
}

export interface ReceiverOptions {
  mode: DeliveryMode;
  journal: EventJournal;
  /** Download for contact sync; without one, contact lists are skipped. */
  download?: AttachmentDownloader;
  /** Envelopes per commit — the journal fsync and the store write are per commit, not per envelope. */
  commitEvery?: number;
  /** The longest a `catch-up` run waits for the queue. */
  maxMs?: number;
  /** The most undecrypted envelopes held in memory; past it the session stops taking more. */
  maxQueued?: number;
  maxReconnects?: number;
  /** True when an error is the server saying this device is gone. */
  isDelinked?: (err: unknown) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type InboxItem =
  | { kind: 'envelope'; bytes: Uint8Array; ack: EnvelopeAck; generation: number }
  | { kind: 'queue-empty'; generation: number };

export class SignalReceiver implements DeliverySession {
  private readonly connector: ChatConnector;
  private readonly decryptor: EnvelopeDecryptorLike;
  private readonly mapper: SignalMapper;
  private readonly store: Flushable;
  private readonly journal: EventJournal;
  private readonly mode: DeliveryMode;
  private readonly download: AttachmentDownloader | null;
  private readonly commitEvery: number;
  private readonly maxMs: number;
  private readonly maxQueued: number;
  private readonly maxReconnects: number;
  private readonly isDelinked: (err: unknown) => boolean;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private handle: ChatHandle | null = null;
  /** Bumped per connection: an item from a dead connection cannot be acknowledged any more. */
  private generation = 0;
  private reconnects = 0;
  private inbox: InboxItem[] = [];
  private draining: Promise<void> | null = null;
  private pendingAcks: EnvelopeAck[] = [];
  private pendingEvents: DeliveryEvent[] = [];
  private queue: DeliveryEvent[] = [];
  private waiter: (() => void) | null = null;
  private stopping = false;
  private ended = false;
  private readonly endWaiters: Array<() => void> = [];
  private result: DeliveryOutcome = { caughtUp: false, error: null };
  private caughtUp = false;
  private undecryptable = 0;
  /** The first decryption error of the run — reported with the count, never message content. */
  private firstFailure: string | null = null;
  private contactsProblem: string | null = null;
  private maxTimer: unknown = null;
  private finishRequested: DeliveryOutcome | null = null;
  private handedMark: number | null = null;

  constructor(
    connector: ChatConnector,
    decryptor: EnvelopeDecryptorLike,
    mapper: SignalMapper,
    store: Flushable,
    options: ReceiverOptions,
  ) {
    this.connector = connector;
    this.decryptor = decryptor;
    this.mapper = mapper;
    this.store = store;
    this.journal = options.journal;
    this.mode = options.mode;
    this.download = options.download ?? null;
    this.commitEvery = options.commitEvery ?? 50;
    this.maxMs = options.maxMs ?? 10 * 60_000;
    this.maxQueued = options.maxQueued ?? 5_000;
    this.maxReconnects = options.maxReconnects ?? 3;
    this.isDelinked = options.isDelinked ?? (() => false);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Replay what a crashed run left, then connect. Resolves once the first connection is open. */
  async start(): Promise<void> {
    if (this.journal.recovered.length > 0) this.queue.push(...this.journal.recovered);
    if (this.mode === 'catch-up') {
      this.maxTimer = this.setTimer(() => void this.stop({ caughtUp: false, error: null }), this.maxMs);
    }
    await this.open();
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    const listener: ChatListenerLike = {
      onIncomingMessage: (bytes, _timestamp, ack) => {
        if (generation !== this.generation || this.stopping) return; // not acknowledged: redelivered
        this.inbox.push({ kind: 'envelope', bytes, ack, generation });
        if (this.inbox.length > this.maxQueued) {
          void this.stop({ caughtUp: false, error: null });
          return;
        }
        this.kick();
      },
      onQueueEmpty: () => {
        if (generation !== this.generation) return;
        this.inbox.push({ kind: 'queue-empty', generation });
        this.kick();
      },
      onConnectionInterrupted: (cause) => {
        if (generation !== this.generation || this.stopping) return;
        this.handle = null;
        void this.interrupted(cause);
      },
    };
    try {
      this.handle = await this.connector(listener);
    } catch (err) {
      await this.stop({ caughtUp: false, error: this.describe(err, 'the Signal connection failed') });
    }
  }

  private async interrupted(cause: Error | null): Promise<void> {
    // What arrived on the dead connection cannot be acknowledged: it will come again.
    this.inbox = [];
    if (this.isDelinked(cause) || this.reconnects >= this.maxReconnects) {
      await this.stop({ caughtUp: false, error: this.describe(cause, 'the Signal connection closed') });
      return;
    }
    this.reconnects++;
    await this.open();
  }

  private describe(err: unknown, fallback: string): string {
    if (this.isDelinked(err)) return `Signal no longer knows this device (it was unlinked) — ${RELINK_HINT}`;
    const text = err instanceof Error ? err.message : err ? String(err) : '';
    return text ? `${fallback}: ${text}` : fallback;
  }

  private kick(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
      const finish = this.finishRequested;
      if (finish) {
        this.finishRequested = null;
        void this.stop(finish);
      } else if (this.inbox.length > 0 && !this.stopping) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.inbox.length > 0 && !this.stopping) {
      const item = this.inbox.shift() as InboxItem;
      if (item.kind === 'queue-empty') {
        if (!this.commit()) return;
        this.caughtUp = true;
        if (this.mode === 'catch-up') {
          // Stopped from `kick` once this loop has returned: `stop` waits for the loop.
          this.finishRequested = { caughtUp: true, error: null };
          return;
        }
        continue;
      }
      await this.process(item);
      if (item.generation === this.generation) this.pendingAcks.push(item.ack);
      if (this.pendingAcks.length >= this.commitEvery && !this.commit()) return;
    }
    this.commit();
  }

  private async process(item: { bytes: Uint8Array }): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(item.bytes);
    } catch (err) {
      this.failed(err);
      return;
    }
    if (envelope.story) return;
    let result: DecryptResult;
    try {
      result = await this.decryptor.decrypt(envelope);
    } catch (err) {
      this.failed(err);
      return;
    }
    if (result.kind !== 'content') return;
    const mapped = this.mapper.map(result.content, {
      senderAci: result.senderAci,
      timestamp: envelope.clientTimestamp ?? envelope.serverTimestamp ?? Date.now(),
      groupId: result.groupId,
    });
    this.pendingEvents.push(...mapped.events);
    if (mapped.contactsBlob) {
      if (!this.download) {
        this.contactsProblem = 'the contact list from the phone was not read (no downloader)';
      } else {
        try {
          this.pendingEvents.push(...(await readContactsSync(mapped.contactsBlob, this.download)));
          this.contactsProblem = null;
        } catch (err) {
          this.contactsProblem = `the contact list from the phone could not be read (${err instanceof Error ? err.message : String(err)})`;
        }
      }
    }
  }

  private failed(err: unknown): void {
    this.undecryptable++;
    this.firstFailure ??= err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  /**
   * Journal, flush, acknowledge — in that order. Returns false (and stops the session) when the
   * journal or the store cannot be written: then nothing is acknowledged, and the server keeps it.
   */
  private commit(): boolean {
    if (this.pendingAcks.length === 0 && this.pendingEvents.length === 0) return true;
    const events = this.pendingEvents;
    try {
      this.journal.append(events);
      this.store.flush();
    } catch (err) {
      this.pendingEvents = [];
      this.pendingAcks = [];
      void this.stop({
        caughtUp: false,
        error: `the receive journal or the session file cannot be written (${err instanceof Error ? err.message : String(err)}) — nothing was acknowledged`,
      });
      return false;
    }
    this.pendingEvents = [];
    const acks = this.pendingAcks;
    this.pendingAcks = [];
    for (const ack of acks) {
      try {
        ack.send(200);
      } catch {
        // The connection went away: the server redelivers, and the redelivery is a duplicate.
      }
    }
    if (events.length > 0) {
      this.queue.push(...events);
      this.wake();
    }
    return true;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /** Stop taking envelopes, commit what was processed, disconnect, end. */
  private async stop(outcome: DeliveryOutcome): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.result = outcome;
    if (this.maxTimer !== null) this.clearTimer(this.maxTimer);
    this.maxTimer = null;
    // Let an envelope being decrypted finish, so its ratchet step and its events commit together.
    if (this.draining) await this.draining.catch(() => undefined);
    this.commit();
    const handle = this.handle;
    this.handle = null;
    this.generation++;
    if (handle) await handle.disconnect().catch(() => undefined);
    this.ended = true;
    this.wake();
    for (const resolve of this.endWaiters.splice(0)) resolve();
  }

  async nextBatch(): Promise<DeliveryEvent[] | null> {
    // Being asked again means the previous batch is committed to the index: drop it.
    if (this.handedMark !== null) {
      this.journal.release(this.handedMark);
      this.handedMark = null;
    }
    for (;;) {
      if (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];
        this.handedMark = this.journal.size();
        return batch;
      }
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  outcome(): DeliveryOutcome {
    const problems = [this.result.error];
    if (this.undecryptable > 0) {
      problems.push(
        `${this.undecryptable} envelope(s) could not be decrypted and were dropped (Signal keeps no copy; the phone still has them) — first: ${this.firstFailure}`,
      );
    }
    if (this.contactsProblem) problems.push(this.contactsProblem);
    const error = problems.filter(Boolean).join('; ') || null;
    return { caughtUp: this.result.caughtUp || (this.mode === 'follow' && this.caughtUp), error };
  }

  async close(): Promise<void> {
    await this.stop({ caughtUp: this.result.caughtUp, error: this.result.error });
    if (!this.ended) await new Promise<void>((resolve) => this.endWaiters.push(resolve));
    // Not released here: without a further `nextBatch()` the last batch may not be written.
    this.journal.close();
  }
}
