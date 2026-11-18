import { expect, test } from "bun:test";

import {
  DEFAULT_HOST,
  PAIRING_KEY,
  isLoopbackHost,
  loadPairing,
  readHostLink,
  socketUrl,
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
