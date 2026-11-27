import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { tempDir } from "../kit/test-support.ts";
import {
  addConfigRepo,
  cacheDir,
  defaultConfigFile,
  readConfig,
  removeConfigRepo,
  updateConfig,
} from "./config";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function file() {
  const d = await tempDir();
  cleanups.push(d.cleanup);
  return join(d.dir, "nod", "config.json");
}

const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

test("where it lives: $XDG_CONFIG_HOME/nod/config.json, the clones under $XDG_CACHE_HOME/nod", () => {
  expect(defaultConfigFile({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/nod/config.json");
  expect(cacheDir({ XDG_CACHE_HOME: "/x/cache" }, "/home/someone")).toBe("/x/cache/nod");
  expect(cacheDir({}, "/home/someone")).toBe("/home/someone/.cache/nod");
  // A relative XDG path is not one (the spec says ignore it).
  expect(cacheDir({ XDG_CACHE_HOME: "cache" }, "/home/someone")).toBe("/home/someone/.cache/nod");
});

test("no file is an empty list; adding writes the documented shape", async () => {
  const f = await file();
  expect(readConfig(f)).toEqual({ repos: [], skipped: [], unreadable: null });
  expect(addConfigRepo(f, { host: "github.com", repo: "tallyho/fieldbook" })).toBe(true);
  expect(addConfigRepo(f, { host: "acme.ghe.com", repo: "finance/ledger" })).toBe(true);
  expect(await json(f)).toEqual({
    nod: "config",
    version: 1,
    repos: [
      { host: "github.com", repo: "tallyho/fieldbook" },
      { host: "acme.ghe.com", repo: "finance/ledger" },
    ],
  });
  // Once only, whatever the case.
  expect(addConfigRepo(f, { host: "github.com", repo: "TallyHo/Fieldbook" })).toBe(false);
  expect(readConfig(f).repos).toHaveLength(2);
  // No temp file left behind.
  expect(await readdir(join(f, ".."))).toEqual(["config.json"]);
});

test("tolerant: unknown keys survive every write, unreadable entries are skipped and kept", async () => {
  const f = await file();
  await addConfigRepo(f, { host: "github.com", repo: "tallyho/fieldbook" });
  const text = JSON.stringify({
    nod: "config",
    version: 1,
    channel: "next",
    repos: [
      { host: "github.com", repo: "tallyho/fieldbook", note: "mine" },
      { host: "not a host!", repo: "x/y" },
      { repo: "tallyho/no-host" },
      "garbage",
      { host: "github.com", repo: "tallyho/fieldbook" },
    ],
  });
  await writeFile(f, text);
  const read = readConfig(f);
  expect(read.repos).toEqual([
    { host: "github.com", repo: "tallyho/fieldbook" },
    { host: "github.com", repo: "tallyho/no-host" },
  ]);
  expect(read.skipped).toHaveLength(3);
  expect(read.skipped.join("\n")).toContain("listed twice: tallyho/fieldbook");

  expect(removeConfigRepo(f, "tallyho/fieldbook")).toBe(true);
  const after = (await json(f)) as { channel: string; repos: unknown[] };
  expect(after.channel).toBe("next");
  expect(after.repos).toEqual([
    { host: "not a host!", repo: "x/y" },
    { repo: "tallyho/no-host" },
    "garbage",
  ]);
  expect(removeConfigRepo(f, "tallyho/fieldbook")).toBe(false);
});

test("another writer's key, written between two of ours, is kept: every change reads the file first", async () => {
  const f = await file();
  addConfigRepo(f, { host: "github.com", repo: "tallyho/fieldbook" });
  // The update-channel store writes only its key, keeping the others.
  updateConfig(f, (j) => ({ ...j, channel: "latest" }));
  addConfigRepo(f, { host: "acme.ghe.com", repo: "finance/ledger" });
  expect(await json(f)).toMatchObject({ channel: "latest", repos: [{}, {}] });
});

test("never written over: a file that is not JSON, or of a newer version", async () => {
  const f = await file();
  await addConfigRepo(f, { host: "github.com", repo: "tallyho/fieldbook" });
  await writeFile(f, "{ not json");
  expect(readConfig(f)).toMatchObject({ repos: [], unreadable: expect.stringMatching(/not JSON/) });
  expect(() => addConfigRepo(f, { host: "github.com", repo: "a/b" })).toThrow(/not JSON/);
  expect(await readFile(f, "utf8")).toBe("{ not json");
  await writeFile(f, JSON.stringify({ nod: "config", version: 2, repos: [] }));
  expect(() => addConfigRepo(f, { host: "github.com", repo: "a/b" })).toThrow(/newer nod/);
});
