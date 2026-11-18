import { describe, expect, test } from "bun:test";

import { diffBar, diffNumbers } from "./diff";

const round = (b: { added: number; removed: number }) => ({
  added: Math.round(b.added * 10) / 10,
  removed: Math.round(b.removed * 10) / 10,
});

describe("diffBar", () => {
  test("nothing changed: no bar", () => {
    expect(diffBar(0, 0)).toEqual({ added: 0, removed: 0 });
  });

  test("log scale: 9 lines a third, 99 two thirds, 999 full", () => {
    const len = (n: number) => {
      const b = diffBar(n, 0);
      return Math.round(b.added + b.removed);
    };
    expect(len(9)).toBe(33);
    expect(len(99)).toBe(67);
    expect(len(1000)).toBe(100);
  });

  test("capped at the full track", () => {
    expect(diffBar(5000, 5000).added + diffBar(5000, 5000).removed).toBe(100);
  });

  test("split by the added/removed ratio", () => {
    const b = diffBar(312, 88);
    expect(b.added / (b.added + b.removed)).toBeCloseTo(0.78, 5);
    expect(round(diffBar(10, 10))).toEqual({ added: 22, removed: 22 });
    expect(diffBar(0, 50).added).toBe(0);
  });

  test("negative counts count as zero", () => {
    expect(diffBar(-4, 0)).toEqual({ added: 0, removed: 0 });
  });
});

describe("diffNumbers", () => {
  test("a plus, a real minus, thousands grouped", () => {
    expect(diffNumbers(312, 88)).toEqual({ added: "+312", removed: "−88" });
    expect(diffNumbers(1204, 0)).toEqual({ added: "+1,204", removed: "−0" });
  });
});
