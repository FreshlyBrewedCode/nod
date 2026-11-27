import { describe, expect, test } from "bun:test";

import { classifyLocally, type LocalInput } from "./local";

const input = (over: Partial<LocalInput>): LocalInput => ({
  repo: "acme/widgets",
  number: 7,
  title: "a change",
  body: "",
  author: "bob",
  base: "main",
  headSha: "a".repeat(40),
  files: [{ path: "src/app.ts", additions: 10, deletions: 2 }],
  totalFiles: 1,
  ...over,
});

const tags = (r: Awaited<ReturnType<typeof classifyLocally>>) => r.reasons.map((f) => f.tag);

describe("the inbox step's own classification", () => {
  test("a small code change: no risk, nothing required, merges on its own", async () => {
    const r = await classifyLocally(input({}));
    expect([r.category, r.risk, r.fyi]).toEqual(["auto", 0, false]);
    expect(tags(r)).toEqual(["size:s"]);
  });

  test("the diff size, lockfiles left out", async () => {
    const r = await classifyLocally(
      input({
        files: [
          { path: "src/billing/proration.ts", additions: 300, deletions: 100 },
          { path: "bun.lock", additions: 4000, deletions: 3000 },
        ],
        totalFiles: 2,
      }),
    );
    expect(r.risk).toBe(2);
    expect(r.reasons.find((f) => f.tag === "size:l")?.detail).toBe(
      "+300 −100 in 1 file, 1 lockfile or generated file ignored",
    );
    expect(tags(r)).toContain("deps");
  });

  test("the template's paths: CI config is high risk, docs none", async () => {
    const ci = await classifyLocally(
      input({ files: [{ path: ".github/workflows/ci.yml", additions: 3, deletions: 1 }] }),
    );
    expect(ci.risk).toBe(3);
    expect(tags(ci)).toEqual(expect.arrayContaining(["ci-config", "protected"]));
    expect(ci.category).toBe("decide");
    const docs = await classifyLocally(
      input({ files: [{ path: "docs/sync.md", additions: 20, deletions: 3 }] }),
    );
    expect([docs.risk, tags(docs)]).toEqual([0, ["docs", "size:s"]]);
  });

  test("the brief's declarations only raise: Risk, FYI", async () => {
    const r = await classifyLocally(input({ body: "**Risk:** high\n\nFYI: on-call changes" }));
    expect([r.risk, r.fyi, r.category]).toEqual([3, true, "decide"]);
    const low = await classifyLocally(
      input({
        body: "Risk: none",
        files: [{ path: "src/app.ts", additions: 600, deletions: 0 }],
      }),
    );
    expect(low.risk).toBe(2);
  });

  test("a cut file list is not low risk: what GitHub did not list was not classified", async () => {
    const r = await classifyLocally(input({ totalFiles: 340 }));
    expect([r.risk, r.category]).toEqual([3, "decide"]);
    expect(r.reasons[0]).toEqual({
      classifier: "nod",
      tag: "partial",
      risk: 3,
      detail: "GitHub listed 1 of 340 files; the rest were not classified",
    });
  });
});
