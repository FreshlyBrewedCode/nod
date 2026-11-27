import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { fetchPullRequestObjects, git, patchId } from "../../kit/patch-id.ts";
import { tempDir, tempRepo } from "../../kit/test-support.ts";
import { githubHost } from "../../kit/host.ts";
import {
  CloneError,
  OwnClone,
  clonePatchIds,
  cloneUrl,
  ownClonePatchIds,
  ownClonePath,
  resolveClone,
  type Clone,
} from "./clone";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const GITHUB_COM = githubHost("github.com");

/** A clone of `remote` (a local path) as `resolveClone` would describe it. */
const cloneOf = (dir: string, remote: string): Clone => ({
  dir,
  repo: "acme/widgets",
  host: GITHUB_COM,
  remoteUrl: remote,
});

test("the clone and its repo: origin by default, or the named repo among the remotes", async () => {
  const r = await tempRepo();
  cleanups.push(r.cleanup);
  await r.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  await r.git("remote", "add", "upstream", "https://github.com/acme-org/widgets.git");
  await r.write("a.txt", "a\n");
  await r.commit("a");
  await r.git("switch", "-q", "-c", "sub");
  expect(resolveClone(r.dir, null)).toMatchObject({
    repo: "acme/widgets",
    host: GITHUB_COM,
    remoteUrl: "git@github.com:acme/widgets.git",
  });
  expect(resolveClone(join(r.dir), "ACME-ORG/widgets")).toMatchObject({
    repo: "acme-org/widgets",
    remoteUrl: "https://github.com/acme-org/widgets.git",
  });
  expect(() => resolveClone(r.dir, "acme/other")).toThrow(/is not a clone of acme\/other/);
});

test("the host comes from the origin, once: GHE.com and GitHub Enterprise Server", async () => {
  const r = await tempRepo();
  cleanups.push(r.cleanup);
  const at = async (url: string) => {
    await r.git("remote", "remove", "origin").catch(() => "");
    await r.git("remote", "add", "origin", url);
    return resolveClone(r.dir, null);
  };
  expect(await at("https://acme.ghe.com/acme/widgets.git")).toMatchObject({
    repo: "acme/widgets",
    host: { name: "acme.ghe.com", apiUrl: "https://api.acme.ghe.com" },
  });
  expect((await at("acme@acme.ghe.com:mona_acme/widgets.git")).repo).toBe("mona_acme/widgets");
  expect((await at("ssh://git@git.example.test:2222/acme/widgets")).host).toMatchObject({
    name: "git.example.test",
    apiUrl: "https://git.example.test/api/v3",
    graphqlUrl: "https://git.example.test/api/graphql",
  });
  expect((await at("https://git.example.test:8443/acme/widgets")).host.webUrl).toBe(
    "https://git.example.test:8443",
  );
});

test("an ssh alias cannot be resolved: a sentence that names --host, and --host overrides", async () => {
  const r = await tempRepo();
  cleanups.push(r.cleanup);
  await r.git("remote", "add", "origin", "git@work:acme/widgets.git");
  expect(() => resolveClone(r.dir, null)).toThrow(/ssh host "work".*alias.*--host/);
  expect(resolveClone(r.dir, null, "acme.ghe.com")).toMatchObject({
    repo: "acme/widgets",
    host: { name: "acme.ghe.com" },
    remoteUrl: "git@work:acme/widgets.git",
  });
  expect(() => resolveClone(r.dir, null, "api.github.com")).toThrow(/--host/);
});

test("clear errors for a folder that is not a clone", async () => {
  const d = await tempDir();
  cleanups.push(d.cleanup);
  expect(() => resolveClone(d.dir, null)).toThrow(CloneError);
  expect(() => resolveClone(d.dir, null)).toThrow(/is not a git clone/);
  const r = await tempRepo();
  cleanups.push(r.cleanup);
  expect(() => resolveClone(r.dir, null)).toThrow(/no remote named origin/);
  await r.git("remote", "add", "origin", "/srv/git/widgets.git");
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

  const ids = clonePatchIds(cloneOf(user.dir, remote.dir), () => null);
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
  const ids = clonePatchIds(cloneOf(user.dir, remote.dir), () => null);
  await expect(ids.compute({ base: "nope", headSha: base })).rejects.toThrow(/fetch failed/);
  expect(await ids.compute({ base: "main", headSha: base })).toBe("");
});

test("git sends the token only to the host's web URL", async () => {
  // A stand-in for a git server: records what each request carried, answers 404.
  const seen: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(req.headers.get("authorization"));
      return new Response("not here", { status: 404 });
    },
  });
  cleanups.push(async () => void server.stop(true));
  const user = await tempRepo();
  cleanups.push(user.cleanup);
  const head = "a".repeat(40);
  const remoteUrl = `http://127.0.0.1:${server.port}/acme/widgets.git`;

  // The clone's host is acme.ghe.com; the remote is somewhere else: no token goes there.
  const elsewhere: Clone = {
    dir: user.dir,
    repo: "acme/widgets",
    host: githubHost("acme.ghe.com"),
    remoteUrl,
  };
  await expect(
    clonePatchIds(elsewhere, () => "secret-token").compute({ base: "main", headSha: head }),
  ).rejects.toThrow();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((a) => a === null)).toBe(true);

  // The control: scoped to that server, git does send it.
  seen.length = 0;
  await expect(
    fetchPullRequestObjects({
      repoDir: user.dir,
      base: "main",
      headSha: head,
      remote: remoteUrl,
      token: "secret-token",
      serverUrl: `http://127.0.0.1:${server.port}/`,
    }),
  ).rejects.toThrow();
  expect(seen.some((a) => a?.startsWith("basic "))).toBe(true);
});

test("nod's own clone: where it lives, and the URL it clones from", () => {
  expect(ownClonePath("/c/nod", "acme.ghe.com", "Finance/Ledger")).toBe(
    "/c/nod/clones/acme.ghe.com/finance/ledger.git",
  );
  expect(ownClonePath("/c/nod", "git.example.test:8443", "acme/widgets")).toBe(
    "/c/nod/clones/git.example.test:8443/acme/widgets.git",
  );
  expect(cloneUrl(githubHost("acme.ghe.com"), "finance/ledger")).toBe(
    "https://acme.ghe.com/finance/ledger.git",
  );
  expect(cloneUrl(GITHUB_COM, "acme/widgets")).toBe("https://github.com/acme/widgets.git");
});

test("nod's own clone: blobless and bare, made on the first patch-id, which matches a full clone's", async () => {
  const remote = await tempRepo();
  cleanups.push(remote.cleanup);
  // A server that hands out filtered packs, as GitHub does.
  await remote.git("config", "uploadpack.allowFilter", "true");
  await remote.git("config", "uploadpack.allowAnySHA1InWant", "true");
  await remote.write("app.ts", "export const a = 1;\n");
  await remote.write("big.bin", "x".repeat(4096));
  await remote.commit("base");
  await remote.git("switch", "-q", "-c", "agent/change");
  await remote.write("app.ts", "export const a = 2;\n");
  const head = await remote.commit("change");
  await remote.git("switch", "-q", "main");

  const cache = await tempDir();
  cleanups.push(cache.cleanup);
  const dir = ownClonePath(cache.dir, "github.com", "acme/widgets");
  const clone = new OwnClone({
    dir,
    host: GITHUB_COM,
    name: "acme/widgets",
    token: () => null,
    url: `file://${remote.dir}`,
  });
  expect(clone.exists()).toBe(false);
  const ids = ownClonePatchIds(clone, GITHUB_COM);
  const [one, two] = await Promise.all([
    ids.compute({ base: "main", headSha: head }),
    ids.compute({ base: "main", headSha: head }),
  ]);
  expect(one).toBe(await patchId({ repoDir: remote.dir, baseTip: "main", head }));
  expect(two).toBe(one);
  expect(clone.exists()).toBe(true);
  // Bare, a partial clone of origin, remote-tracking branches as a normal clone has them.
  expect((await git(dir, ["rev-parse", "--is-bare-repository"])).trim()).toBe("true");
  expect((await git(dir, ["config", "remote.origin.promisor"])).trim()).toBe("true");
  expect((await git(dir, ["config", "remote.origin.partialclonefilter"])).trim()).toBe("blob:none");
  expect((await git(dir, ["config", "remote.origin.fetch"])).trim()).toBe(
    "+refs/heads/*:refs/remotes/origin/*",
  );
  // The token is never written into its config.
  expect(await git(dir, ["config", "--list"])).not.toContain("extraheader");
  // Nothing half-made is left next to it.
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(join(cache.dir, "clones", "github.com", "acme"))).toEqual(["widgets.git"]);
});

test("a clone that fails leaves nothing that looks like a clone; the next try clones again", async () => {
  const cache = await tempDir();
  cleanups.push(cache.cleanup);
  const dir = ownClonePath(cache.dir, "github.com", "acme/widgets");
  let url = `file://${cache.dir}/nowhere`;
  const clone = new OwnClone({
    dir,
    host: GITHUB_COM,
    name: "acme/widgets",
    token: () => null,
    url,
  });
  await expect(clone.ensure()).rejects.toThrow(/cloning acme\/widgets from github.com failed/);
  expect(clone.exists()).toBe(false);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(join(cache.dir, "clones", "github.com", "acme"))).toEqual([]);
  const remote = await tempRepo();
  cleanups.push(remote.cleanup);
  await remote.write("a", "1\n");
  await remote.commit("a");
  url = `file://${remote.dir}`;
  const again = new OwnClone({
    dir,
    host: GITHUB_COM,
    name: "acme/widgets",
    token: () => null,
    url,
  });
  await again.ensure();
  expect(again.exists()).toBe(true);
});
