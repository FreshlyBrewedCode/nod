import { describe, expect, test } from "bun:test";

import {
  clusterKey,
  itemKeys,
  moveBoardFocus,
  moveFocus,
  prKey,
  prOfKey,
  reconcileFocus,
} from "./focus";

describe("the board", () => {
  // You · Jonas (empty) · Agents & CI (a card and a cluster) · Merged
  const columns = [
    [prKey(476), prKey(485), prKey(482)],
    [],
    [prKey(478), clusterKey("column:automation")],
    [prKey(487)],
  ];

  test("j/k move within a column, stopping at its ends", () => {
    expect(moveBoardFocus(columns, prKey(476), "down")).toBe(prKey(485));
    expect(moveBoardFocus(columns, prKey(482), "down")).toBe(prKey(482));
    expect(moveBoardFocus(columns, prKey(476), "up")).toBe(prKey(476));
  });

  test("h/l jump to the next column with cards, at the same height or its last card", () => {
    expect(moveBoardFocus(columns, prKey(485), "right")).toBe("cluster:column:automation");
    expect(moveBoardFocus(columns, prKey(482), "right")).toBe("cluster:column:automation");
    expect(moveBoardFocus(columns, prKey(478), "right")).toBe(prKey(487));
    expect(moveBoardFocus(columns, prKey(487), "right")).toBe(prKey(487));
    expect(moveBoardFocus(columns, prKey(478), "left")).toBe(prKey(476));
    expect(moveBoardFocus(columns, prKey(476), "left")).toBe(prKey(476));
  });

  test("no focus, or a focus that left: the first card", () => {
    expect(moveBoardFocus(columns, null, "right")).toBe(prKey(476));
    expect(moveBoardFocus(columns, prKey(999), "down")).toBe(prKey(476));
    expect(moveBoardFocus([[], []], null, "down")).toBeNull();
  });

  test("the keys of a column: an open cluster brings its cards", () => {
    const items = [
      { kind: "pr", pr: { number: 478 } },
      { kind: "cluster", id: "column:automation", prs: [{ number: 483 }, { number: 481 }] },
    ] as const;
    expect(itemKeys(items, new Set())).toEqual([prKey(478), "cluster:column:automation"]);
    expect(itemKeys(items, new Set(["column:automation"]))).toEqual([
      prKey(478),
      "cluster:column:automation",
      prKey(483),
      prKey(481),
    ]);
  });
});

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
