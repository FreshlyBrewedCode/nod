import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  changedFiles,
  EMPTY_TREE,
  git,
  gitFileReader,
  parseRawNumstat,
  patchId,
} from "./patch-id.ts";
import { tempRepo } from "./test-support.ts";

type Repo = Awaited<ReturnType<typeof tempRepo>>;
const repos: Repo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.cleanup();
});

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

/** main with a 40-line file, and a branch `pr` that changes lines 20 and 30. */
async function setup(): Promise<Repo & { base: string; head: string }> {
  const repo = await tempRepo();
  repos.push(repo);
  await repo.write("app/f.txt", lines(40));
  await repo.write("README.md", "hello\n");
  const base = await repo.commit("base");
  await repo.git("checkout", "-q", "-b", "pr");
  await repo.write("app/f.txt", lines(40, { 20: "line 20 changed", 30: "  line 30 indented" }));
  const head = await repo.commit("pr change");
  await repo.git("checkout", "-q", "main");
  return { ...repo, base, head };
}

describe("patchId", () => {
  test("matches the ADR 0001 command in a clean config", async () => {
    const r = await setup();
    const id = await patchId({ repoDir: r.dir, baseTip: "main", head: r.head });
    const flags = [
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--full-index",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "-U3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ];
    const diff = await r.git(`--attr-source=${EMPTY_TREE}`, "diff", ...flags, r.base, r.head);
    const expected = (await git(r.dir, ["patch-id", "--stable"], { input: diff })).split(" ")[0];
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(id).toBe(expected!);
  });

  test("stable through a clean rebase, changes with content", async () => {
    const r = await setup();
    const before = await patchId({ repoDir: r.dir, baseTip: "main", head: r.head });

    // main moves on far away from the change
    await r.write("app/f.txt", lines(40, { 2: "line 2 on main" }));
    await r.write("other.txt", "new on main\n");
    await r.commit("main moves");
    await r.git("checkout", "-q", "pr");
    await r.git("rebase", "-q", "main");
    const rebased = (await r.git("rev-parse", "HEAD")).trim();
    expect(rebased).not.toBe(r.head);
    expect(await patchId({ repoDir: r.dir, baseTip: "main", head: rebased })).toBe(before);

    // a merge of main into the branch ("Update branch") keeps it too
    await r.git("checkout", "-q", "-b", "pr-merge", r.head);
    await r.git("merge", "-q", "--no-edit", "main");
    const merged = (await r.git("rev-parse", "HEAD")).trim();
    expect(await patchId({ repoDir: r.dir, baseTip: "main", head: merged })).toBe(before);

    // another content change does not
    await r.git("checkout", "-q", "pr");
    await r.write(
      "app/f.txt",
      lines(40, { 2: "line 2 on main", 20: "line 20 changed", 30: "  line 30 indented", 35: "x" }),
    );
    const changed = await r.commit("more");
    expect(await patchId({ repoDir: r.dir, baseTip: "main", head: changed })).not.toBe(before);
  });

  test("a base edit within three lines of the change costs a new nod (-U3)", async () => {
    const r = await setup();
    const before = await patchId({ repoDir: r.dir, baseTip: "main", head: r.head });
    await r.write("app/f.txt", lines(40, { 18: "line 18 on main" }));
    await r.commit("main edits nearby");
    await r.git("checkout", "-q", "pr");
    await r.git("rebase", "-q", "main");
    const rebased = (await r.git("rev-parse", "HEAD")).trim();
    expect(await patchId({ repoDir: r.dir, baseTip: "main", head: rebased })).not.toBe(before);
  });

  test("a hostile .gitattributes in the PR does not change the diff", async () => {
    const r = await setup();
    await r.git("checkout", "-q", "-b", "pr-attr", r.head);
    await r.write(".gitattributes", "* -diff\n");
    const head = await r.commit("hide the diff");
    await r.git("checkout", "-q", "main");
    const fromBase = await patchId({ repoDir: r.dir, baseTip: "main", head });

    // with the PR checked out, a plain diff would treat everything as binary
    await r.git("checkout", "-q", "pr-attr");
    const plain = await r.git("diff", r.base, head);
    expect(plain).toContain("Binary files");
    expect(await patchId({ repoDir: r.dir, baseTip: "main", head })).toBe(fromBase);
    const files = await changedFiles({ repoDir: r.dir, baseTip: "main", head });
    expect(files.find((f) => f.path === "app/f.txt")).toMatchObject({
      binary: false,
      added: 2,
      removed: 2,
    });
  });

  test("local git config and GIT_* variables do not change the diff", async () => {
    const r = await setup();
    const clean = await patchId({ repoDir: r.dir, baseTip: "main", head: r.head });
    await writeFile(join(r.dir, "hostile-attrs"), "* -diff\n");
    const config: [string, string][] = [
      ["diff.algorithm", "patience"],
      ["diff.context", "10"],
      ["diff.interHunkContext", "20"],
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.renames", "copies"],
      ["diff.external", "/bin/false"],
      ["diff.ignoreSubmodules", "all"],
      ["diff.indentHeuristic", "false"],
      ["color.diff", "always"],
      ["color.ui", "always"],
      ["patchid.verbatim", "true"],
      ["core.attributesFile", join(r.dir, "hostile-attrs")],
    ];
    for (const [k, v] of config) await r.git("config", k, v);
    const saved = { ...process.env };
    process.env.GIT_DIFF_OPTS = "--unified=10";
    process.env.GIT_EXTERNAL_DIFF = "/bin/false";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "diff.algorithm";
    process.env.GIT_CONFIG_VALUE_0 = "histogram";
    process.env.GIT_CONFIG_PARAMETERS = "'diff.context'='0'";
    try {
      expect(await patchId({ repoDir: r.dir, baseTip: "main", head: r.head })).toBe(clean);
      const files = await changedFiles({ repoDir: r.dir, baseTip: "main", head: r.head });
      expect(files).toEqual([
        { path: "app/f.txt", status: "modified", added: 2, removed: 2, binary: false },
      ]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test("refuses a non-empty info/attributes", async () => {
    const r = await setup();
    await writeFile(join(r.dir, ".git", "info", "attributes"), "* -diff\n");
    await expect(patchId({ repoDir: r.dir, baseTip: "main", head: r.head })).rejects.toThrow(
      "info/attributes",
    );
  });

  test("empty diff gives an empty patch-id", async () => {
    const r = await setup();
    expect(await patchId({ repoDir: r.dir, baseTip: "main", head: r.base })).toBe("");
  });
});

describe("changedFiles", () => {
  test("renames, binaries, deletions, odd names", async () => {
    const repo = await tempRepo();
    repos.push(repo);
    await repo.write("old/name.txt", "a\nb\nc\n");
    await repo.write("gone.txt", "x\n");
    await repo.write("img.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    await repo.commit("base");
    await repo.git("checkout", "-q", "-b", "pr");
    await repo.write("new/name.txt", "a\nb\nc\n"); // a rename: same content, new path
    await repo.git("rm", "-q", "old/name.txt");
    await repo.git("rm", "-q", "gone.txt");
    await repo.write("img.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    await repo.write("dir with space/é\ttab.md", "one\ntwo\n");
    const head = await repo.commit("pr");
    const files = await changedFiles({ repoDir: repo.dir, baseTip: "main", head });
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "dir with space/é\ttab.md", status: "added", added: 2, removed: 0, binary: false },
      { path: "gone.txt", status: "deleted", added: 0, removed: 1, binary: false },
      { path: "img.png", status: "modified", added: 0, removed: 0, binary: true },
      { path: "new/name.txt", status: "added", added: 3, removed: 0, binary: false },
      { path: "old/name.txt", status: "deleted", added: 0, removed: 3, binary: false },
    ]);
  });

  test("parseRawNumstat on empty output", () => {
    expect(parseRawNumstat("")).toEqual([]);
  });
});

describe("gitFileReader", () => {
  test("reads files at a revision, null otherwise", async () => {
    const r = await setup();
    const read = gitFileReader(r.dir, "main");
    expect(await read("README.md")).toBe("hello\n");
    expect(await read("/README.md")).toBe("hello\n");
    expect(await read("nope.txt")).toBeNull();
    expect(await read("../etc/passwd")).toBeNull();
    expect(await gitFileReader(r.dir, "main", 3)("README.md")).toBeNull();
    // the PR's version is not what the reader sees
    expect(await gitFileReader(r.dir, r.head)("app/f.txt")).toContain("line 20 changed");
    expect(await read("app/f.txt")).not.toContain("line 20 changed");
  });
});
