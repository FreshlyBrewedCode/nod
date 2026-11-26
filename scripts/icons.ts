/**
 * The home-screen icons in `src/web/public/`, drawn from the favicon in
 * `src/web/index.html` (the amber rounded square with a check) and rendered
 * by the same Chromium `check:phone` uses: `bun scripts/icons.ts`. The PNGs
 * are committed; run this again only when the icon changes.
 *
 * - `icon.svg`, `icon-192.png`, `icon-512.png`: the favicon as it is (the
 *   manifest's "any" icons; Android shows them as drawn).
 * - `icon-maskable-512.png`: the square without corners and the check inside
 *   the safe zone, for launchers that cut their own shape.
 * - `apple-touch-icon.png` (180 × 180): without corners and opaque, as iOS
 *   rounds the corners itself and fills transparency with black.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launch } from "./check-phone";

const AMBER = "#f2b24a";
const CHECK = `<path d="M5 9.5l2.5 2.5L13 6.5" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;

/** The favicon: an 18 × 18 rounded square. */
const ROUNDED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><rect width="18" height="18" rx="5" fill="${AMBER}"/>${CHECK}</svg>`;

/** Full bleed; the check at `scale` of the favicon's size, centred as there. */
const square = (scale: number) => {
  const size = 18 / scale;
  const at = (18 - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${at} ${at} ${size} ${size}"><rect x="${at}" y="${at}" width="${size}" height="${size}" fill="${AMBER}"/>${CHECK}</svg>`;
};

const OUT = join(import.meta.dir, "..", "src", "web", "public");

async function main() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "icon.svg"), `${ROUNDED}\n`);
  const browser = await launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const render = async (svg: string, size: number, file: string) => {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      );
      await page.screenshot({ path: join(OUT, file), omitBackground: true });
    };
    await render(ROUNDED, 192, "icon-192.png");
    await render(ROUNDED, 512, "icon-512.png");
    // The safe zone of a maskable icon is the middle 80 %.
    await render(square(0.8), 512, "icon-maskable-512.png");
    await render(square(1), 180, "apple-touch-icon.png");
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
