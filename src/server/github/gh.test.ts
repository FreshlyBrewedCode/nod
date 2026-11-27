/**
 * Finding `gh` and asking it for a token, with a stand-in `gh` (a shell
 * script in a temp folder): never the real one, never a real login.
 */

import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { makeFakeGh } from "./fake-gh";
import { findGh, ghToken, oneLine } from "./gh";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const fakeGh = async (hosts: ReadonlyArray<string> = []) => {
  const f = await makeFakeGh(hosts);
  cleanups.push(f.cleanup);
  return f;
};

const base = { PATH: "/usr/bin:/bin" };

test("findGh: NOD_GH when it is there, else the PATH, else none", async () => {
  const f = await fakeGh();
  expect(findGh({ PATH: `${f.bin}:/bin` })).toBe(f.gh);
  expect(findGh({ PATH: "/nowhere", NOD_GH: f.gh })).toBe(f.gh);
  // A pinned gh that is gone (uninstalled since): the PATH's.
  expect(findGh({ PATH: `${f.bin}`, NOD_GH: join(f.dir, "gone", "gh") })).toBe(f.gh);
  expect(findGh({ PATH: join(f.dir, "empty") })).toBeNull();
  expect(findGh({})).toBeNull();
});

test("ghToken: the token; gh's own words without a login; no-gh without gh", async () => {
  const f = await fakeGh(["github.com"]);
  const env = { ...base, NOD_GH: f.gh, GH_CONFIG_DIR: f.config };
  expect(ghToken("github.com", env)).toEqual({ token: "gho_fakeTokenForTests", path: f.gh });
  expect(ghToken("acme.ghe.com", env)).toEqual({
    state: "signed-out",
    path: f.gh,
    detail: "no oauth token found for acme.ghe.com",
  });
  expect(ghToken("github.com", { PATH: join(f.dir, "empty") })).toEqual({
    state: "no-gh",
    path: null,
    detail: null,
  });
});

test("GH_TOKEN logs gh in where its config has no login: what a service does not get", async () => {
  const f = await fakeGh();
  const env = { ...base, NOD_GH: f.gh, GH_CONFIG_DIR: f.config };
  expect(ghToken("github.com", { ...env, GH_TOKEN: "from-the-shell" })).toMatchObject({
    token: "from-the-shell",
  });
  expect(ghToken("github.com", env)).toMatchObject({ state: "signed-out" });
});

test("oneLine: the first line, no token, not too long", () => {
  expect(oneLine("\n  failed to read gho_abc123 from the keyring\nmore")).toBe(
    "failed to read [token] from the keyring",
  );
  expect(oneLine("x".repeat(300))!.length).toBe(200);
  expect(oneLine(" \n ")).toBeNull();
});
