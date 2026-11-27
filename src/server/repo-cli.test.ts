import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { githubHost } from "../kit/host.ts";
import { tempDir, tempRepo } from "../kit/test-support.ts";
import { ownClonePath } from "./github/clone";
import { FakeGitHub } from "./github/fake-github";
import { runRepo, type RepoFlags } from "./repo-cli";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function cli(tokens: Record<string, string | null> = {}) {
  const tmp = await tempDir();
  cleanups.push(tmp.cleanup);
  const remote = await tempRepo();
  cleanups.push(remote.cleanup);
  await remote.git("config", "uploadpack.allowFilter", "true");
  await remote.write("a.ts", "1\n");
  await remote.commit("a");
  const com = new FakeGitHub();
  com.repo("tallyho/fieldbook");
  const ghe = new FakeGitHub(githubHost("acme.ghe.com"), "alice_acme");
  ghe.token = "t0ken-ghe";
  ghe.repo("finance/ledger");
  const fakes: Record<string, FakeGitHub> = { "github.com": com, "acme.ghe.com": ghe };
  const all: Record<string, string | null> = {
    "github.com": "t0ken",
    "acme.ghe.com": "t0ken-ghe",
    ...tokens,
  };
  const out: string[] = [];
  const err: string[] = [];
  const configFile = join(tmp.dir, "config", "nod", "config.json");
  const cacheDir = join(tmp.dir, "cache", "nod");
  const run = (command: RepoFlags["command"], repo: string | null = null, noClone = false) =>
    runRepo(
      { command, repo, noClone },
      {
        configFile,
        cacheDir,
        token: (h) => all[h] ?? null,
        fetch: (h) => fakes[h.name]!.fetch,
        cloneUrl: () => `file://${remote.dir}`,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      },
    );
  return { run, out, err, configFile, cacheDir, com, ghe };
}

test("add checks the repo on its host, writes it and clones it; list shows the clones; remove keeps them", async () => {
  const t = await cli();
  expect(await t.run("list")).toBe(0);
  expect(t.out.pop()).toContain("no repositories in");
  expect(await t.run("add", "https://github.com/TallyHo/Fieldbook")).toBe(0);
  expect(await t.run("add", "acme.ghe.com/finance/ledger", true)).toBe(0);
  expect(JSON.parse(readFileSync(t.configFile, "utf8")).repos).toEqual([
    { host: "github.com", repo: "tallyho/fieldbook" },
    { host: "acme.ghe.com", repo: "finance/ledger" },
  ]);
  const clone = ownClonePath(t.cacheDir, "github.com", "tallyho/fieldbook");
  expect(existsSync(join(clone, "HEAD"))).toBe(true);
  expect(existsSync(ownClonePath(t.cacheDir, "acme.ghe.com", "finance/ledger"))).toBe(false);
  expect(t.out.splice(0)).toEqual([
    `added tallyho/fieldbook to ${t.configFile}`,
    `cloning it (blobless) into ${clone}…`,
    `added acme.ghe.com/finance/ledger to ${t.configFile}`,
  ]);
  expect(await t.run("add", "tallyho/fieldbook")).toBe(0);
  expect(t.out.pop()).toBe("tallyho/fieldbook is in the list already");

  await t.run("list");
  expect(t.out.splice(0)).toEqual([
    `tallyho/fieldbook            ${clone}`,
    "acme.ghe.com/finance/ledger  not cloned yet",
  ]);

  expect(await t.run("remove", "tallyho/fieldbook")).toBe(0);
  expect(t.out.splice(0)).toEqual([
    "removed tallyho/fieldbook",
    `  its clone stays in the cache: ${clone} (delete it by hand if you like)`,
  ]);
  expect(existsSync(clone)).toBe(true);
  expect(await t.run("remove", "tallyho/fieldbook")).toBe(1);
  expect(t.err.pop()).toContain("is not in");
  expect(t.com.misdirected).toEqual([]);
  expect(t.ghe.misdirected).toEqual([]);
});

test("add refuses what GitHub does not know, a host without a login, and what is no repo", async () => {
  const t = await cli({ "acme.ghe.com": null });
  expect(await t.run("add", "tallyho/nothing")).toBe(1);
  expect(t.err.pop()).toBe(
    "nod repo: tallyho/nothing was not found on github.com, or this gh account cannot read it.",
  );
  expect(await t.run("add", "acme.ghe.com/finance/ledger")).toBe(1);
  expect(t.err.pop()).toContain("gh auth login --hostname acme.ghe.com");
  expect(await t.run("add", "fieldbook")).toBe(2);
  expect(existsSync(t.configFile)).toBe(false);
});
