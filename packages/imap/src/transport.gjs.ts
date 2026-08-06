/**
 * IMAP transport: the TLS socket and an incremental reader over it (GJS-only).
 *
 * Split out of the old mail.gjs.ts so the protocol client above it has no socket details, and
 * so the one place that touches Gio streams is small enough to read in full.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

import { bytesToLatin1, GnomeError, type MailTarget } from '@postbote/protocol';

export const READ_CHUNK = 8192;

// Promisify the Gio async I/O we use (callback-only in @girs).
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async', 'connect_to_host_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

/** Incremental latin1 line/byte reader over a Gio input stream. */
export class ByteReader {
  // NOT a TypeScript parameter property: Node's --experimental-strip-types rejects those, which
  // would break the Node half of the test run. Same constraint as the error classes.
  private readonly stream: Gio.InputStream;
  private buf = new Uint8Array(0);

  constructor(stream: Gio.InputStream) {
    this.stream = stream;
  }

  private async fill(): Promise<boolean> {
    const bytes = await this.stream.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, null);
    const arr = bytes.toArray();
    if (arr.length === 0) return false; // EOF
    const merged = new Uint8Array(this.buf.length + arr.length);
    merged.set(this.buf);
    merged.set(arr, this.buf.length);
    this.buf = merged;
    return true;
  }

  /** Read one CRLF-terminated line as latin1 (without the terminator); null at EOF. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        let end = nl;
        if (end > 0 && this.buf[end - 1] === 0x0d) end--; // strip CR
        const line = bytesToLatin1(this.buf.subarray(0, end));
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        const line = bytesToLatin1(this.buf);
        this.buf = new Uint8Array(0);
        return line;
      }
    }
  }

  /** Read exactly n raw bytes (fewer only at EOF). */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.fill())) break;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(out.length);
    return out;
  }
}

/** Open a TLS connection to the target's IMAP port. */
export async function openTlsStream(target: MailTarget): Promise<Gio.IOStream> {
  if (!target.implicitTls) {
    throw new GnomeError(
      `account ${target.accountId} uses STARTTLS (port ${target.port}); only implicit TLS (993) is supported currently`,
    );
  }
  const socketClient = new Gio.SocketClient();
  socketClient.set_tls(true);
  return socketClient.connect_to_host_async(target.host, target.port, null);
}
