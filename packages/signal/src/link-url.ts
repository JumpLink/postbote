/**
 * The `sgnl://linkdevice` URL the primary phone scans to link a new device.
 *
 * Shape from Signal-Desktop (`ts/util/signalRoutes.std.ts`, `linkDeviceRoute`; built in
 * `ts/textsecure/Provisioner.preload.ts`): `uuid` is the opaque provisioning address the server
 * hands out, `pub_key` the base64 (with padding) of the serialized provisioning public key —
 * type byte included — and `capabilities` a comma-separated list. Pure: no libsignal import.
 */

export interface LinkDeviceUrlInput {
  /** Opaque provisioning address from the server; never interpreted. */
  address: string;
  /** `PublicKey.serialize()` of the provisioning key pair (33 bytes, type byte first). */
  publicKey: Uint8Array;
  /** Defaults to `['nopni']` — e164-less linking, as Signal-Desktop does. */
  capabilities?: readonly string[];
}

export function linkDeviceUrl(input: LinkDeviceUrlInput): string {
  if (!input.address) throw new Error('provisioning address is empty');
  if (input.publicKey.length !== 33) {
    throw new Error(`provisioning public key has ${input.publicKey.length} bytes, expected 33`);
  }
  const params = new URLSearchParams({
    uuid: input.address,
    pub_key: bytesToBase64(input.publicKey),
    capabilities: (input.capabilities ?? ['nopni']).join(','),
  });
  return `sgnl://linkdevice?${params.toString()}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
