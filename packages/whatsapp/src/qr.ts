/**
 * The linking QR code as terminal text.
 *
 * Two modules per character cell (upper and lower half blocks), in explicit colours — white on
 * black, with the four-module quiet zone the standard asks for — so it scans the same on a
 * dark and a light terminal theme.
 */

import qrcode from 'qrcode-generator';

const QUIET = 4;
const LIGHT_DARK = '▀'; // upper half light
const DARK_LIGHT = '▄'; // lower half light
const BOTH_LIGHT = '█';

/** True when the module at (row, col) is dark; outside the symbol is the light quiet zone. */
export type ModuleGrid = (row: number, col: number) => boolean;

export function qrModules(data: string): { size: number; dark: ModuleGrid } {
  const code = qrcode(0, 'L');
  code.addData(data);
  code.make();
  const size = code.getModuleCount();
  return {
    size,
    dark: (row, col) => row >= 0 && col >= 0 && row < size && col < size && code.isDark(row, col),
  };
}

/** Render a module grid; `color` false gives plain text (for a test). */
export function renderModules(size: number, dark: ModuleGrid, color = true): string {
  const lines: string[] = [];
  for (let row = -QUIET; row < size + QUIET; row += 2) {
    let line = '';
    for (let col = -QUIET; col < size + QUIET; col++) {
      const top = !dark(row, col);
      const bottom = row + 1 < size + QUIET && !dark(row + 1, col);
      line += top && bottom ? BOTH_LIGHT : top ? LIGHT_DARK : bottom ? DARK_LIGHT : ' ';
    }
    lines.push(color ? `\u001b[97;40m${line}\u001b[0m` : line);
  }
  return lines.join('\n');
}

export function renderQr(data: string, color = true): string {
  const { size, dark } = qrModules(data);
  return renderModules(size, dark, color);
}
