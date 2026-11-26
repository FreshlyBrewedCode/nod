import { expect, test } from "bun:test";
import { encode } from "uqr";

import { qrLines } from "./qr";

const LINK =
  "https://laptop.example-tailnet.ts.net:8445/#host=wss%3A%2F%2Flaptop.example-tailnet.ts.net%3A8445&token=Qx7fT0mFakeFakeFakeFakeFakeFakeFakek2Vd9abc";

test("a device link fits a terminal: one block per module, two rows per line", () => {
  const { size } = encode(LINK, { ecc: "M", border: 0 });
  const lines = qrLines(LINK);
  const width = size + 4;
  expect(width).toBeLessThanOrEqual(80);
  expect(lines).toHaveLength(Math.ceil(width / 2));
  for (const line of lines) expect([...line]).toHaveLength(width);
  // The quiet zone is light all round: the first line and the edges are filled.
  expect(lines[0]).toBe("█".repeat(width));
  for (const line of lines.slice(0, -1))
    expect(line.startsWith("██") && line.endsWith("██")).toBe(true);
});

test("the drawing is the code: each character is its two modules", () => {
  const { data, size } = encode(LINK, { ecc: "M", border: 0 });
  const lines = qrLines(LINK);
  const dark = (x: number, y: number) =>
    x >= 2 && y >= 2 && x < size + 2 && y < size + 2 && data[y - 2]![x - 2]!;
  for (let y = 0; y < size + 4; y++)
    for (let x = 0; x < size + 4; x++) {
      const char = [...lines[y >> 1]!][x]!;
      const light = y % 2 === 0 ? "█▀".includes(char) : "█▄".includes(char);
      expect(light).toBe(!dark(x, y));
    }
});
