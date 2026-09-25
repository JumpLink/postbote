/**
 * Contact sync: the phone's address book, as the user's own account sends it.
 *
 * A `SyncMessage.Contacts` carries an attachment pointer; the attachment is a stream of
 * varint-length-delimited `ContactDetails`, each followed by its avatar bytes. Ported from
 * Signal-Desktop `ts/textsecure/ContactsParser.preload.ts` and `downloadAttachment.preload.ts`
 * (Copyright 2020-2026 Signal Messenger, LLC, AGPL-3.0-only). Avatars are skipped.
 *
 * The phone sends contact sync on its own schedule (after a link, when contacts change); postbote
 * never asks for it — asking is a message to the user's devices, and postbote sends nothing.
 *
 * The download is a GET from Signal's CDN, which chains to Signal's private CA
 * (`constants.ts`). On GJS this does not work yet: gjsify's `node:https` ignores the `ca` option
 * (gjsify gap, unfixed — see `httpsDownloader`), so the sync reports the contact list as not read
 * and carries on; the messages themselves are unaffected.
 */

import { type DeliveryEvent, normalizeAddress } from '@postbote/protocol';
import { SIGNAL_ROOT_CA_PEM } from './constants.ts';
import { decryptAttachment } from './crypto.ts';
import { peerOf } from './map.ts';
import { readDelimited } from './proto.ts';
import { type AttachmentPointer, type ContactDetails, decodeContactDetails } from './schema.ts';

/** Fetch an attachment's encrypted bytes. Injected so tests serve synthetic blobs. */
export type AttachmentDownloader = (url: string) => Promise<Uint8Array>;

const CDN: Record<number, string> = {
  0: 'https://cdn.signal.org',
  2: 'https://cdn2.signal.org',
  3: 'https://cdn3.signal.org',
};

export function attachmentUrl(pointer: AttachmentPointer): string {
  const key =
    pointer.cdnKey || (pointer.cdnId !== null && pointer.cdnId !== 0n ? pointer.cdnId.toString() : null);
  if (!key) throw new Error('the attachment has no CDN key');
  const base = CDN[pointer.cdnNumber] ?? CDN[0];
  return `${base}/attachments/${encodeURIComponent(key)}`;
}

/** Split a decrypted contact blob into its entries. Avatars are skipped, not kept. */
export function parseContactsBlob(plaintext: Uint8Array): ContactDetails[] {
  const out: ContactDetails[] = [];
  let offset = 0;
  for (;;) {
    const next = readDelimited(plaintext, offset);
    if (!next) break;
    const details = decodeContactDetails(next.frame);
    out.push(details);
    offset = next.next + details.avatarLength;
  }
  return out;
}

/** Contact entries → `peer` events: the name the user saved, the ACI, the phone number. */
export function contactEvents(contacts: readonly ContactDetails[]): DeliveryEvent[] {
  const events: DeliveryEvent[] = [];
  for (const c of contacts) {
    if (!c.aci || c.aci.startsWith('PNI:')) continue;
    const phone = c.number ? normalizeAddress('phone', c.number) : null;
    events.push({ type: 'peer', peer: peerOf(c.aci, c.name?.trim() || null, phone) });
  }
  return events;
}

export async function readContactsSync(
  pointer: AttachmentPointer,
  download: AttachmentDownloader,
): Promise<DeliveryEvent[]> {
  if (!pointer.key) throw new Error('the contact list has no key');
  const encrypted = await download(attachmentUrl(pointer));
  const plaintext = decryptAttachment(encrypted, pointer.key, { size: pointer.size, digest: pointer.digest });
  return contactEvents(parseContactsBlob(plaintext));
}

/**
 * Download over `node:https`, pinned to Signal's root. gjsify gap (unfixed): on GJS,
 * `@gjsify/https` builds its `Soup.Session` without a TLS database, so `ca` is ignored and the
 * CDN's certificate is refused ("Inakzeptables TLS-Zertifikat") — contact sync works on Node only
 * until gjsify honours `ca`.
 */
export function httpsDownloader(maxBytes = 64 * 1024 * 1024): AttachmentDownloader {
  return async (url) => {
    const https = await import('node:https');
    return new Promise<Uint8Array>((resolve, reject) => {
      const req = https.get(url, { ca: SIGNAL_ROOT_CA_PEM, timeout: 60_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`the CDN answered ${res.statusCode}`));
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        res.on('data', (chunk: Uint8Array) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('the attachment is larger than allowed'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const out = new Uint8Array(size);
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.length;
          }
          resolve(out);
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('the CDN did not answer in time')));
      req.on('error', reject);
    });
  };
}
