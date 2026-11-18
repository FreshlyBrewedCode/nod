import { describe, expect, test } from "bun:test";

import { selectionReducer as reduce } from "./selection";

describe("selection", () => {
  test("toggle adds at the end and removes", () => {
    let s = reduce([], { t: "toggle", pr: 482 });
    s = reduce(s, { t: "toggle", pr: 485 });
    expect(s).toEqual([482, 485]);
    expect(reduce(s, { t: "toggle", pr: 482 })).toEqual([485]);
  });

  test("add skips what is already in, and duplicates", () => {
    expect(reduce([482], { t: "add", prs: [485, 482, 485] })).toEqual([482, 485]);
    const same = [482];
    expect(reduce(same, { t: "add", prs: [482] })).toBe(same);
  });

  test("clear", () => {
    expect(reduce([1, 2], { t: "clear" })).toEqual([]);
    const empty: number[] = [];
    expect(reduce(empty, { t: "clear" })).toBe(empty);
  });

  test("keep drops what can no longer be selected, and keeps the state when nothing changes", () => {
    expect(reduce([482, 485, 488], { t: "keep", prs: [488, 482] })).toEqual([482, 488]);
    const s = [482];
    expect(reduce(s, { t: "keep", prs: [482, 485] })).toBe(s);
  });
});
