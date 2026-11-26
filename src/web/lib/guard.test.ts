import { describe, expect, test } from "bun:test";

import { ARM_MS, isFramed, untilArmed, visibleSince } from "./guard";

describe("armed after a second of being visible", () => {
  test("visible on mount: armed after ARM_MS, not before", () => {
    const since = visibleSince(null, true, 5000);
    expect(since).toBe(5000);
    expect(untilArmed(since, 5000)).toBe(ARM_MS);
    expect(untilArmed(since, 5090)).toBe(ARM_MS - 90);
    expect(untilArmed(since, 5000 + ARM_MS - 1)).toBe(1);
    expect(untilArmed(since, 5000 + ARM_MS)).toBe(0);
    expect(untilArmed(since, 99999)).toBe(0);
  });

  test("a page loaded hidden does not arrive armed: the count starts when it shows", () => {
    let since = visibleSince(null, false, 0);
    expect(untilArmed(since, 60000)).toBeNull();
    since = visibleSince(since, true, 60000);
    expect(untilArmed(since, 60000)).toBe(ARM_MS);
    expect(untilArmed(since, 60000 + ARM_MS)).toBe(0);
  });

  test("hidden again: the count starts over", () => {
    let since = visibleSince(null, true, 0);
    since = visibleSince(since, false, 900);
    expect(untilArmed(since, 900)).toBeNull();
    since = visibleSince(since, true, 950);
    expect(untilArmed(since, 1000)).toBe(ARM_MS - 50);
  });

  test("another visible event keeps the stretch it is in", () => {
    let since = visibleSince(null, true, 100);
    since = visibleSince(since, true, 700);
    expect(since).toBe(100);
  });
});

describe("isFramed", () => {
  test("a window that is its own top is not framed", () => {
    const win = {} as { top: unknown; self: unknown };
    win.top = win;
    win.self = win;
    expect(isFramed(win)).toBe(false);
  });

  test("a window inside another, or one whose top cannot be read, is", () => {
    expect(isFramed({ top: {}, self: {} })).toBe(true);
    const throwing = {
      self: {},
      get top(): unknown {
        throw new Error("blocked");
      },
    };
    expect(isFramed(throwing)).toBe(true);
  });
});
