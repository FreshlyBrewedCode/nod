/**
 * The inbox through its public entry, the way a user's `inbox.ts` and the
 * runner use it.
 */
import { describe, expect, test } from "bun:test";

import {
  INBOX_VERSION,
  analyzerApplies,
  classifier,
  defaultInbox,
  defaults,
  defineAnalyzer,
  defineInbox,
  files,
  formatAttention,
  formatInsightState,
  inboxFor,
  insightCacheKey,
  mute,
  runAnalyzer,
  runInbox,
  stats,
  testInboxContext,
  text,
  toInsight,
  watch,
  type InsightState,
} from "@frebreco/nod/kit/inbox";

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { file } from "../test-support.ts";

/** What a user writes: an analyzer in a few lines. */
const testShare = defineAnalyzer({
  id: "test-share",
  title: "Tests",
  when: "poll",
  run({ files: changed }) {
    const tests = changed.filter((f) => f.path.includes(".test."));
    if (tests.length === 0) return null;
    return [
      stats([{ label: "test files", value: tests.length, tone: "good" }]),
      files(tests.map((f) => f.path)),
    ];
  },
});

const ctx = testInboxContext({
  files: [file("src/auth/a.ts", 10), file("src/auth/a.test.ts", 5)],
  myWork: [{ repo: "acme/widgets", number: 14, title: "Mine", files: ["src/auth/a.ts"] }],
});

test("the entry has a version", () => expect(INBOX_VERSION).toBe(1));

describe("defineAnalyzer", () => {
  test("labels it yours", () => expect(testShare.origin).toBe("yours"));
  test("refuses a bad id or when", () => {
    expect(() => defineAnalyzer({ ...testShare, id: "Bad Id" })).toThrow(/lower case/);
    expect(() => defineAnalyzer({ ...testShare, when: "always" as never })).toThrow(/poll/);
  });
});

describe("defineInbox", () => {
  test("defaults to empty lists", () =>
    expect(defineInbox({})).toEqual({ classifiers: [], analyzers: [], repos: {} }));

  test("refuses entries that are not classifiers or analyzers, and duplicate ids", () => {
    expect(() => defineInbox({ classifiers: [{} as never] })).toThrow(/classifiers\[0\]/);
    expect(() => defineInbox({ analyzers: [(() => []) as never] })).toThrow(/defineAnalyzer/);
    expect(() => defineInbox({ analyzers: [testShare, testShare] })).toThrow(/two analyzers/);
    expect(() =>
      defineInbox({ analyzers: [testShare], repos: { "acme/*": { analyzers: [testShare] } } }),
    ).toThrow(/acme\/\*: two analyzers/);
  });

  test("inboxFor adds the parts of matching repo keys, without case, first id wins", () => {
    const quiet = mute({ authors: ["alice"] });
    const other = defineAnalyzer({ ...testShare, title: "Other" });
    const inbox = defineInbox({
      classifiers: [watch("src/**")],
      analyzers: [],
      repos: {
        "ACME/*": { classifiers: [quiet], analyzers: [testShare] },
        "acme/widgets": { analyzers: [other] },
      },
    });
    const parts = inboxFor(inbox, "acme/widgets");
    expect(parts.classifiers).toHaveLength(2);
    expect(parts.analyzers.map((a) => a.title)).toEqual(["Tests"]);
    expect(inboxFor(inbox, "other/repo")).toEqual({
      classifiers: inbox.classifiers,
      analyzers: [],
    });
  });
});

describe("defaults", () => {
  test("overlapsMyWork and briefMismatch; composition, hotspots and the overlap insight; no familiarity", () => {
    const d = defaults();
    expect(d.classifiers.map((c) => c.classifierName)).toEqual(["overlapsMyWork", "briefMismatch"]);
    expect(d.analyzers.map((a) => [a.id, a.when, a.origin])).toEqual([
      ["diff-composition", "poll", "default"],
      ["hotspots", "poll", "default"],
      ["overlaps-my-work", "poll", "default"],
    ]);
    expect(defaultInbox().analyzers).toHaveLength(3);
  });

  test("spread into a user's inbox", () => {
    const base = defaults();
    const inbox = defineInbox({
      classifiers: [...base.classifiers, watch("src/auth/**", { tag: "auth" })],
      analyzers: [...base.analyzers, testShare],
    });
    expect(inbox.analyzers.map((a) => a.origin)).toEqual([
      "default",
      "default",
      "default",
      "yours",
    ]);
  });
});

describe("runAnalyzer", () => {
  const spec = { id: "x", title: "X", when: "open" as const };

  test("a user's analyzer: blocks become a ready insight", async () => {
    const state = await runAnalyzer(testShare, ctx);
    expect(state).toMatchObject({
      id: "test-share",
      title: "Tests",
      origin: "yours",
      when: "poll",
      status: "ready",
      insight: {
        blocks: [
          { type: "stats", items: [{ label: "test files", value: 1, tone: "good" }] },
          { type: "files", items: [{ path: "src/auth/a.test.ts" }] },
        ],
      },
    });
    expect(typeof (state as { ms?: number }).ms).toBe("number");
  });

  test("a single block, nothing, and junk", async () => {
    expect(toInsight(text("hi"))).toEqual({ blocks: [{ type: "text", markdown: "hi" }] });
    expect(
      (await runAnalyzer(defineAnalyzer({ ...spec, run: () => text("hi") }), ctx)).status,
    ).toBe("ready");
    expect((await runAnalyzer(defineAnalyzer({ ...spec, run: () => undefined }), ctx)).status).toBe(
      "empty",
    );
    expect(
      (
        await runAnalyzer(
          defineAnalyzer({ ...spec, run: () => ({ blocks: [{ type: "html" }] }) as never }),
          ctx,
        )
      ).status,
    ).toBe("empty");
  });

  test("a throw or a hang is failed, never thrown", async () => {
    const boom = defineAnalyzer({
      ...spec,
      run() {
        throw new Error("boom\n  at somewhere");
      },
    });
    expect(await runAnalyzer(boom, ctx)).toMatchObject({ status: "failed", error: "boom" });
    const hang = defineAnalyzer({ ...spec, run: () => new Promise<never>(() => {}) });
    expect(await runAnalyzer(hang, ctx, { timeoutMs: 20 })).toMatchObject({
      status: "failed",
      error: "timed out after 20 ms",
    });
  });

  test("appliesTo, and one that throws counts as no", () => {
    expect(
      analyzerApplies(defineAnalyzer({ ...spec, run: () => null, appliesTo: () => false }), ctx),
    ).toBe(false);
    expect(
      analyzerApplies(
        defineAnalyzer({
          ...spec,
          run: () => null,
          appliesTo() {
            throw new Error("x");
          },
        }),
        ctx,
      ),
    ).toBe(false);
    expect(analyzerApplies(testShare, ctx)).toBe(true);
  });
});

describe("insightCacheKey", () => {
  test("analyzer and patch-id, plus what cacheKey adds", () => {
    expect(insightCacheKey(testShare, "p1", ctx)).toBe("test-share:p1");
    const keyed = defineAnalyzer({ ...testShare, cacheKey: (c) => c.me });
    expect(insightCacheKey(keyed, "p1", ctx)).toBe("test-share:p1:bob");
    const broken = defineAnalyzer({
      ...testShare,
      cacheKey() {
        throw new Error("x");
      },
    });
    expect(insightCacheKey(broken, "p1", ctx)).not.toBe(insightCacheKey(broken, "p1", ctx));
  });
});

describe("runInbox", () => {
  const inbox = defineInbox({
    classifiers: [
      watch("src/auth/**", { tag: "auth" }),
      classifier("wip", ({ pr }) =>
        /wip/i.test(pr.title) ? [{ attention: -1, detail: "work in progress" }] : [],
      ),
    ],
    analyzers: [
      testShare,
      defineAnalyzer({ id: "later", title: "Later", when: "open", run: () => text("*later*") }),
    ],
  });

  test("attention and the analyzers of one kind, or all", async () => {
    const poll = await runInbox(inbox, ctx, { when: "poll" });
    expect(poll.attention).toMatchObject({ attention: 1, tags: ["auth"] });
    expect(poll.insights.map((s) => s.id)).toEqual(["test-share"]);
    const all = await runInbox(
      inbox,
      testInboxContext({
        pr: { title: "WIP: auth" },
        files: [...ctx.files],
        myWork: [...ctx.myWork],
      }),
    );
    expect(all.attention.attention).toBe(0);
    expect(all.insights.map((s) => s.id)).toEqual(["test-share", "later"]);
  });

  test("formats for a terminal", async () => {
    const result = await runInbox(inbox, ctx);
    expect(formatAttention(result.attention)).toBe(
      "attention: +1 (up a tier)\ntags: auth\n  watch(auth): +1 [auth] 2 files you watch (src/auth/**): src/auth/a.ts, src/auth/a.test.ts",
    );
    expect(result.insights.map(formatInsightState).join("\n")).toBe(
      [
        "Tests (test-share, yours, poll)",
        "    test files: 1",
        "",
        "    src/auth/a.test.ts",
        "Later (later, yours, open)",
        "    later",
      ].join("\n"),
    );
    const failed: InsightState = {
      id: "x",
      title: "X",
      origin: "yours",
      when: "open",
      status: "failed",
      error: "boom",
    };
    expect(formatInsightState(failed)).toBe("X (x, yours, open): failed: boom");
  });
});

test("every inbox module but git-io.ts is pure: no Node import, also through what it imports", async () => {
  const seen = new Set<string>();
  const visit = async (path: string): Promise<string[]> => {
    if (seen.has(path)) return [];
    seen.add(path);
    const source = await readFile(path, "utf8");
    const bad: string[] = [];
    for (const m of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
      if (m[1]) continue; // type-only imports are erased
      const spec = m[2]!;
      if (!spec.startsWith(".")) bad.push(`${path}: ${spec}`);
      else bad.push(...(await visit(resolve(dirname(path), spec))));
    }
    return bad;
  };
  const dir = import.meta.dir;
  for (const name of await readdir(dir)) {
    if (
      !name.endsWith(".ts") ||
      name.endsWith(".test.ts") ||
      name === "git-io.ts" ||
      name === "index.ts"
    )
      continue;
    expect(await visit(join(dir, name))).toEqual([]);
  }
});
