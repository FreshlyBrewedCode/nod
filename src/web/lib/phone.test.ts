import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PHONE_BREAKPOINT, PHONE_QUERY, isPhoneWidth, isStandalone } from "./phone";

describe("phone breakpoint", () => {
  test("a phone is narrower than 640 px", () => {
    expect(isPhoneWidth(360)).toBe(true);
    expect(isPhoneWidth(639)).toBe(true);
    expect(isPhoneWidth(640)).toBe(false);
    expect(isPhoneWidth(1440)).toBe(false);
  });

  test("the media query names the same width", () => {
    expect(PHONE_QUERY).toBe("(width < 640px)");
  });

  test("styles.css defines the phone variant with the same query", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain(`@custom-variant phone (@media ${PHONE_QUERY});`);
    expect(css).toContain(`@media ${PHONE_QUERY}`);
    expect(PHONE_BREAKPOINT).toBe(640);
  });
});

describe("isStandalone", () => {
  const media = (matches: boolean) => () => ({ matches });
  test("iOS's navigator.standalone, or the display-mode query", () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ navigator: {}, matchMedia: media(true) })).toBe(true);
    expect(isStandalone({ navigator: { standalone: false }, matchMedia: media(false) })).toBe(
      false,
    );
    expect(isStandalone({})).toBe(false);
    expect(
      isStandalone({
        matchMedia: () => {
          throw new Error("no");
        },
      }),
    ).toBe(false);
  });
});

test("the home-screen app's colours are r3's background", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const bg = /--bg:\s*(#[0-9a-f]{6});/.exec(css)?.[1];
  const manifest = JSON.parse(
    readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  ) as { theme_color: string; background_color: string };
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(bg).toBeDefined();
  expect(manifest.theme_color).toBe(bg!);
  expect(manifest.background_color).toBe(bg!);
  expect(html).toContain(`<meta name="theme-color" content="${bg}" />`);
});
