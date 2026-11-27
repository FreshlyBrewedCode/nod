import { describe, expect, test } from "bun:test";

import { selectionReducer as reduce } from "./selection";

const A = (n: number) => `tallyho/fieldbook#${n}`;
const B = (n: number) => `acme.ghe.com/finance/ledger#${n}`;

describe("selection", () => {
  test("toggle adds at the end and removes", () => {
    let s = reduce([], { t: "toggle", pr: A(482) });
    s = reduce(s, { t: "toggle", pr: A(485) });
    expect(s).toEqual([A(482), A(485)]);
    expect(reduce(s, { t: "toggle", pr: A(482) })).toEqual([A(485)]);
  });

  test("a PR is (repo, number): the same number in two repos is two PRs", () => {
    const s = reduce(reduce([], { t: "toggle", pr: A(7) }), { t: "toggle", pr: B(7) });
    expect(s).toEqual([A(7), B(7)]);
    expect(reduce(s, { t: "toggle", pr: A(7) })).toEqual([B(7)]);
  });

  test("add skips what is already in, and duplicates", () => {
    expect(reduce([A(482)], { t: "add", prs: [A(485), A(482), A(485)] })).toEqual([A(482), A(485)]);
    const same = [A(482)];
    expect(reduce(same, { t: "add", prs: [A(482)] })).toBe(same);
  });

  test("clear", () => {
    expect(reduce([A(1), A(2)], { t: "clear" })).toEqual([]);
    const empty: string[] = [];
    expect(reduce(empty, { t: "clear" })).toBe(empty);
  });

  test("keep drops what can no longer be selected, and keeps the state when nothing changes", () => {
    expect(reduce([A(482), A(485), A(488)], { t: "keep", prs: [A(488), A(482)] })).toEqual([
      A(482),
      A(488),
    ]);
    const s = [A(482)];
    expect(reduce(s, { t: "keep", prs: [A(482), A(485)] })).toBe(s);
  });
});
