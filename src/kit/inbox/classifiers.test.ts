import { describe, expect, test } from "bun:test";

import { file } from "../test-support.ts";
import {
  briefMismatch,
  declaredRisk,
  findOverlaps,
  lookAtPaths,
  mute,
  overlapsMyWork,
  watch,
} from "./classifiers.ts";
import { testInboxContext } from "./context.ts";
import { evaluateAttention, runAnalyzer } from "./run.ts";
import type { AttentionClassifier, InboxContext, RepoSummary } from "./types.ts";

const marks = (c: AttentionClassifier, ctx: InboxContext) => c(ctx);

const myWork = [
  {
    repo: "acme/widgets",
    number: 14,
    title: "Session refresh",
    files: ["src/auth/session.ts", "src/a.ts"],
  },
  { repo: "acme/widgets", number: 15, title: "Login page", files: ["src/auth/session.ts"] },
  { repo: "acme/other", number: 3, title: "Elsewhere", files: ["src/a.ts"] },
];

const summary = (risk: RepoSummary["risk"]): RepoSummary => ({
  source: "verifier",
  risk,
  category: "decide",
  tags: [],
  fyi: false,
  satisfied: false,
});

describe("overlapsMyWork", () => {
  const ctx = testInboxContext({
    files: [file("src/auth/session.ts"), file("src/a.ts"), file("b.ts")],
    myWork,
  });

  test("finds my other PRs in the same repo that share files, most shared first", () => {
    expect(findOverlaps(ctx).map((o) => [o.pr.number, o.files])).toEqual([
      [14, ["src/auth/session.ts", "src/a.ts"]],
      [15, ["src/auth/session.ts"]],
    ]);
  });

  test("as a classifier: +1 for someone else's PR", async () => {
    expect(await marks(overlapsMyWork(), ctx)).toEqual([
      {
        attention: 1,
        tag: "my-work",
        detail: "touches 2 files of your #14, #15: src/auth/session.ts, src/a.ts",
      },
    ]);
  });

  test("no +1 for my own PR, and never for the PR itself", async () => {
    expect(
      await marks(
        overlapsMyWork(),
        testInboxContext({ pr: { author: "bob" }, files: [...ctx.files], myWork }),
      ),
    ).toEqual([]);
    const self = testInboxContext({
      files: [file("src/a.ts")],
      pr: { number: 14 },
      myWork: [myWork[0]!],
    });
    expect(findOverlaps(self)).toEqual([]);
  });

  test("as an analyzer: the shared files with my PRs, labelled default", async () => {
    const state = await runAnalyzer(overlapsMyWork(), ctx);
    expect(state).toMatchObject({
      id: "overlaps-my-work",
      origin: "default",
      when: "poll",
      status: "ready",
    });
    if (state.status !== "ready") throw new Error("not ready");
    expect(state.insight.summary).toBe("2 files shared with 2 PRs of yours");
    expect(state.insight.blocks[0]).toEqual({
      type: "files",
      items: [
        {
          path: "src/auth/session.ts",
          note: "#14 Session refresh",
          pr: { repo: "acme/widgets", number: 14 },
        },
        { path: "src/a.ts", note: "#14 Session refresh", pr: { repo: "acme/widgets", number: 14 } },
        {
          path: "src/auth/session.ts",
          note: "#15 Login page",
          pr: { repo: "acme/widgets", number: 15 },
        },
      ],
    });
  });

  test("its cache key follows my work, not the order of my PRs", () => {
    const a = overlapsMyWork();
    const key = (work: typeof myWork) => a.cacheKey!(testInboxContext({ myWork: work }));
    expect(key(myWork)).toBe(key([...myWork].reverse()));
    expect(key(myWork)).not.toBe(key(myWork.slice(1)));
    expect(key(myWork)).toBe(key([...myWork.slice(0, 2), { ...myWork[2]!, files: ["x"] }]));
  });
});

describe("watch", () => {
  test("+1 and the tag when any file matches", async () => {
    const ctx = testInboxContext({ files: [file("src/auth/login.ts"), file("README.md")] });
    expect(await marks(watch("src/auth/**", { tag: "auth" }), ctx)).toEqual([
      { attention: 1, tag: "auth", detail: "1 file you watch (src/auth/**): src/auth/login.ts" },
    ]);
    expect(await marks(watch(["docs/**"]), ctx)).toEqual([]);
  });

  test("other attention values and fyi", async () => {
    const ctx = testInboxContext({ files: [file("migrations/001.sql")] });
    expect(await marks(watch("**/*.sql", { attention: -1, tag: "db", fyi: true }), ctx)).toEqual([
      {
        attention: -1,
        tag: "db",
        fyi: true,
        detail: "1 file you watch (**/*.sql): migrations/001.sql",
      },
    ]);
  });
});

describe("mute", () => {
  const m = mute({ authors: ["Renovate"], paths: ["docs/**", "**/*.md"], labels: ["chore"] });
  test("by author, with or without [bot]", async () => {
    expect(
      await marks(m, testInboxContext({ pr: { author: "renovate[bot]" }, files: [file("x.ts")] })),
    ).toEqual([{ attention: "mute", detail: "you mute PRs by renovate[bot]" }]);
  });
  test("by label", async () => {
    expect(
      await marks(m, testInboxContext({ pr: { labels: ["Chore"] }, files: [file("x.ts")] })),
    ).toEqual([{ attention: "mute", detail: "you mute the label Chore" }]);
  });
  test("by paths only when every file matches", async () => {
    expect(
      await marks(m, testInboxContext({ files: [file("docs/a.md"), file("README.md")] })),
    ).toHaveLength(1);
    expect(
      await marks(m, testInboxContext({ files: [file("docs/a.md"), file("src/a.ts")] })),
    ).toEqual([]);
    expect(await marks(m, testInboxContext({ files: [] }))).toEqual([]);
  });
});

describe("briefMismatch", () => {
  test("reads the declared risk in the brief's usual shapes", () => {
    expect(declaredRisk("Risk: low")).toBe(1);
    expect(declaredRisk("- **Risk:** none, docs only")).toBe(0);
    expect(declaredRisk("## Risk\n\nHigh: touches auth")).toBe(3);
    expect(declaredRisk("risk 2")).toBeNull();
    expect(declaredRisk("")).toBeNull();
  });

  test("reads backticked paths from Look at", () => {
    const body = [
      "## What",
      "Mentions `src/elsewhere.ts` here.",
      "## Look at",
      "- `src/auth/session.ts:42` the refresh",
      "- the `docs/` folder and `refresh()`",
      "## Verified",
      "- `bun test src/auth/x.test.ts`",
    ].join("\n");
    expect(lookAtPaths(body)).toEqual(["src/auth/session.ts", "docs/"]);
    expect(lookAtPaths("**Look at:** `a/b.ts`, `c.md`\nWhy: `d/e.ts`")).toEqual(["a/b.ts", "c.md"]);
  });

  test("+1 when the declared risk is well below the repo's", async () => {
    const ctx = (risk: RepoSummary["risk"], body = "Risk: low") =>
      testInboxContext({ pr: { body }, files: [file("a.ts")], repoSummary: summary(risk) });
    expect(await marks(briefMismatch(), ctx(3))).toEqual([
      {
        attention: 1,
        tag: "brief-mismatch",
        detail: "the brief says low risk, the repo says high",
      },
    ]);
    expect(await marks(briefMismatch(), ctx(2))).toEqual([]);
    expect(await marks(briefMismatch({ gap: 1 }), ctx(2))).toHaveLength(1);
    expect(await marks(briefMismatch(), ctx(3, "no risk line"))).toEqual([]);
    expect(await marks(briefMismatch(), testInboxContext({ pr: { body: "Risk: low" } }))).toEqual(
      [],
    );
  });

  test("a tag when Look at names only paths the PR does not change", async () => {
    const ctx = (body: string) =>
      testInboxContext({ pr: { body }, files: [file("src/auth/session.ts")] });
    expect(await marks(briefMismatch(), ctx("Look at: `src/billing/pay.ts`"))).toEqual([
      {
        tag: "brief-mismatch",
        detail: "the brief says to look at src/billing/pay.ts, which this PR does not change",
      },
    ]);
    expect(await marks(briefMismatch(), ctx("Look at: `src/auth/`, `src/billing/pay.ts`"))).toEqual(
      [],
    );
    expect(await marks(briefMismatch(), ctx("Look at: `src/auth/session.ts`"))).toEqual([]);
  });
});

describe("evaluateAttention", () => {
  const ctx = testInboxContext({ files: [file("src/auth/a.ts")], myWork });
  test("adds up and clamps; mute wins; tags once", async () => {
    const plus = watch("src/**", { tag: "src" });
    const plus2 = watch("src/auth/**", { tag: "auth" });
    const minus = watch("**", { attention: -1, tag: "src" });
    expect((await evaluateAttention([plus, plus2], ctx)).attention).toBe(1);
    expect((await evaluateAttention([plus, minus], ctx)).attention).toBe(0);
    const all = await evaluateAttention([plus, minus, mute({ authors: ["alice"] })], ctx);
    expect(all.attention).toBe("mute");
    expect(all.tags).toEqual(["src"]);
    expect(all.marks.map((m) => m.classifier)).toEqual(["watch(src)", "watch(src)", "mute"]);
  });

  test("a throwing classifier adds an error and nothing else; junk is dropped; plain functions are named", async () => {
    function wip(): never {
      throw new Error("oops\nstack");
    }
    const junk = (() => [
      { attention: 5, detail: "x" },
      { fyi: true, detail: "kept" },
    ]) as never;
    const result = await evaluateAttention([wip as never, junk], ctx);
    expect(result).toEqual({
      attention: 0,
      tags: [],
      fyi: true,
      marks: [{ fyi: true, detail: "kept", classifier: "classifier" }],
      errors: ["wip: oops"],
    });
  });
});
