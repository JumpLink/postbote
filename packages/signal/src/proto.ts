/**
 * A minimal protocol-buffers wire codec — only what the Signal messages postbote reads need:
 * varints (up to 64 bit, as `bigint` where it matters), length-delimited fields, fixed64 and
 * fixed32 skipped or read. Pure: no dependency, runs the same on GJS and Node.
 *
 * Why not protobufjs: the schema postbote reads is a few dozen fields of Signal's
 * `SignalService.proto`, and a decoder table next to the field numbers (`schema.ts`) is easier to
 * audit than a generated module. Unknown fields are skipped, as the wire format intends.
 */

export type WireValue = bigint | Uint8Array;

/** All values of every field of one message, by field number, in wire order. */
export type Fields = Map<number, WireValue[]>;

function readVarint(bytes: Uint8Array, pos: { i: number }): bigint {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos.i >= bytes.length) throw new Error('protobuf: truncated varint');
    const byte = bytes[pos.i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
    if (shift > 63n) throw new Error('protobuf: varint too long');
  }
}

/** Decode one message's fields. Throws on a malformed or truncated message. */
export function decodeFields(bytes: Uint8Array): Fields {
  const fields: Fields = new Map();
  const pos = { i: 0 };
  while (pos.i < bytes.length) {
    const key = readVarint(bytes, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new Error('protobuf: field number 0');
    let value: WireValue;
    switch (wire) {
      case 0:
        value = readVarint(bytes, pos);
        break;
      case 1: {
        if (pos.i + 8 > bytes.length) throw new Error('protobuf: truncated fixed64');
        let v = 0n;
        for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(bytes[pos.i + b]);
        value = v;
        pos.i += 8;
        break;
      }
      case 2: {
        const length = Number(readVarint(bytes, pos));
        if (pos.i + length > bytes.length) throw new Error('protobuf: truncated bytes');
        value = bytes.subarray(pos.i, pos.i + length);
        pos.i += length;
        break;
      }
      case 5: {
        if (pos.i + 4 > bytes.length) throw new Error('protobuf: truncated fixed32');
        value = BigInt(
          (bytes[pos.i] | (bytes[pos.i + 1] << 8) | (bytes[pos.i + 2] << 16) | (bytes[pos.i + 3] << 24)) >>>
            0,
        );
        pos.i += 4;
        break;
      }
      default:
        throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

// ── typed accessors (the last value wins for a non-repeated field, as the spec says) ──

function last(fields: Fields, n: number): WireValue | undefined {
  const list = fields.get(n);
  return list?.[list.length - 1];
}

export function bytesField(fields: Fields, n: number): Uint8Array | null {
  const v = last(fields, n);
  return v instanceof Uint8Array ? v : null;
}

export function stringField(fields: Fields, n: number): string | null {
  const v = bytesField(fields, n);
  return v ? new TextDecoder().decode(v) : null;
}

export function bigintField(fields: Fields, n: number): bigint | null {
  const v = last(fields, n);
  return typeof v === 'bigint' ? v : null;
}

/** A 64-bit field read as a JS number — safe for millisecond timestamps and small ids. */
export function numberField(fields: Fields, n: number): number | null {
  const v = bigintField(fields, n);
  return v === null ? null : Number(v);
}

export function boolField(fields: Fields, n: number): boolean | null {
  const v = bigintField(fields, n);
  return v === null ? null : v !== 0n;
}

export function messageField(fields: Fields, n: number): Fields | null {
  const v = bytesField(fields, n);
  return v ? decodeFields(v) : null;
}

export function repeatedBytes(fields: Fields, n: number): Uint8Array[] {
  return (fields.get(n) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
}

export function repeatedMessages(fields: Fields, n: number): Fields[] {
  return repeatedBytes(fields, n).map(decodeFields);
}

export function repeatedNumbers(fields: Fields, n: number): number[] {
  const out: number[] = [];
  for (const v of fields.get(n) ?? []) {
    if (typeof v === 'bigint') out.push(Number(v));
    else {
      // A packed repeated varint field.
      const pos = { i: 0 };
      while (pos.i < v.length) out.push(Number(readVarint(v, pos)));
    }
  }
  return out;
}

/** Read one varint-length-delimited frame from a stream at `offset` (`ContactDetails` blobs). */
export function readDelimited(bytes: Uint8Array, offset: number): { frame: Uint8Array; next: number } | null {
  if (offset >= bytes.length) return null;
  const pos = { i: offset };
  const length = Number(readVarint(bytes, pos));
  if (pos.i + length > bytes.length) throw new Error('protobuf: truncated delimited frame');
  return { frame: bytes.subarray(pos.i, pos.i + length), next: pos.i + length };
}

// ── writer ──────────────────────────────────────────────────────────────

/** Builds one message. Fields are written in the order they are added. */
export class ProtoWriter {
  private readonly parts: number[] = [];

  private varint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    while (v >= 0x80n) {
      this.parts.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.parts.push(Number(v));
  }

  private key(field: number, wire: number): void {
    this.varint((BigInt(field) << 3n) | BigInt(wire));
  }

  uint(field: number, value: number | bigint | null | undefined): this {
    if (value === null || value === undefined) return this;
    this.key(field, 0);
    this.varint(BigInt(value));
    return this;
  }

  bool(field: number, value: boolean | null | undefined): this {
    if (value === null || value === undefined) return this;
    return this.uint(field, value ? 1 : 0);
  }

  bytes(field: number, value: Uint8Array | null | undefined): this {
    if (value === null || value === undefined) return this;
    this.key(field, 2);
    this.varint(BigInt(value.length));
    for (const b of value) this.parts.push(b);
    return this;
  }

  string(field: number, value: string | null | undefined): this {
    if (value === null || value === undefined) return this;
    return this.bytes(field, new TextEncoder().encode(value));
  }

  message(field: number, value: ProtoWriter | null | undefined): this {
    if (!value) return this;
    return this.bytes(field, value.finish());
  }

  fixed64(field: number, value: bigint | null | undefined): this {
    if (value === null || value === undefined) return this;
    this.key(field, 1);
    let v = BigInt.asUintN(64, value);
    for (let b = 0; b < 8; b++) {
      this.parts.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return this;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.parts);
  }
}

/** Prefix a frame with its varint length (the inverse of `readDelimited`). */
export function delimited(frame: Uint8Array): Uint8Array<ArrayBuffer> {
  const w = new ProtoWriter();
  // Reuse the writer's varint through a bytes field, then drop the one-byte key.
  const withKey = w.bytes(1, frame).finish();
  return withKey.slice(1);
}
