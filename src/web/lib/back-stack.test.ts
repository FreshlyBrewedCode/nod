import { describe, expect, test } from "bun:test";

import { isDeadForward, layerOf, layerState, onPop } from "./back-stack";

describe("layerOf", () => {
  test("reads what layerState wrote", () => {
    expect(layerOf(layerState(2))).toBe(2);
  });
  test("is 0 for the entries that are not ours", () => {
    for (const state of [
      null,
      undefined,
      {},
      { nodLayer: 0 },
      { nodLayer: "1" },
      { nodLayer: 1.5 },
      3,
    ])
      expect(layerOf(state)).toBe(0);
  });
});

describe("onPop", () => {
  test("an overlay stays while the entry is its own or above", () => {
    expect(onPop(1, 1, false)).toBe("stay");
    expect(onPop(1, 2, false)).toBe("stay");
  });
  test("it closes when back landed below it", () => {
    expect(onPop(1, 0, false)).toBe("close");
    expect(onPop(2, 1, false)).toBe("close");
  });
  test("while blocked it is put back instead", () => {
    expect(onPop(2, 1, true)).toBe("restore");
    expect(onPop(2, 2, true)).toBe("stay");
  });
});

describe("isDeadForward", () => {
  test("an entry deeper than what is open is dead", () => {
    expect(isDeadForward(0, 1)).toBe(true);
    expect(isDeadForward(1, 2)).toBe(true);
    expect(isDeadForward(1, 1)).toBe(false);
    expect(isDeadForward(2, 1)).toBe(false);
  });
});
