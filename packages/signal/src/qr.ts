/**
 * The linking QR code as terminal text.
 *
 * A copy of `@postbote/whatsapp`'s renderer, on purpose: WhatsApp's package is kept
 * self-contained so it can leave the repository in one step (ADR 0001 §5), so nothing is shared
 * out of it. Two modules per character cell (upper and lower half blocks), white on black with
 * the four-module quiet zone, so it scans the same on a dark and a light terminal theme.
 */

import qrcode from 'qrcode-generator';

const QUIET = 4;

export function renderQr(data: string, color = true): string {
  const code = qrcode(0, 'L');
  code.addData(data);
  code.make();
  const size = code.getModuleCount();
  const dark = (row: number, col: number) =>
    row >= 0 && col >= 0 && row < size && col < size && code.isDark(row, col);
  const lines: string[] = [];
  for (let row = -QUIET; row < size + QUIET; row += 2) {
    let line = '';
    for (let col = -QUIET; col < size + QUIET; col++) {
      const top = !dark(row, col);
      const bottom = row + 1 < size + QUIET && !dark(row + 1, col);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(color ? `\u001b[97;40m${line}\u001b[0m` : line);
  }
  return lines.join('\n');
}
