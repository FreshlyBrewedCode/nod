import { describe, expect, test } from "bun:test";

import { clusterKey, moveFocus, prKey, prOfKey, reconcileFocus } from "./focus";

const keys = [prKey(476), prKey(485), clusterKey("background"), prKey(489)];

describe("moveFocus", () => {
  test("down and up, stopping at the ends", () => {
    expect(moveFocus(keys, prKey(476), 1)).toBe(prKey(485));
    expect(moveFocus(keys, prKey(485), 1)).toBe("cluster:background");
    expect(moveFocus(keys, prKey(489), 1)).toBe(prKey(489));
    expect(moveFocus(keys, prKey(476), -1)).toBe(prKey(476));
  });

  test("no focus: down starts at the top, up at the bottom", () => {
    expect(moveFocus(keys, null, 1)).toBe(prKey(476));
    expect(moveFocus(keys, null, -1)).toBe(prKey(489));
    expect(moveFocus(keys, "pr:1", 1)).toBe(prKey(476));
    expect(moveFocus([], null, 1)).toBeNull();
  });
});

describe("reconcileFocus", () => {
  test("stays on its row", () => {
    expect(reconcileFocus(keys, [...keys].reverse(), prKey(485))).toBe(prKey(485));
  });

  test("a row that left hands focus to the next one still there", () => {
    const after = [prKey(476), clusterKey("background"), prKey(489)];
    expect(reconcileFocus(keys, after, prKey(485))).toBe("cluster:background");
  });

  test("the last row left: the one before it", () => {
    expect(reconcileFocus(keys, keys.slice(0, 3), prKey(489))).toBe("cluster:background");
  });

  test("nothing left, or nothing focused", () => {
    expect(reconcileFocus(keys, [], prKey(476))).toBeNull();
    expect(reconcileFocus(keys, keys, null)).toBeNull();
  });

  test("a row that was never there while it had focus: nothing", () => {
    expect(reconcileFocus(keys, keys, "pr:1")).toBeNull();
  });
});

describe("keys", () => {
  test("the PR of a key", () => {
    expect(prOfKey(prKey(482))).toBe(482);
    expect(prOfKey(clusterKey("bucket:today"))).toBeNull();
    expect(prOfKey(null)).toBeNull();
  });
});
