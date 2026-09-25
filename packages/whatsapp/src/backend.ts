/**
 * The WhatsApp backend — a `delivery` driver behind the same port as every other backend,
 * loaded only through the registry, and only after its terms notice was accepted.
 *
 * Self-contained on purpose (ADR 0001 §5): no other postbote package imports this one — only
 * the app's registry lists it — so it can move to its own repository in one step if a takedown
 * or a ban wave makes that necessary.
 */

import type {
  AccountPrompter,
  BackendAccount,
  BackendContext,
  DeliveryBackend,
  DeliveryConnectOptions,
  DeliverySession,
} from '@postbote/protocol';
import { SecretStore } from '@postbote/store';
import { existsSync } from 'node:fs';
import { listSessionAccounts, sessionPath } from './accounts.ts';
import { SecretStoreAuthState } from './auth-state.ts';
import { createBaileysSocket, type SocketFactory } from './client.ts';
import { JidResolver } from './jid.ts';
import { linkWhatsApp } from './login.ts';
import { WHATSAPP_MANIFEST } from './manifest.ts';
import { WhatsAppMapper } from './map.ts';
import { type ReceiverOptions, RELINK_HINT, WhatsAppReceiver } from './receiver.ts';

/** The non-secret settings this backend reads from `backends.whatsapp.settings`. */
export interface WhatsAppSettings {
  /** Ask the phone for the full history (not only recent months) when linking. */
  fullHistory: boolean;
}

export function parseSettings(settings: BackendContext['settings']): WhatsAppSettings {
  const known = new Set(['fullHistory']);
  const unknown = Object.keys(settings).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown setting(s) for whatsapp: ${unknown.join(', ')} — the only one is fullHistory (true/false); the session keys live in the 0600 session file, never in the config`,
    );
  }
  const full = settings.fullHistory;
  if (full !== undefined && typeof full !== 'boolean')
    throw new Error('backends.whatsapp.settings.fullHistory must be true or false');
  return { fullHistory: full === true };
}

export interface WhatsAppBackendOptions {
  createSocket?: SocketFactory;
  /** Receiver timing — tests shorten it. */
  receiver?: Omit<ReceiverOptions, 'mode'>;
  /** Auth-state write-behind delay. */
  flushDelayMs?: number;
}

export class WhatsAppBackend implements DeliveryBackend {
  readonly manifest = WHATSAPP_MANIFEST;
  readonly kind = 'delivery' as const;
  private readonly context: BackendContext;
  private readonly options: WhatsAppBackendOptions;

  constructor(context: BackendContext, options: WhatsAppBackendOptions = {}) {
    this.context = context;
    this.options = options;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listSessionAccounts(this.context.secretsDir);
  }

  /** Link postbote as a device: a QR code to scan, or a pairing code to type on the phone. */
  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    const settings = parseSettings(this.context.settings);
    return linkWhatsApp(this.context, prompter, {
      createSocket: this.options.createSocket,
      fullHistory: settings.fullHistory,
    });
  }

  async connect(accountId: string, options: DeliveryConnectOptions): Promise<DeliverySession> {
    parseSettings(this.context.settings);
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) throw new Error(`no WhatsApp session for ${accountId} — ${RELINK_HINT}`);
    const store = SecretStore.open(path);
    const auth = SecretStoreAuthState.open(store, { flushDelayMs: this.options.flushDelayMs });
    if (!auth.registered) {
      store.close();
      throw new Error(`the WhatsApp session ${accountId} was never linked — ${RELINK_HINT}`);
    }
    const createSocket = this.options.createSocket ?? createBaileysSocket;
    const mapper = new WhatsAppMapper(new JidResolver(auth.lidLookup()));
    const receiver = new WhatsAppReceiver(() => createSocket({ auth }), mapper, {
      ...this.options.receiver,
      mode: options.mode,
      initialSync: !(auth.state.creds.accountSyncCounter > 0),
    });
    receiver.start();
    return {
      nextBatch: () => receiver.nextBatch(),
      outcome: () => receiver.outcome(),
      close: async () => {
        try {
          await receiver.close();
        } finally {
          // The ratchet steps of this run go to disk before the file is let go.
          try {
            auth.flush();
          } finally {
            store.close();
          }
        }
      },
    };
  }
}
