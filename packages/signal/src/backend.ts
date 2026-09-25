/**
 * The Signal backend — a `delivery` driver behind the same port as every other backend, loaded
 * only through the registry, and only after its terms notice was accepted.
 *
 * libsignal is loaded on first use (`lib.ts`): constructing the backend, listing its accounts and
 * reading its manifest touch no native code, so postbote starts on a platform without the addon.
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
import { SIGNAL_TRUST_ROOTS_BASE64 } from './constants.ts';
import { type AttachmentDownloader, httpsDownloader } from './contacts.ts';
import { EnvelopeDecryptor } from './decrypt.ts';
import { FileJournal, journalPath } from './journal.ts';
import { type SignalLib, loadSignalLib } from './lib.ts';
import { type LinkNetwork, linkSignal } from './link.ts';
import { SIGNAL_MANIFEST } from './manifest.ts';
import { SignalMapper } from './map.ts';
import { createNet, isDelinked, linkChannel, liveConnector } from './net.ts';
import { fromBase64, type DeviceAccount, SignalProtocolStore } from './protocol-store.ts';
import { openProvisioning } from './provisioning.ts';
import { type ChatConnector, type ReceiverOptions, RELINK_HINT, SignalReceiver } from './receiver.ts';

/** The non-secret settings this backend reads from `backends.signal.settings`. */
export interface SignalSettings {
  /** The name the phone lists this device under. */
  deviceName: string;
}

export function parseSettings(settings: BackendContext['settings']): SignalSettings {
  const unknown = Object.keys(settings).filter((k) => k !== 'deviceName');
  if (unknown.length > 0) {
    throw new Error(
      `unknown setting(s) for signal: ${unknown.join(', ')} — the only one is deviceName; the keys live in the 0600 session file, never in the config`,
    );
  }
  const name = settings.deviceName;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 50)) {
    throw new Error('backends.signal.settings.deviceName must be a name of 1–50 characters');
  }
  return { deviceName: typeof name === 'string' ? name.trim() : 'postbote' };
}

export interface SignalBackendOptions {
  /** libsignal, for a test that has it loaded already. */
  lib?: SignalLib;
  /** The receive connection — a test hands in a scripted one. */
  connector?: (account: DeviceAccount) => ChatConnector;
  /** The link's network — a test plays the phone. */
  linkNetwork?: (lib: SignalLib) => LinkNetwork;
  /** The contact-sync download. */
  download?: AttachmentDownloader;
  /** Sealed-sender trust roots (serialized public keys); Signal's production roots by default. */
  trustRoots?: readonly Uint8Array[];
  receiver?: Omit<ReceiverOptions, 'mode' | 'journal' | 'download'>;
}

export class SignalBackend implements DeliveryBackend {
  readonly manifest = SIGNAL_MANIFEST;
  readonly kind = 'delivery' as const;
  private readonly context: BackendContext;
  private readonly options: SignalBackendOptions;

  constructor(context: BackendContext, options: SignalBackendOptions = {}) {
    this.context = context;
    this.options = options;
  }

  private lib(): Promise<SignalLib> {
    return this.options.lib ? Promise.resolve(this.options.lib) : loadSignalLib();
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listSessionAccounts(this.context.secretsDir);
  }

  /** Link postbote as a device: a QR code to scan with the phone. */
  async addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    const settings = parseSettings(this.context.settings);
    const lib = await this.lib();
    const network =
      this.options.linkNetwork?.(lib) ??
      (() => {
        const net = createNet(lib);
        return {
          provisioning: (key, listener) => openProvisioning(lib, net, key, listener),
          channel: () => linkChannel(net),
        } satisfies LinkNetwork;
      })();
    return linkSignal(lib, this.context, prompter, network, { deviceName: settings.deviceName });
  }

  async connect(accountId: string, options: DeliveryConnectOptions): Promise<DeliverySession> {
    parseSettings(this.context.settings);
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) throw new Error(`no Signal session for ${accountId} — ${RELINK_HINT}`);
    const lib = await this.lib();
    const file = SecretStore.open(path);
    const store = SignalProtocolStore.open(lib, file);
    const account = store.account();
    if (!account) {
      file.close();
      throw new Error(`the Signal session ${accountId} was never linked — ${RELINK_HINT}`);
    }
    let journal: FileJournal;
    try {
      journal = FileJournal.open(journalPath(path));
    } catch (err) {
      file.close();
      throw err;
    }
    const decryptor = new EnvelopeDecryptor(lib, store, {
      trustRoots: this.options.trustRoots ?? SIGNAL_TRUST_ROOTS_BASE64.map(fromBase64),
    });
    const mapper = new SignalMapper(account.aci, (masterKey) =>
      lib.zk.GroupSecretParams.deriveFromMasterKey(
        new lib.zk.GroupMasterKey(masterKey as Uint8Array<ArrayBuffer>),
      )
        .getPublicParams()
        .getGroupIdentifier()
        .serialize(),
    );
    const connector = this.options.connector?.(account) ?? liveConnector(createNet(lib), account);
    const receiver = new SignalReceiver(connector, decryptor, mapper, store, {
      isDelinked: (err) => isDelinked(lib, err),
      ...this.options.receiver,
      mode: options.mode,
      journal,
      download: this.options.download ?? httpsDownloader(),
    });
    await receiver.start();
    return {
      nextBatch: () => receiver.nextBatch(),
      outcome: () => receiver.outcome(),
      close: async () => {
        try {
          await receiver.close();
        } finally {
          // Every commit flushed what it acknowledged. What is still dirty belongs to envelopes
          // that were NOT acknowledged: saving it would make their redelivery a "duplicate" and
          // lose them. So it is dropped, and the server delivers those envelopes again.
          store.discard();
          file.close();
        }
      },
    };
  }
}
