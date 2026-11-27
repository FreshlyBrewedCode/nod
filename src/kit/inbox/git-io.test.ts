import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { git } from "../patch-id.ts";
import { tempDir, tempRepo } from "../test-support.ts";
import { GIT_READ_ONLY, assertReadOnlyGit, fakeInboxIO, filterDiff } from "./context.ts";
import { gitInboxIO } from "./git-io.ts";

describe("assertReadOnlyGit", () => {
  test("allows the read-only subcommands", () => {
    for (const sub of GIT_READ_ONLY) expect(() => assertReadOnlyGit([sub])).not.toThrow();
    expect(() =>
      assertReadOnlyGit(["log", "--text", "--filter=blob:none", "-p", "--", "--output"]),
    ).not.toThrow();
  });

  test("refuses anything else", () => {
    for (const args of [
      [],
      ["commit"],
      ["push"],
      ["fetch"],
      ["config", "x"],
      ["-c", "a=b", "log"],
      ["--git-dir=x", "log"],
      ["gc"],
      ["merge-tree"],
    ]) {
      expect(() => assertReadOnlyGit(args)).toThrow(/not allowed/);
    }
  });

  test("refuses options that write, run programs or read outside the repo, abbreviated too", () => {
    for (const opt of [
      "--output=/tmp/x",
      "--outp=/tmp/x",
      "--ext-diff",
      "--textconv",
      "--textc",
      "--filters",
      "--no-index",
      "--contents=/etc/passwd",
      "--open-files-in-pager=vi",
      "-Ovi",
      "-O/tmp/order",
      "--exec=x",
      "--upload-pack=x",
    ]) {
      expect(() => assertReadOnlyGit(["diff", opt])).toThrow(/not allowed/);
    }
  });
});

describe("fakeInboxIO", () => {
  test("answers from its maps and still refuses what git refuses", async () => {
    const diff = "diff --git a/a.ts b/a.ts\n+a\ndiff --git a/b.ts b/b.ts\n+b\n";
    const io = fakeInboxIO({
      base: { "a.ts": "old" },
      head: { "a.ts": "new" },
      diff,
      git: () => "ok",
    });
    expect(await io.readBaseFile("a.ts")).toBe("old");
    expect(await io.readHeadFile("a.ts")).toBe("new");
    expect(await io.readHeadFile("none")).toBeNull();
    expect(await io.diff(["b.ts"])).toBe("diff --git a/b.ts b/b.ts\n+b\n");
    expect(await io.git(["log"])).toBe("ok");
    await expect(io.git(["push"])).rejects.toThrow(/not allowed/);
    await expect(fakeInboxIO().git(["log"])).rejects.toThrow("no git here");
    expect(filterDiff(diff, [])).toBe("");
  });
});

describe("gitInboxIO", () => {
  let repo: Awaited<ReturnType<typeof tempRepo>>;
  let base = "";
  let head = "";

  beforeAll(async () => {
    repo = await tempRepo();
    await repo.write("a.ts", "export const a = 1;\n");
    await repo.write(":odd.ts", "magic-looking name\n");
    base = await repo.commit("base");
    await repo.git("checkout", "-q", "-b", "feature");
    await repo.write("a.ts", "export const a = 2;\n");
    await repo.write(":odd.ts", "still a name\n");
    await repo.write("b.ts", "export const b = 1;\n");
    head = await repo.commit("head");
    await repo.git("checkout", "-q", "main");
  });
  afterAll(() => repo.cleanup());

  test("reads files at the base and the head", async () => {
    const io = gitInboxIO({ repoDir: repo.dir, baseTip: "main", head });
    expect(io.revs).toEqual({ base: "main", head });
    expect(await io.readBaseFile("a.ts")).toBe("export const a = 1;\n");
    expect(await io.readHeadFile("a.ts")).toBe("export const a = 2;\n");
    expect(await io.readBaseFile("b.ts")).toBeNull();
    expect(await io.readHeadFile("../etc/passwd")).toBeNull();
    expect(
      await gitInboxIO({ repoDir: repo.dir, baseTip: base, head, maxFileBytes: 5 }).readHeadFile(
        "a.ts",
      ),
    ).toBeNull();
  });

  test("diffs from the merge base, for some paths, names taken literally", async () => {
    const io = gitInboxIO({ repoDir: repo.dir, baseTip: base, head });
    const all = await io.diff();
    expect(all).toContain("diff --git a/a.ts b/a.ts");
    expect(all).toContain("diff --git a/b.ts b/b.ts");
    const one = await io.diff([":odd.ts"]);
    expect(one).toContain("+still a name");
    expect(one).not.toContain("a.ts b/a.ts");
    expect(await io.diff([])).toBe("");
  });

  test("runs read-only git and refuses the rest", async () => {
    const io = gitInboxIO({ repoDir: repo.dir, baseTip: base, head });
    expect((await io.git(["rev-parse", head])).trim()).toBe(head);
    expect(await io.git(["log", "--format=%s", head])).toBe("head\nbase\n");
    await expect(io.git(["commit", "--allow-empty", "-m", "x"])).rejects.toThrow(/not allowed/);
    await expect(io.git(["diff", `--output=${join(repo.dir, "out")}`, base, head])).rejects.toThrow(
      /not allowed/,
    );
    await expect(io.git(["log", "no-such-rev"])).rejects.toThrow(/git log failed/);
  });

  test("in a blobless bare clone, contents are fetched lazily on first read", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await repo.git("config", "uploadpack.allowFilter", "true");
      const clone = join(dir, "widgets.git");
      await git(dir, [
        "clone",
        "-q",
        "--bare",
        "--filter=blob:none",
        "--no-local",
        `file://${repo.dir}`,
        clone,
      ]);
      const missing = async () =>
        (await git(clone, ["rev-list", "--objects", "--missing=print", "feature"]))
          .split("\n")
          .filter((l) => l.startsWith("?")).length;
      const before = await missing();
      expect(before).toBeGreaterThan(0);
      const io = gitInboxIO({ repoDir: clone, baseTip: "main", head: "feature" });
      // History and trees need no blobs.
      expect(await io.git(["log", "--name-only", "--format=%s", "feature"])).toContain("b.ts");
      expect(await missing()).toBe(before);
      expect(await io.readHeadFile("b.ts")).toBe("export const b = 1;\n");
      expect(await missing()).toBeLessThan(before);
    } finally {
      await cleanup();
    }
  });
});
