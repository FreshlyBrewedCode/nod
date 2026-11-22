import { describe, expect, test } from "bun:test";

import type { Item } from "../../shared/attention";
import type { PrView } from "../../shared/protocol";
import { lastOneLeft, needsYouOrder, nextNeedingYou, positionAmong } from "./next";

const pr = (number: number) => ({ number }) as PrView;

describe("needsYouOrder", () => {
  test("takes the PRs in lane order, a cluster's inside it", () => {
    const items = [
      { kind: "pr", pr: pr(3), tier: 1, form: 1 },
      { kind: "cluster", id: "needs", prs: [pr(9), pr(8)] },
      { kind: "pr", pr: pr(5), tier: 2, form: 2 },
    ] as unknown as ReadonlyArray<Item>;
    expect(needsYouOrder(items)).toEqual([3, 9, 8, 5]);
  });
});

describe("positionAmong", () => {
  test("is the 1-based place and the total", () => {
    expect(positionAmong([4, 7, 9], 7)).toEqual({ index: 2, total: 3 });
  });
  test("is null for a PR that does not need me", () => {
    expect(positionAmong([4, 7, 9], 1)).toBeNull();
  });
});

describe("nextNeedingYou", () => {
  test("is the one after, and none after the last", () => {
    expect(nextNeedingYou([4, 7, 9], 4)).toBe(7);
    expect(nextNeedingYou([4, 7, 9], 7)).toBe(9);
    expect(nextNeedingYou([4, 7, 9], 9)).toBeNull();
  });
  test("a PR outside the order takes the first", () => {
    expect(nextNeedingYou([4, 7, 9], 1)).toBe(4);
    expect(nextNeedingYou([], 1)).toBeNull();
  });
});

describe("lastOneLeft", () => {
  test("is the one that is left when exactly one is", () => {
    expect(lastOneLeft([1, 2, 3], [1, 2])).toBe(3);
  });
  test("is null for none or several", () => {
    expect(lastOneLeft([1, 2], [1, 2])).toBeNull();
    expect(lastOneLeft([1, 2, 3], [1])).toBeNull();
  });
  test("a signed PR that already left the lane does not count twice", () => {
    expect(lastOneLeft([3], [1, 2])).toBe(3);
  });
});
