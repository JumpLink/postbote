import { describe, expect, it } from '@gjsify/unit';

import { BufferSink, decodingSink } from '@postbote/protocol';

/** Feed `data` through a decoding sink in fixed-size chunks and return the decoded bytes. */
async function decodeInChunks(encoding: string, data: string, chunkSize: number): Promise<Uint8Array> {
  const buffer = new BufferSink();
  const sink = decodingSink(encoding, buffer);
  const bytes = new TextEncoder().encode(data);
  for (let i = 0; i < bytes.length; i += chunkSize) {
    await sink.write(bytes.subarray(i, i + chunkSize));
  }
  await sink.close();
  return buffer.bytes();
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Chunk boundaries fall anywhere, so every case is run at several sizes — including 1, which
// splits every base64 quantum and every `=XX` escape. That is the whole reason these decoders
// are state machines rather than one-shot functions.
const CHUNK_SIZES = [1, 2, 3, 4, 5, 7, 64, 4096];

export default async () => {
  await describe('base64 streaming decode', async () => {
    await it('decodes across every chunk boundary', async () => {
      // "Rechnung März 2025 — Energieberatung"
      const encoded = 'UmVjaG51bmcgTcOkcnogMjAyNSDigJQgRW5lcmdpZWJlcmF0dW5n';
      for (const size of CHUNK_SIZES) {
        expect(text(await decodeInChunks('base64', encoded, size))).toBe(
          'Rechnung März 2025 — Energieberatung',
        );
      }
    });

    await it('ignores the CRLF that wraps every 76 columns', async () => {
      const encoded = 'UmVjaG51\r\nbmcgTcOk\r\ncnogMjAyNQ==';
      for (const size of CHUNK_SIZES) {
        expect(text(await decodeInChunks('base64', encoded, size))).toBe('Rechnung März 2025');
      }
    });

    await it('handles each padding length', async () => {
      expect(text(await decodeInChunks('base64', 'YWJj', 1))).toBe('abc'); // no padding
      expect(text(await decodeInChunks('base64', 'YWJjZA==', 1))).toBe('abcd'); // two pad
      expect(text(await decodeInChunks('base64', 'YWJjZGU=', 1))).toBe('abcde'); // one pad
    });

    await it('recovers the last bytes when padding is missing entirely', async () => {
      // Unpadded base64 is common in the wild; dropping the tail would silently truncate a file.
      expect(text(await decodeInChunks('base64', 'YWJjZA', 1))).toBe('abcd');
      expect(text(await decodeInChunks('base64', 'YWJjZGU', 3))).toBe('abcde');
    });

    await it('round-trips arbitrary binary, not just text', async () => {
      const original = new Uint8Array(1000);
      for (let i = 0; i < original.length; i++) original[i] = (i * 37) % 256;
      let b64 = '';
      const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      for (let i = 0; i < original.length; i += 3) {
        const [a, b, c] = [original[i], original[i + 1], original[i + 2]];
        b64 += TABLE[a >> 2];
        b64 += TABLE[((a & 3) << 4) | ((b ?? 0) >> 4)];
        b64 += b === undefined ? '=' : TABLE[((b & 15) << 2) | ((c ?? 0) >> 6)];
        b64 += c === undefined ? '=' : TABLE[c & 63];
      }
      const decoded = await decodeInChunks('base64', b64, 7);
      expect(decoded.length).toBe(original.length);
      let same = true;
      for (let i = 0; i < original.length; i++) if (decoded[i] !== original[i]) same = false;
      expect(same).toBe(true);
    });
  });

  await describe('quoted-printable streaming decode', async () => {
    await it('decodes =XX escapes across every chunk boundary', async () => {
      for (const size of CHUNK_SIZES) {
        expect(text(await decodeInChunks('quoted-printable', 'M=C3=A4rz', size))).toBe('März');
      }
    });

    await it('drops soft line breaks, in both CRLF and LF form', async () => {
      for (const size of CHUNK_SIZES) {
        expect(text(await decodeInChunks('quoted-printable', 'a very =\r\nlong line', size))).toBe(
          'a very long line',
        );
        expect(text(await decodeInChunks('quoted-printable', 'a very =\nlong line', size))).toBe(
          'a very long line',
        );
      }
    });

    await it('keeps a malformed escape verbatim rather than dropping data', async () => {
      for (const size of CHUNK_SIZES) {
        expect(text(await decodeInChunks('quoted-printable', 'cost: 100=ZZ', size))).toBe('cost: 100=ZZ');
      }
    });

    await it('emits a truncated trailing escape at flush', async () => {
      expect(text(await decodeInChunks('quoted-printable', 'abc=', 1))).toBe('abc=');
      expect(text(await decodeInChunks('quoted-printable', 'abc=C', 1))).toBe('abc=C');
    });

    await it('accepts lowercase hex', async () => {
      expect(text(await decodeInChunks('quoted-printable', 'M=c3=a4rz', 1))).toBe('März');
    });
  });

  await describe('identity encodings', async () => {
    await it('passes 7bit, 8bit and binary straight through', async () => {
      for (const enc of ['7BIT', '8bit', 'BINARY']) {
        expect(text(await decodeInChunks(enc, 'plain text', 3))).toBe('plain text');
      }
    });

    await it('passes an unknown encoding through rather than failing the download', async () => {
      expect(text(await decodeInChunks('x-uuencode-ish', 'plain text', 3))).toBe('plain text');
    });

    await it('returns the very same sink for an identity encoding', async () => {
      // Not an optimization detail: it means no wrapper sits between the reader and the file in
      // the common case, so there is nothing to get the ordering wrong.
      const buffer = new BufferSink();
      expect(decodingSink('7bit', buffer)).toBe(buffer);
    });
  });

  await describe('sink contract', async () => {
    await it('forwards abort and writes nothing', async () => {
      const buffer = new BufferSink();
      const sink = decodingSink('base64', buffer);
      await sink.write(new TextEncoder().encode('YWJj'));
      await sink.abort('too large');
      expect(buffer.aborted).toBe('too large');
      expect(buffer.bytes().length).toBe(0);
    });

    await it('closes the inner sink exactly once, after the last byte', async () => {
      const buffer = new BufferSink();
      const sink = decodingSink('base64', buffer);
      await sink.write(new TextEncoder().encode('YWJjZA=='));
      expect(buffer.closed).toBe(false);
      await sink.close();
      expect(buffer.closed).toBe(true);
      expect(text(buffer.bytes())).toBe('abcd');
    });
  });
};
