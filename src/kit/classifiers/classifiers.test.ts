import { describe, expect, test } from "bun:test";

import { context, file } from "../test-support.ts";
import { declared } from "./declared.ts";
import { dependencies } from "./dependencies.ts";
import { DIFF_SIZE_IGNORE, diffSize, diffStat } from "./diff-size.ts";
import { globToRegExp, matchGlob } from "./glob.ts";
import { paths } from "./paths.ts";
import type { Classifier, ClassifierContext, Finding } from "./types.ts";

const findings = (c: Classifier, ctx: ClassifierContext) => c(ctx) as Finding[];

describe("glob", () => {
  const cases: [string, string, boolean][] = [
    ["core/**", "core/a.ts", true],
    ["core/**", "core/deep/a.ts", true],
    ["core/**", "corex/a.ts", false],
    ["core/**", "core", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/a/b.md", true],
    ["*.md", "docs/a.md", false],
    ["*.md", "a.md", true],
    ["src/**/test/*", "src/test/a.ts", true],
    ["src/**/test/*", "src/x/y/test/a.ts", true],
    ["src/**/test/*", "src/x/test/deep/a.ts", false],
    ["a?.ts", "ab.ts", true],
    ["a?.ts", "a/.ts", false],
    ["**/*.{js,ts}", "x/y.ts", true],
    ["**/*.{js,ts}", "x/y.tsx", false],
    [".github/**", ".github/workflows/nod.yml", true],
    ["**/*.yml", ".github/workflows/nod.yml", true],
    ["a.b", "axb", false],
    ["(x)+", "(x)+", true],
  ];
  for (const [glob, path, want] of cases) {
    test(`${glob} ${want ? "matches" : "does not match"} ${path}`, () =>
      expect(matchGlob(glob, path)).toBe(want));
  }
  test("compiled patterns are cached", () =>
    expect(globToRegExp("x/**")).toBe(globToRegExp("x/**")));
});

describe("paths", () => {
  test("one finding per matching pattern", () => {
    const c = paths({
      "core/**": { tag: "core", risk: 3 },
      "docs/**": { tag: "docs", risk: 0 },
      "x/**": { tag: "x" },
    });
    expect(findings(c, context([file("core/a.ts"), file("core/b.ts"), file("app/c.ts")]))).toEqual([
      {
        classifier: "paths",
        tag: "core",
        risk: 3,
        detail: "2 files under core/**: core/a.ts, core/b.ts",
      },
    ]);
  });

  test("long lists are shortened", () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => file(`docs/${n}.md`));
    const [f] = findings(paths({ "docs/**": { tag: "docs" } }), context(files));
    expect(f).toEqual({
      classifier: "paths",
      tag: "docs",
      detail: "5 files under docs/**: docs/a.md, docs/b.md, docs/c.md and 2 more",
    });
  });
});

describe("diffSize", () => {
  test("lockfiles and generated files do not count", () => {
    const files = [
      file("src/a.ts", 30, 10),
      file("bun.lock", 5000, 4000),
      file("web/dist/app.js", 900),
      file("x/y.min.js", 1),
    ];
    expect(diffStat(files)).toEqual({ added: 30, removed: 10, files: 1, ignored: 3 });
    expect(diffSize()(context(files))).toEqual([
      {
        classifier: "diffSize",
        tag: "size:s",
        risk: 0,
        detail: "+30 −10 in 1 file, 3 lockfile or generated files ignored",
      },
    ]);
  });

  test("thresholds pick the risk", () => {
    const c = diffSize({ thresholds: { 1: 10, 2: 100, 3: 1000 } });
    const risk = (lines: number) => findings(c, context([file("a.ts", lines)]))[0]!.risk;
    expect([risk(9), risk(10), risk(99), risk(100), risk(5000)]).toEqual([0, 1, 1, 2, 3]);
  });

  test("custom ignore list", () => {
    expect(diffStat([file("bun.lock", 10)], [])).toMatchObject({ added: 10, ignored: 0 });
    expect(DIFF_SIZE_IGNORE).toContain("**/bun.lock");
  });
});

describe("dependencies", () => {
  test("deps only vs deps plus code", () => {
    const c = dependencies();
    expect(c(context([file("src/a.ts")]))).toEqual([]);
    expect(c(context([file("package.json"), file("bun.lock")]))).toEqual([
      {
        classifier: "dependencies",
        tag: "deps-only",
        risk: 1,
        detail: "only dependencies: package.json, bun.lock",
      },
    ]);
    expect(
      c(context([file("web/package.json"), file("web/src/a.ts"), file("web/src/b.ts")])),
    ).toEqual([
      {
        classifier: "dependencies",
        tag: "deps",
        risk: 2,
        detail: "dependencies (web/package.json) change along with 2 other files",
      },
    ]);
  });

  test("risks are options", () => {
    const [f] = findings(dependencies({ onlyRisk: 0 }), context([file("go.sum")]));
    expect(f!.risk).toBe(0);
  });
});

describe("declared", () => {
  const run = (body: string, title = "Add a thing") =>
    findings(declared(), context([], { body, title }));

  test("reads risk, FYI, epic and dependencies from the brief", () => {
    const body = [
      "## Brief",
      "What: adds a thing.",
      "- **Risk:** high",
      "FYI: changes how agents name branches",
      "Epic: #1",
      "Depends on #3, #4 and #5",
      "depends on: #3",
    ].join("\r\n");
    expect(run(body)).toEqual([
      {
        classifier: "declared",
        tag: "declared:risk",
        risk: 3,
        detail: "the brief declares risk high",
      },
      { classifier: "declared", tag: "fyi", detail: "the brief marks this as FYI" },
      { classifier: "declared", tag: "epic", detail: "#1" },
      { classifier: "declared", tag: "depends-on", detail: "#3" },
      { classifier: "declared", tag: "depends-on", detail: "#4" },
      { classifier: "declared", tag: "depends-on", detail: "#5" },
    ]);
  });

  test("several risk lines: the highest wins", () => {
    expect(run("Risk: low\nRisk: 2\nRisk: none")[0]).toMatchObject({ risk: 2 });
  });

  test("FYI from the title; prose mentioning FYI or risk does not count", () => {
    expect(run("", "FYI: new branch naming").map((f) => f.tag)).toEqual(["fyi"]);
    expect(run("", "[FYI] new branch naming").map((f) => f.tag)).toEqual(["fyi"]);
    expect(run("This is not an FYI.\nThe risk: is low\nRiskless: high")).toEqual([]);
  });
});
