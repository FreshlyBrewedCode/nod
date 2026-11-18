import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HOST,
  PAIRING_KEY,
  PENDING_LINK_KEY,
  PENDING_LINK_MS,
  isLoopbackHost,
  loadPairing,
  readHostLink,
  rememberLink,
  socketUrl,
  takeLink,
  takePairing,
  type KeyValue,
} from "./connection";

const memory = (init: Record<string, string> = {}): KeyValue & { data: Record<string, string> } => {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
};

test("the host link's fragment, and what is left of it", () => {
  expect(readHostLink("#host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc&pr=482")).toEqual({
    pairing: { host: "ws://127.0.0.1:4518", token: "abc" },
    rest: "pr=482",
  });
  expect(readHostLink("#token=abc")).toEqual({
    pairing: { host: DEFAULT_HOST, token: "abc" },
    rest: "",
  });
  expect(readHostLink("#pr=482")).toEqual({ pairing: null, rest: "pr=482" });
  expect(readHostLink("")).toEqual({ pairing: null, rest: "" });
});

test("a link may only point at this machine", () => {
  expect(isLoopbackHost("ws://127.0.0.1:4518")).toBe(true);
  expect(isLoopbackHost("ws://localhost:4600")).toBe(true);
  expect(isLoopbackHost("ws://[::1]:4518")).toBe(true);
  expect(isLoopbackHost("ws://192.168.1.5:4518")).toBe(false);
  expect(isLoopbackHost("wss://evil.example")).toBe(false);
  expect(isLoopbackHost("http://127.0.0.1:4518")).toBe(false);
  expect(readHostLink("#host=ws%3A%2F%2Fevil.example&token=abc").pairing).toBeNull();
});

test("a fresh link is stored and taken out of the address bar; later visits use the stored one", () => {
  const storage = memory();
  const replaced: string[] = [];
  const history = {
    replaceState: (_: unknown, __: string, url?: string | URL | null) =>
      void replaced.push(String(url)),
  };
  const pairing = takePairing(
    { hash: "#host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc&pr=482", pathname: "/next/", search: "" },
    history,
    storage,
  );
  expect(pairing).toEqual({ host: "ws://127.0.0.1:4518", token: "abc" });
  expect(replaced).toEqual(["/next/#pr=482"]);
  expect(JSON.parse(storage.data[PAIRING_KEY]!)).toEqual(pairing);

  // a deep link without a token
  expect(takePairing({ hash: "#pr=485", pathname: "/", search: "" }, history, storage)).toEqual(
    pairing,
  );
  expect(replaced).toHaveLength(1);
});

test("a broken or foreign stored pairing is no pairing", () => {
  expect(loadPairing(memory({ [PAIRING_KEY]: "{" }))).toBeNull();
  expect(
    loadPairing(
      memory({ [PAIRING_KEY]: JSON.stringify({ host: "ws://evil.example", token: "t" }) }),
    ),
  ).toBeNull();
  expect(loadPairing(memory())).toBeNull();
});

test("the socket URL carries the token in the query", () => {
  expect(socketUrl({ host: "ws://127.0.0.1:4518", token: "a+b/c" })).toBe(
    "ws://127.0.0.1:4518/ws?token=a%2Bb%2Fc",
  );
});

test("a host link combined with a route keeps the route", () => {
  expect(readHostLink("#/pr/a/b/7?host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc")).toEqual({
    pairing: { host: "ws://127.0.0.1:4518", token: "abc" },
    rest: "/pr/a/b/7",
  });
  expect(readHostLink("#/batch/a/b/7,8&token=abc&x=1")).toEqual({
    pairing: { host: DEFAULT_HOST, token: "abc" },
    rest: "/batch/a/b/7,8?x=1",
  });
});

describe("a deep link opened before pairing", () => {
  const NOW = 1_800_000_000_000;
  const history = (replaced: string[]) => ({
    replaceState: (_: unknown, __: string, url?: string | URL | null) =>
      void replaced.push(String(url)),
  });
  const hostLink = "#host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc";

  test("is remembered and taken once, while recent", () => {
    const storage = memory();
    rememberLink(storage, "#/pr/a/b/7", NOW);
    expect(takeLink(storage, NOW + 60_000)).toBe("#/pr/a/b/7");
    expect(takeLink(storage, NOW + 60_000)).toBeNull();
    rememberLink(storage, "#/pr/a/b/7", NOW);
    expect(takeLink(storage, NOW + PENDING_LINK_MS + 1)).toBeNull();
    // only routes, never a pairing fragment
    rememberLink(storage, "#token=abc", NOW);
    expect(storage.data[PENDING_LINK_KEY]).toBeUndefined();
    expect(takeLink(memory({ [PENDING_LINK_KEY]: "{" }), NOW)).toBeNull();
  });

  test("the host link `nod serve` prints lands on it", () => {
    const storage = memory();
    rememberLink(storage, "#/batch/a/b/7,8", NOW);
    const replaced: string[] = [];
    const pairing = takePairing(
      { hash: hostLink, pathname: "/", search: "" },
      history(replaced),
      storage,
      NOW + 5 * 60_000,
    );
    expect(pairing).toEqual({ host: "ws://127.0.0.1:4518", token: "abc" });
    expect(replaced).toEqual(["/#/batch/a/b/7,8"]);
    expect(storage.data[PENDING_LINK_KEY]).toBeUndefined();
  });

  test("a host link with a route of its own wins, and the remembered one is dropped", () => {
    const storage = memory();
    rememberLink(storage, "#/pr/a/b/7", NOW);
    const replaced: string[] = [];
    takePairing(
      { hash: `#/pr/a/b/9?${hostLink.slice(1)}`, pathname: "/next/", search: "" },
      history(replaced),
      storage,
      NOW,
    );
    expect(replaced).toEqual(["/next/#/pr/a/b/9"]);
    expect(storage.data[PENDING_LINK_KEY]).toBeUndefined();
  });

  test("without a remembered link the host link still works as is", () => {
    const replaced: string[] = [];
    takePairing({ hash: hostLink, pathname: "/", search: "" }, history(replaced), memory(), NOW);
    expect(replaced).toEqual(["/"]);
  });

  test("a stale remembered link is not followed", () => {
    const storage = memory();
    rememberLink(storage, "#/pr/a/b/7", NOW);
    const replaced: string[] = [];
    takePairing(
      { hash: hostLink, pathname: "/", search: "" },
      history(replaced),
      storage,
      NOW + PENDING_LINK_MS + 1,
    );
    expect(replaced).toEqual(["/"]);
  });
});
