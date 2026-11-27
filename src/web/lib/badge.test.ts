import { describe, expect, test } from "bun:test";

import { applyBadge, canBadge, readBadgeOn, titleFor, writeBadgeOn, type BadgeApi } from "./badge";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function recorder() {
  const calls: string[] = [];
  const api: BadgeApi = {
    setAppBadge: async (n) => void calls.push(`set ${n}`),
    clearAppBadge: async () => void calls.push("clear"),
  };
  return { api, calls };
}

describe("the badge", () => {
  test("the title: (n) nod, plain nod at 0 and without a snapshot", () => {
    expect(titleFor(3)).toBe("(3) nod");
    expect(titleFor(0)).toBe("nod");
    expect(titleFor(null)).toBe("nod");
  });

  test("set for n, cleared at 0, unknown, or turned off", () => {
    const { api, calls } = recorder();
    applyBadge(api, 2, true);
    applyBadge(api, 0, true);
    applyBadge(api, null, true);
    applyBadge(api, 5, false);
    expect(calls).toEqual(["set 2", "clear", "clear", "clear"]);
  });

  test("a browser without it: nothing, and no throw; one that rejects or throws: no throw", () => {
    expect(canBadge({})).toBe(false);
    expect(canBadge(null)).toBe(false);
    expect(() => applyBadge({}, 3, true)).not.toThrow();
    expect(() =>
      applyBadge({ setAppBadge: () => Promise.reject(new Error("not installed")) }, 3, true),
    ).not.toThrow();
    expect(() =>
      applyBadge(
        {
          setAppBadge: () => {
            throw new Error("no");
          },
        },
        3,
        true,
      ),
    ).not.toThrow();
  });

  test("the switch: on by default, remembered per viewer", () => {
    const storage = memory();
    expect(readBadgeOn(storage)).toBe(true);
    expect(readBadgeOn(null)).toBe(true);
    writeBadgeOn(storage, false);
    expect(readBadgeOn(storage)).toBe(false);
    writeBadgeOn(storage, true);
    expect(readBadgeOn(storage)).toBe(true);
  });
});
