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

/** A PR row's key in the one repo these tests use. */
const k = (n: number) => prKey(`tallyho/fieldbook#${n}`);

describe("the board", () => {
  // You · Jonas (empty) · Agents & CI (a card and a cluster) · Merged
  const columns = [
    [k(476), k(485), k(482)],
    [],
    [k(478), clusterKey("column:automation")],
    [k(487)],
  ];

  test("j/k move within a column, stopping at its ends", () => {
    expect(moveBoardFocus(columns, k(476), "down")).toBe(k(485));
    expect(moveBoardFocus(columns, k(482), "down")).toBe(k(482));
    expect(moveBoardFocus(columns, k(476), "up")).toBe(k(476));
  });

  test("h/l jump to the next column with cards, at the same height or its last card", () => {
    expect(moveBoardFocus(columns, k(485), "right")).toBe("cluster:column:automation");
    expect(moveBoardFocus(columns, k(482), "right")).toBe("cluster:column:automation");
    expect(moveBoardFocus(columns, k(478), "right")).toBe(k(487));
    expect(moveBoardFocus(columns, k(487), "right")).toBe(k(487));
    expect(moveBoardFocus(columns, k(478), "left")).toBe(k(476));
    expect(moveBoardFocus(columns, k(476), "left")).toBe(k(476));
  });

  test("no focus, or a focus that left: the first card", () => {
    expect(moveBoardFocus(columns, null, "right")).toBe(k(476));
    expect(moveBoardFocus(columns, k(999), "down")).toBe(k(476));
    expect(moveBoardFocus([[], []], null, "down")).toBeNull();
  });

  test("the keys of a column: an open cluster brings its cards", () => {
    const items = [
      { kind: "pr", pr: { repo: "tallyho/fieldbook", number: 478 } },
      {
        kind: "cluster",
        id: "column:automation",
        prs: [
          { repo: "tallyho/fieldbook", number: 483 },
          { repo: "tallyho/fieldbook", number: 481 },
        ],
      },
    ] as const;
    expect(itemKeys(items, new Set())).toEqual([k(478), "cluster:column:automation"]);
    expect(itemKeys(items, new Set(["column:automation"]))).toEqual([
      k(478),
      "cluster:column:automation",
      k(483),
      k(481),
    ]);
  });
});

const keys = [k(476), k(485), clusterKey("background"), k(489)];

describe("moveFocus", () => {
  test("down and up, stopping at the ends", () => {
    expect(moveFocus(keys, k(476), 1)).toBe(k(485));
    expect(moveFocus(keys, k(485), 1)).toBe("cluster:background");
    expect(moveFocus(keys, k(489), 1)).toBe(k(489));
    expect(moveFocus(keys, k(476), -1)).toBe(k(476));
  });

  test("no focus: down starts at the top, up at the bottom", () => {
    expect(moveFocus(keys, null, 1)).toBe(k(476));
    expect(moveFocus(keys, null, -1)).toBe(k(489));
    expect(moveFocus(keys, "pr:1", 1)).toBe(k(476));
    expect(moveFocus([], null, 1)).toBeNull();
  });
});

describe("reconcileFocus", () => {
  test("stays on its row", () => {
    expect(reconcileFocus(keys, [...keys].reverse(), k(485))).toBe(k(485));
  });

  test("a row that left hands focus to the next one still there", () => {
    const after = [k(476), clusterKey("background"), k(489)];
    expect(reconcileFocus(keys, after, k(485))).toBe("cluster:background");
  });

  test("the last row left: the one before it", () => {
    expect(reconcileFocus(keys, keys.slice(0, 3), k(489))).toBe("cluster:background");
  });

  test("nothing left, or nothing focused", () => {
    expect(reconcileFocus(keys, [], k(476))).toBeNull();
    expect(reconcileFocus(keys, keys, null)).toBeNull();
  });

  test("a row that was never there while it had focus: nothing", () => {
    expect(reconcileFocus(keys, keys, "pr:1")).toBeNull();
  });
});

describe("keys", () => {
  test("the PR of a key", () => {
    expect(prOfKey(k(482))).toBe("tallyho/fieldbook#482");
    expect(prOfKey(prKey("acme.ghe.com/finance/ledger#57"))).toBe("acme.ghe.com/finance/ledger#57");
    expect(prOfKey(clusterKey("bucket:today"))).toBeNull();
    expect(prOfKey(null)).toBeNull();
  });
});
