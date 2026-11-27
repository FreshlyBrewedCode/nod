import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { changedFiles, git } from "../patch-id.ts";
import { tempRepo } from "../test-support.ts";
import { createInboxContext } from "./context.ts";
import { gitInboxIO } from "./git-io.ts";
import { familiarity, historyOf, hotspots, isMe } from "./history.ts";
import { runAnalyzer } from "./run.ts";
import type { InboxContext } from "./types.ts";

let repo: Awaited<ReturnType<typeof tempRepo>>;
let ctx: InboxContext;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Commits with a date and an author, as history from other people and long ago. */
async function commitAt(message: string, days: number, author = "alice <alice@example.invalid>") {
  const date = daysAgo(days);
  await repo.git("add", "-A");
  await git(repo.dir, ["commit", "-q", "--allow-empty", "-m", message, `--author=${author}`], {
    env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

beforeAll(async () => {
  repo = await tempRepo();
  await repo.write("src/busy.ts", "0\n");
  await repo.write("src/calm.ts", "0\n");
  await repo.write("src/old.ts", "0\n");
  await repo.write("bun.lock", "0\n");
  await commitAt("start", 400);
  await repo.write("src/old.ts", "1\n");
  await commitAt("old change", 90, "bob <12345+bob@users.noreply.github.com>");
  for (let i = 1; i <= 4; i++) {
    await repo.write("src/busy.ts", `${i}\n`);
    await repo.write("bun.lock", `${i}\n`);
    if (i === 2) await repo.write("src/calm.ts", "1\n");
    await commitAt(`busy ${i}`, 20 - i, i === 4 ? "carol <carol@example.invalid>" : undefined);
  }
  const base = (await repo.git("rev-parse", "HEAD")).trim();
  await repo.git("checkout", "-q", "-b", "feature");
  for (const f of ["src/busy.ts", "src/calm.ts", "src/old.ts", "bun.lock"])
    await repo.write(f, "pr\n");
  await repo.write("src/new.ts", "new\n");
  const head = await repo.commit("the PR");
  const files = await changedFiles({ repoDir: repo.dir, baseTip: base, head });
  ctx = createInboxContext(
    {
      pr: {
        repo: "acme/widgets",
        number: 12,
        title: "Touch things",
        body: "",
        author: "carol",
        labels: [],
        base: "main",
        head_sha: head,
      },
      files,
      me: "bob",
      myWork: [],
      repoSummary: null,
    },
    gitInboxIO({ repoDir: repo.dir, baseTip: base, head }),
  );
});
afterAll(() => repo.cleanup());

describe("historyOf", () => {
  test("commits on the base touching the paths, newest first", async () => {
    const commits = await historyOf(ctx, ["src/calm.ts"], 30);
    expect(commits.map((c) => [c.name, c.files])).toEqual([["alice", ["src/calm.ts"]]]);
    expect(commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await historyOf(ctx, [], 30)).toEqual([]);
  });
});

describe("hotspots", () => {
  test("touched files that changed most in the window; added and generated files left out", async () => {
    const state = await runAnalyzer(hotspots({ days: 30 }), ctx);
    if (state.status !== "ready") throw new Error(JSON.stringify(state));
    expect(state.insight).toEqual({
      summary: "1 busy file, src/busy.ts most (4)",
      blocks: [
        {
          type: "files",
          label: "changed most in the last 30 days",
          items: [{ path: "src/busy.ts", value: 4, note: "4 changes in 30 days" }],
        },
      ],
    });
  });

  test("min and days", async () => {
    const state = await runAnalyzer(hotspots({ days: 30, min: 1 }), ctx);
    expect(state.status === "ready" && state.insight.blocks[0]).toMatchObject({
      items: [{ path: "src/busy.ts" }, { path: "src/calm.ts", value: 1 }],
    });
    expect((await runAnalyzer(hotspots({ days: 5 }), ctx)).status).toBe("empty");
  });
});

describe("familiarity", () => {
  test("isMe: listed emails, the noreply address, or the login as the name", () => {
    expect(isMe({ email: "12345+bob@users.noreply.github.com", name: "B" }, "bob", [])).toBe(true);
    expect(isMe({ email: "bob@users.noreply.github.com", name: "B" }, "bob", [])).toBe(true);
    expect(isMe({ email: "b@example.invalid", name: "Bob" }, "bob", [])).toBe(true);
    expect(isMe({ email: "b@example.invalid", name: "B" }, "bob", ["B@example.invalid"])).toBe(
      true,
    );
    expect(isMe({ email: "1+bobby@users.noreply.github.com", name: "x" }, "bob", [])).toBe(false);
  });

  test("the touched files I changed before", async () => {
    const f = familiarity();
    expect(f).toMatchObject({ id: "familiarity", when: "open", origin: "default" });
    const state = await runAnalyzer(f, ctx);
    if (state.status !== "ready") throw new Error(JSON.stringify(state));
    expect(state.insight.summary).toBe("you changed 1 of 3 files before");
    expect(state.insight.blocks[0]).toEqual({
      type: "stats",
      items: [{ label: "files you changed before", value: "1 of 3" }],
    });
    expect(state.insight.blocks[1]).toMatchObject({
      type: "files",
      items: [{ path: "src/old.ts", value: 1 }],
    });
  });

  test("new ground", async () => {
    const state = await runAnalyzer(familiarity(), { ...ctx, me: "dave" });
    expect(state.status === "ready" && state.insight.summary).toBe("new ground for you");
  });
});
