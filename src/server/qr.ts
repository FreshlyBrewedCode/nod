/**
 * The device link as a QR code in the terminal (ADR 0005): the link reaches
 * the other device through its camera, never through a chat or a synced
 * clipboard. Encoded by `uqr` (zero dependencies); drawn here with half
 * blocks, two modules per character row, light modules filled, so it reads
 * on a dark terminal (phone cameras read the inverse on a light one too).
 */

import { encode } from "uqr";

/** Light modules around the code; the standard asks for 4, 2 scan fine. */
const QUIET = 2;

/** `text` as lines of `█▀▄ `; every line is as wide as the code. */
export function qrLines(text: string): string[] {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const full = size + 2 * QUIET;
  // true = dark; outside the code is the light quiet zone.
  const dark = (x: number, y: number) => {
    const cx = x - QUIET;
    const cy = y - QUIET;
    return cx >= 0 && cy >= 0 && cx < size && cy < size && data[cy]![cx]!;
  };
  const lines: string[] = [];
  for (let y = 0; y < full; y += 2) {
    let line = "";
    for (let x = 0; x < full; x++) {
      const top = !dark(x, y);
      const bottom = y + 1 < full && !dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines;
}
