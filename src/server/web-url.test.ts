import { expect, test } from "bun:test";

import {
  DEV_WEB_URL,
  NEXT_WEB_URL,
  STABLE_WEB_URL,
  allowedOrigins,
  defaultWebUrl,
  hostLink,
  serverUrl,
} from "./web-url";

test("a checkout opens the dev server", () => {
  expect(DEV_WEB_URL).toBe("http://localhost:4517");
  expect(defaultWebUrl(undefined)).toBe(DEV_WEB_URL);
  expect(defaultWebUrl(null)).toBe(DEV_WEB_URL);
  expect(defaultWebUrl("0.0.0-development")).toBe(DEV_WEB_URL);
});

test("a stable release opens the stable UI", () => {
  expect(defaultWebUrl("1.2.3")).toBe(STABLE_WEB_URL);
});

test("a pre-release opens the next UI", () => {
  expect(defaultWebUrl("1.3.0-next.4")).toBe(NEXT_WEB_URL);
  expect(NEXT_WEB_URL).toBe("https://ui.nod.frebreco.de/next");
});

test("allowed origins: the web app's, and the dev server under both names", () => {
  expect(allowedOrigins(NEXT_WEB_URL)).toEqual([
    "https://ui.nod.frebreco.de",
    "http://localhost:4517",
    "http://127.0.0.1:4517",
  ]);
  expect(allowedOrigins(DEV_WEB_URL)).toEqual(["http://localhost:4517", "http://127.0.0.1:4517"]);
});

test("the host link carries the server and the token in the fragment", () => {
  const link = hostLink(`${NEXT_WEB_URL}/`, serverUrl(4518), "tok_en-1");
  expect(link).toBe(
    "https://ui.nod.frebreco.de/next/#host=ws%3A%2F%2F127.0.0.1%3A4518&token=tok_en-1",
  );
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  expect([fragment.get("host"), fragment.get("token")]).toEqual([
    "ws://127.0.0.1:4518",
    "tok_en-1",
  ]);
});
