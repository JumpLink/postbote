/**
 * `postbote accounts add whatsapp` — linking postbote as a device of the user's WhatsApp, as a
 * function the CLI calls with its terminal prompts.
 *
 * Two ways, both done on the phone (WhatsApp → Settings → Linked devices → Link a device):
 * scan the QR code printed in the terminal, or — with a phone number given — type the 8-character
 * pairing code instead. WhatsApp then asks this device to reconnect once (status 515), and the
 * link is complete when that second connection opens.
 *
 * The session is created under a temporary name and moved to `<account id>.db` only once linked,
 * so a cancelled or failed link never leaves keys that `sync` would try to use. The link closes
 * its connection the moment it opens, before the offline queue is handed over: the first
 * `postbote sync` receives that queue and the history the phone sends once, and writes them.
 *
 * Nothing secret is returned or printed apart from the QR code / pairing code themselves, which
 * are what the user must see: not the phone number, not a key. The result is the account id and
 * the public name.
 */

import type { AccountPrompter, BackendAccount, BackendContext } from '@postbote/protocol';
import { ensurePrivateDir, SecretStore } from '@postbote/store';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { WaSocketHandle } from './api.ts';
import { disconnectReason, disconnectStatus, RESTART_REQUIRED } from './api.ts';
import { pendingSessionPath, sessionPath, sweepPendingSessions, writeAccountRecord } from './accounts.ts';
import { SecretStoreAuthState } from './auth-state.ts';
import { createBaileysSocket, type SocketFactory } from './client.ts';
import { parseJid } from './jid.ts';
import { renderQr } from './qr.ts';

export const LINK_TIMEOUT_MS = 3 * 60_000;

/** A phone number for a pairing code: digits with country code, no `+`. Null for "use a QR code". */
export function parsePairingPhone(raw: string): string | null {
  const digits = raw
    .trim()
    .replace(/[\s\-./()]/g, '')
    .replace(/^\+/, '')
    .replace(/^00/, '');
  if (!digits) return null;
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    throw new Error('the phone number must be international, with country code (e.g. +49 151 …)');
  }
  return digits;
}

/** The account id: `whatsapp-<LID>`, else (no LID reported) the device's registration id. */
export function accountIdFromCreds(creds: {
  me?: { id?: string; lid?: string } | null;
  registrationId?: number;
}): string {
  const lid = parseJid(creds.me?.lid);
  if (lid && /^\d+$/.test(lid.user)) return `whatsapp-${lid.user}`;
  return `whatsapp-${creds.registrationId ?? 0}`;
}

/** The public name an account is listed under — the user's own WhatsApp name, never the number. */
export function identityFromCreds(creds: { me?: { name?: string } | null }): string {
  return creds.me?.name?.trim() || 'WhatsApp account';
}

export interface LinkOptions {
  createSocket?: SocketFactory;
  timeoutMs?: number;
  fullHistory?: boolean;
}

/** Drive one socket until the link completes, the phone asks for a restart, or it fails. */
function runLinkSocket(
  sock: WaSocketHandle,
  auth: SecretStoreAuthState,
  prompter: AccountPrompter,
  phone: string | null,
  state: { codeRequested: boolean },
): Promise<'linked' | 'restart'> {
  return new Promise((resolve, reject) => {
    sock.ev.on('connection.update', (update) => {
      if (update.qr) {
        if (phone) {
          if (state.codeRequested) return;
          state.codeRequested = true;
          sock
            .requestPairingCode(phone)
            .then((code) =>
              prompter.notify(
                `Pairing code: ${code}\nOn the phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead", and type it.`,
              ),
            )
            .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
        } else {
          prompter.notify(
            `${renderQr(update.qr)}\nScan this with the phone: WhatsApp → Settings → Linked devices → Link a device. (A new code appears every ~20 s.)`,
          );
        }
      }
      if (update.connection === 'open' && auth.registered) resolve('linked');
      if (update.connection === 'close') {
        if (disconnectStatus(update) === RESTART_REQUIRED) resolve('restart');
        else reject(new Error(`linking failed (${disconnectReason(update)}) — nothing was saved`));
      }
    });
  });
}

export async function linkWhatsApp(
  context: BackendContext,
  prompter: AccountPrompter,
  options: LinkOptions = {},
): Promise<BackendAccount> {
  const createSocket = options.createSocket ?? createBaileysSocket;
  const phone = parsePairingPhone(
    await prompter.ask(
      'Phone number for a pairing code (international, e.g. +49…) — leave empty to scan a QR code',
    ),
  );
  ensurePrivateDir(context.secretsDir);
  // What a killed earlier link left behind goes first: it may hold a linked device's keys.
  sweepPendingSessions(context.secretsDir);
  const pending = pendingSessionPath(context.secretsDir);
  const store = SecretStore.open(pending);
  // Written at once during the link: a handful of writes, and each one matters.
  const auth = SecretStoreAuthState.open(store, { flushDelayMs: 0 });
  let moved = false;
  let sock: WaSocketHandle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('no phone linked this device in time — nothing was saved')),
        options.timeoutMs ?? LINK_TIMEOUT_MS,
      );
    });
    const state = { codeRequested: false };
    for (let attempt = 0; ; attempt++) {
      if (attempt > 3) throw new Error('WhatsApp kept asking for a reconnect — nothing was saved');
      sock = createSocket({ auth, fullHistory: options.fullHistory === true });
      const outcome = await Promise.race([runLinkSocket(sock, auth, prompter, phone, state), timeout]);
      if (outcome === 'linked') break;
      sock.end();
      sock = null;
    }
    // Close before the offline queue is handed over: the first sync takes it and writes it.
    sock?.end();
    sock = null;
    const account: BackendAccount = {
      id: accountIdFromCreds(auth.state.creds),
      identity: identityFromCreds(auth.state.creds),
      provider: 'WhatsApp',
    };
    auth.flush();
    writeAccountRecord(store, { identity: account.identity });
    store.close();
    renameSync(pending, sessionPath(context.secretsDir, account.id));
    moved = true;
    prompter.notify(
      'Linked. Run `postbote sync` now: WhatsApp hands the recent history and everything queued to the first connection that takes it, once.',
    );
    return account;
  } finally {
    if (timer) clearTimeout(timer);
    sock?.end();
    if (!moved) {
      try {
        store.close();
      } catch {
        // Already closed after a successful link that failed later at the rename.
      }
      for (const path of [pending, `${pending}-journal`]) if (existsSync(path)) rmSync(path, { force: true });
    }
  }
}
