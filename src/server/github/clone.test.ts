import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { git, patchId } from "../../kit/patch-id.ts";
import { tempDir, tempRepo } from "../../kit/test-support.ts";
import { CloneError, clonePatchIds, githubRepoOf, resolveClone } from "./clone";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

test("GitHub remote URLs in every spelling", () => {
  for (const url of [
    "https://github.com/acme/widgets.git",
    "https://github.com/acme/widgets",
    "https://someone@github.com/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git",
    "git://github.com/acme/widgets",
  ])
    expect(githubRepoOf(url)).toBe("acme/widgets");
  expect(githubRepoOf("https://gitlab.com/acme/widgets.git")).toBeNull();
  expect(githubRepoOf("/srv/git/widgets.git")).toBeNull();
});

test("the clone and its repo: origin by default, or the named repo among the remotes", async () => {
  const r = await tempRepo();
  cleanups.push(r.cleanup);
  await r.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  await r.git("remote", "add", "upstream", "https://github.com/acme-org/widgets.git");
  await r.write("a.txt", "a\n");
  await r.commit("a");
  await r.git("switch", "-q", "-c", "sub");
  expect(resolveClone(r.dir, null)).toMatchObject({ repo: "acme/widgets" });
  expect(resolveClone(join(r.dir), "ACME-ORG/widgets")).toMatchObject({ repo: "acme-org/widgets" });
  expect(() => resolveClone(r.dir, "acme/other")).toThrow(/is not a clone of acme\/other/);
});

test("clear errors for a folder that is not a clone", async () => {
  const d = await tempDir();
  cleanups.push(d.cleanup);
  expect(() => resolveClone(d.dir, null)).toThrow(CloneError);
  expect(() => resolveClone(d.dir, null)).toThrow(/is not a git clone/);
  const r = await tempRepo();
  cleanups.push(r.cleanup);
  expect(() => resolveClone(r.dir, null)).toThrow(/no remote named origin/);
  await r.git("remote", "add", "origin", "https://gitlab.com/acme/widgets.git");
  expect(() => resolveClone(r.dir, null)).toThrow(/not a GitHub repository/);
});

test("patch-ids from the clone: fetched into refs/nod/*, the working tree and branches untouched", async () => {
  // The "GitHub" side: main and a PR branch, then main moves on.
  const remote = await tempRepo();
  cleanups.push(remote.cleanup);
  await remote.write("app.ts", "export const a = 1;\n");
  await remote.commit("base");
  await remote.git("switch", "-q", "-c", "agent/change");
  await remote.write("app.ts", "export const a = 2;\n");
  await remote.write("new.ts", "export const b = 1;\n");
  const head = await remote.commit("change");
  await remote.git("switch", "-q", "main");
  await remote.write("other.ts", "x\n");
  await remote.commit("main moves on");

  // The user's clone: an older main, a branch of their own, a dirty file.
  const user = await tempRepo();
  cleanups.push(user.cleanup);
  await user.write("mine.txt", "work in progress\n");
  await user.commit("mine");
  await user.write("mine.txt", "uncommitted\n");
  const before = {
    head: (await user.git("rev-parse", "HEAD")).trim(),
    branches: await user.git("branch", "--list"),
    status: await user.git("status", "--porcelain"),
  };

  const ids = clonePatchIds({ dir: user.dir, repo: "acme/widgets" }, () => null, remote.dir);
  const [one, two] = await Promise.all([
    ids.compute({ base: "main", headSha: head }),
    ids.compute({ base: "main", headSha: head }),
  ]);
  const expected = await patchId({ repoDir: remote.dir, baseTip: "main", head });
  expect(one).toBe(expected);
  expect(two).toBe(expected);
  expect(one).toMatch(/^[0-9a-f]{40}$/);

  expect((await user.git("rev-parse", "HEAD")).trim()).toBe(before.head);
  expect(await user.git("branch", "--list")).toBe(before.branches);
  expect(await user.git("status", "--porcelain")).toBe(before.status);
  expect(await readFile(join(user.dir, "mine.txt"), "utf8")).toBe("uncommitted\n");
  expect((await git(user.dir, ["for-each-ref", "--format=%(refname)", "refs/nod/"])).trim()).toBe(
    "refs/nod/base",
  );
});

test("a failed fetch rejects that one job, the queue goes on", async () => {
  const remote = await tempRepo();
  cleanups.push(remote.cleanup);
  await remote.write("a", "1\n");
  const base = await remote.commit("a");
  const user = await tempRepo();
  cleanups.push(user.cleanup);
  const ids = clonePatchIds({ dir: user.dir, repo: "acme/widgets" }, () => null, remote.dir);
  await expect(ids.compute({ base: "nope", headSha: base })).rejects.toThrow(/fetch failed/);
  expect(await ids.compute({ base: "main", headSha: base })).toBe("");
});
