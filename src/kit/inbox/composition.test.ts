import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { changedFiles } from "../patch-id.ts";
import { file, tempRepo } from "../test-support.ts";
import {
  CommentTracker,
  commentRules,
  composeDiff,
  countLines,
  diffComposition,
  fileKind,
  filesToDiff,
  parseUnifiedDiff,
  unquoteGitPath,
} from "./composition.ts";
import { createInboxContext, testInboxContext } from "./context.ts";
import { gitInboxIO } from "./git-io.ts";
import { runAnalyzer } from "./run.ts";

describe("fileKind", () => {
  const cases: [string, string][] = [
    ["src/a.ts", "code"],
    ["src/a.test.ts", "tests"],
    ["tests/test_a.py", "tests"],
    ["pkg/a_test.go", "tests"],
    ["README.md", "docs"],
    ["docs/guide/x.html", "docs"],
    ["package.json", "config"],
    [".github/workflows/ci.yml", "config"],
    [".gitignore", "config"],
    ["vite.config.ts", "config"],
    ["bun.lock", "generated"],
    ["dist/app.js", "generated"],
    ["src/__snapshots__/a.snap", "generated"],
  ];
  for (const [path, kind] of cases)
    test(`${path} is ${kind}`, () => expect(fileKind(path)).toBe(kind as never));
});

describe("comment rules", () => {
  const comments = (path: string, lines: string[]) => {
    const t = new CommentTracker(commentRules(path)!);
    return lines.map((l) => t.next(l));
  };

  test("C-like: line, block, trailing and leading-star comments", () => {
    expect(
      comments("a.ts", [
        "// line",
        "const a = 1; // trailing is code",
        "/* one line */",
        "/* x */ code();",
        "/**",
        " * doc",
        " */",
        "*/ closes a comment above the hunk",
        "  * looks like a continuation",
        "*ptr = 1;",
        "/* a */ // b",
      ]),
    ).toEqual([true, false, true, false, true, true, true, true, true, false, true]);
  });

  test("a block comment's close with code after it", () => {
    expect(comments("a.c", ["/* open", "close */ int x;", "int y;"])).toEqual([true, false, false]);
  });

  test("Python: hash and docstrings", () => {
    expect(
      comments("a.py", [
        "# c",
        "def f():",
        '    """Doc',
        "    more",
        '    """',
        "    return 1",
        '    """one"""',
      ]),
    ).toEqual([true, false, true, true, true, false, true]);
  });

  test("other languages", () => {
    expect(comments("a.sql", ["-- c", "select 1;"])).toEqual([true, false]);
    expect(comments("a.lua", ["--[[ block", "still", "]]", "x = 1"])).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(comments("a.html", ["<!-- c -->", "<p>x</p>", "<!--", "y", "-->"])).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(comments("Makefile", ["# c", "all:"])).toEqual([true, false]);
    expect(comments("a.tex", ["% c", "\\x"])).toEqual([true, false]);
    expect(commentRules("data.bin")).toBeNull();
    expect(commentRules("LICENSE")).toBeNull();
  });
});

describe("parseUnifiedDiff", () => {
  test("unquotes C-quoted paths", () => {
    expect(unquoteGitPath('"a/\\303\\244 b\\"c.ts"')).toBe('a/ä b"c.ts');
    expect(unquoteGitPath("plain")).toBe("plain");
  });

  test("files, hunks and deleted files", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "x.ts", lines: ["@@", " keep", "-old", "+new"] },
      { path: "gone.ts", lines: ["@@", "-bye"] },
      { path: "img.png", lines: [] },
    ]);
  });
});

describe("countLines", () => {
  test("follows each side of a hunk separately, skips blank lines", () => {
    const counts = countLines(
      {
        path: "a.ts",
        lines: [
          "@@",
          "-/* old",
          "- still old",
          "-*/",
          "+// new",
          "+",
          "+code();",
          " /*",
          "+inside",
          " */",
        ],
      },
      "code",
    );
    expect(counts).toEqual({ comments: { added: 2, removed: 3 }, code: { added: 1, removed: 0 } });
  });
});

describe("composeDiff over a real git diff", () => {
  let repo: Awaited<ReturnType<typeof tempRepo>>;
  let base = "";
  let head = "";

  beforeAll(async () => {
    repo = await tempRepo();
    await repo.write("src/app.ts", "export const a = 1;\n");
    await repo.write("README.md", "# App\n");
    base = await repo.commit("base");
    await repo.write(
      "src/app.ts",
      "/**\n * The answer.\n */\nexport const a = 42; // why not\n\n// two\nexport const b = 2;\n",
    );
    await repo.write("src/app.test.ts", "// checks a\nexpect(a).toBe(42);\n");
    await repo.write("src/ä b.ts", "# not a comment in ts\nlet x = 1;\n");
    await repo.write("README.md", "# App\n\nMore words.\n");
    await repo.write("package.json", '{ "name": "x" }\n');
    await repo.write("bun.lock", "lock\nlock\nlock\n");
    head = await repo.commit("head");
  });
  afterAll(() => repo.cleanup());

  test("diffs only code and test files, counts the rest from the numstat", async () => {
    const files = await changedFiles({ repoDir: repo.dir, baseTip: base, head });
    expect(filesToDiff(files).sort()).toEqual(["src/app.test.ts", "src/app.ts", "src/ä b.ts"]);
    const io = gitInboxIO({ repoDir: repo.dir, baseTip: base, head });
    const c = composeDiff(files, await io.diff(filesToDiff(files)));
    expect(c).toEqual({
      code: { added: 4, removed: 1 },
      tests: { added: 1, removed: 0 },
      comments: { added: 5, removed: 0 },
      docs: { added: 2, removed: 0 },
      config: { added: 1, removed: 0 },
      generated: { added: 3, removed: 0 },
    });
  });

  test("the analyzer gives a breakdown and a summary", async () => {
    const files = await changedFiles({ repoDir: repo.dir, baseTip: base, head });
    const ctx = createInboxContext(
      { ...testInboxContext(), files, pr: testInboxContext().pr, myWork: [], repoSummary: null },
      gitInboxIO({ repoDir: repo.dir, baseTip: base, head }),
    );
    const state = await runAnalyzer(diffComposition(), ctx);
    if (state.status !== "ready") throw new Error(JSON.stringify(state));
    expect(state).toMatchObject({ id: "diff-composition", origin: "default", when: "poll" });
    expect(state.insight.summary).toBe("29% code, 29% comments");
    expect(state.insight.blocks).toEqual([
      {
        type: "breakdown",
        unit: "lines",
        items: [
          { label: "code", value: 5, tone: "c1", note: "+4 −1" },
          { label: "tests", value: 1, tone: "c2", note: "+1 −0" },
          { label: "comments", value: 5, tone: "c3", note: "+5 −0" },
          { label: "docs", value: 2, tone: "c4", note: "+2 −0" },
          { label: "config", value: 1, tone: "c5", note: "+1 −0" },
          { label: "generated", value: 3, tone: "muted", note: "+3 −0" },
        ],
      },
    ]);
  });

  test("empty PR: nothing to show", async () => {
    expect((await runAnalyzer(diffComposition(), testInboxContext({ files: [] }))).status).toBe(
      "empty",
    );
  });

  test("a file missing from the diff falls back to its numstat", () => {
    expect(composeDiff([file("src/x.ts", 3, 1)], "").code).toEqual({ added: 3, removed: 1 });
  });
});
