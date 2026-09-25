/**
 * The terminal's side of `AccountPrompter`: questions on stderr, answers from stdin.
 *
 * ONE readline interface for the whole login, with its own line queue: a second interface on the
 * same stdin would lose whatever the first had already buffered, which is exactly what happens
 * when the answers are piped in. Secret answers are read with echo off when stdin is a terminal
 * (readline's echo goes through a muted stream); piped input is not echoed anyway.
 */

import type { AccountPrompter } from '@postbote/protocol';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function terminalPrompter(): AccountPrompter & { close(): void } {
  const tty = Boolean((process.stdin as { isTTY?: boolean }).isTTY);
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });

  return {
    async ask(label, options = {}) {
      process.stderr.write(`${label}: `);
      muted = Boolean(options.secret) && tty;
      const buffered = lines.shift();
      const line =
        buffered !== undefined
          ? buffered
          : closed
            ? null
            : await new Promise<string | null>((resolve) => waiting.push(resolve));
      if (muted) process.stderr.write('\n');
      muted = false;
      if (line === null) throw new Error('input ended before the login was complete — nothing was saved');
      return line.trim();
    },
    notify(message) {
      process.stderr.write(`${message}\n`);
    },
    close() {
      rl.close();
    },
  };
}
