import { describe, expect, test } from "bun:test";

import {
  OPENED_LIMIT,
  markOpened,
  readJson,
  readOpened,
  wasOpened,
  writeJson,
  type Opened,
} from "./storage";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("json storage", () => {
  test("round trip; broken and missing read as null; no storage is fine", () => {
    const s = memory();
    writeJson(s, "a", { open: true });
    expect(readJson(s, "a")).toEqual({ open: true });
    s.setItem("b", "{nope");
    expect(readJson(s, "b")).toBeNull();
    expect(readJson(s, "c")).toBeNull();
    expect(readJson(null, "a")).toBeNull();
    writeJson(null, "a", 1);
  });

  test("a throwing storage never throws", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {},
    };
    expect(readJson(s, "a")).toBeNull();
    writeJson(s, "a", 1);
  });
});

describe("opened in the UI", () => {
  test("per repo and number", () => {
    const o = markOpened({}, "tallyho/fieldbook", 482, 1000);
    expect(wasOpened(o, "tallyho/fieldbook", 482)).toBe(true);
    expect(wasOpened(o, "tallyho/fieldbook", 485)).toBe(false);
    expect(wasOpened(o, "tallyho/other", 482)).toBe(false);
  });

  test("only numbers survive reading", () => {
    expect(readOpened({ "a/b#1": 5, "a/b#2": "x" })).toEqual({ "a/b#1": 5 });
    expect(readOpened([1])).toEqual({});
    expect(readOpened(null)).toEqual({});
  });

  test("the oldest are dropped beyond the limit", () => {
    let o: Opened = {};
    for (let i = 0; i <= OPENED_LIMIT; i++) o = markOpened(o, "a/b", i, i);
    expect(Object.keys(o)).toHaveLength(OPENED_LIMIT);
    expect(wasOpened(o, "a/b", 0)).toBe(false);
    expect(wasOpened(o, "a/b", OPENED_LIMIT)).toBe(true);
  });
});
