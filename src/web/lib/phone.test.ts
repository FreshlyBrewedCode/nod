import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PHONE_BREAKPOINT, PHONE_QUERY, isPhoneWidth } from "./phone";

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
