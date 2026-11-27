/**
 * The runner with real subprocesses (`child.ts` under the bun running the
 * tests): loading, the protocol and the server-side I/O, timeouts that kill
 * and restart, crashes, the scrubbed environment, load errors and reload.
 * Inbox folders are temp dirs; the environment's XDG folders are too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fakeInboxIO } from "../../kit/inbox/context.ts";
import type { InboxInput } from "../../kit/inbox/context.ts";
import { tempDir } from "../../kit/test-support.ts";
import { inboxEnv } from "./env.ts";
import { InboxRunner, type RunnerOptions } from "./runner.ts";
import type { JobInput, PlannedAnalyzer } from "./wire.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function folder(files: Record<string, string> = {}): Promise<string> {
  const { dir, cleanup } = await tempDir("nod-inbox-");
  cleanups.push(cleanup);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

async function runner(dir: string, options: Partial<RunnerOptions> = {}): Promise<InboxRunner> {
  const { dir: home, cleanup } = await tempDir("nod-home-");
  cleanups.push(cleanup);
  const lines: string[] = [];
  const r = new InboxRunner({
    dir,
    env: inboxEnv({
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "c"),
      XDG_CACHE_HOME: join(home, "k"),
    }),
    watch: false,
    size: 1,
    log: (line) => lines.push(line),
    ...options,
  });
  cleanups.push(() => r.stop());
  r.start();
  await r.ready();
  return r;
}

const input = (over: Partial<InboxInput> = {}): InboxInput => ({
  pr: {
    repo: "acme/widgets",
    number: 12,
    title: "auth: rotate keys",
    body: "",
    author: "alice",
    labels: [],
    base: "main",
    head_sha: "a".repeat(40),
  },
  files: [
    { path: "src/auth/keys.ts", status: "modified", added: 3, removed: 1, binary: false },
    { path: "docs/auth.md", status: "modified", added: 2, removed: 0, binary: false },
  ],
  me: "bob",
  myWork: [],
  repoSummary: null,
  ...over,
});

const DIFF = `diff --git a/src/auth/keys.ts b/src/auth/keys.ts
--- a/src/auth/keys.ts
+++ b/src/auth/keys.ts
@@ -1,2 +1,4 @@
 export const a = 1;
+// rotate on every privilege change
+export const b = 2;
+export const c = 3;
-export const old = 0;
`;

const job = (over: Partial<InboxInput> = {}): JobInput => ({
  input: input(over),
  revs: { base: "base", head: "head" },
  patchId: "p".repeat(40),
});

const plan = (id: string, when: "poll" | "open" = "poll"): PlannedAnalyzer => ({
  id,
  title: id,
  when,
  origin: "yours",
  key: `${id}:x`,
});

const YOURS = `
import { classifier, defaults, defineAnalyzer, defineInbox, stats, text, watch } from "@frebreco/nod/kit/inbox";
import { slow, spin, crash, env, printer, gitter } from "./analyzers/more.ts";

export default defineInbox({
  classifiers: [...defaults().classifiers, watch("src/auth/**", { tag: "auth" }),
    classifier("wip", ({ pr }) => (/wip/i.test(pr.title) ? [{ attention: -1, detail: "work in progress" }] : []))],
  analyzers: [
    defineAnalyzer({ id: "count", title: "Count", when: "poll", run: ({ files }) => stats([{ label: "files", value: files.length }]) }),
    defineAnalyzer({ id: "later", title: "Later", when: "open", run: () => text("**opened**") }),
    slow, spin, crash, env, printer, gitter,
  ],
});
`;

const MORE = `
import { defineAnalyzer, text } from "@frebreco/nod/kit/inbox";
export const slow = defineAnalyzer({ id: "slow", title: "Slow", when: "poll", run: () => new Promise(() => {}) });
export const spin = defineAnalyzer({ id: "spin", title: "Spin", when: "poll", run: () => { for (;;) {} } });
export const crash = defineAnalyzer({ id: "crash", title: "Crash", when: "poll", run: () => process.exit(3) });
export const env = defineAnalyzer({ id: "env", title: "Env", when: "poll", run: () => text(Object.keys(process.env).sort().join(" ")) });
export const printer = defineAnalyzer({ id: "printer", title: "Printer", when: "poll", run: () => {
  console.log("hello from an analyzer");
  process.stdout.write("not a message\\n");
  return text("printed");
} });
export const gitter = defineAnalyzer({ id: "gitter", title: "Git", when: "poll", run: async (ctx) => {
  const log = await ctx.git(["log", "--oneline"]);
  let refused = "";
  try { await ctx.git(["push", "origin"]); } catch (e) { refused = String(e); }
  const base = await ctx.readBaseFile("README.md");
  const diff = await ctx.diff(["src/auth/keys.ts"]);
  return text([log.trim(), refused.includes("not allowed") ? "push refused" : "push ran", base ?? "none", String(diff.length > 0)].join(" | "));
} });
`;

describe("the inbox runner", () => {
  test("no inbox.ts: the defaults load and run", async () => {
    const r = await runner(await folder());
    expect(r.status()).toMatchObject({ config: "default", state: "ready", error: null });
    expect(r.status().analyzers.map((a) => [a.id, a.origin])).toEqual([
      ["diff-composition", "default"],
      ["hotspots", "default"],
      ["overlaps-my-work", "default"],
    ]);
    const io = fakeInboxIO({ diff: DIFF });
    const prepared = (await r.prepare(job(), io))!;
    expect(prepared.attention).toMatchObject({ attention: 0, tags: [] });
    const composition = prepared.analyzers.find((a) => a.id === "diff-composition")!;
    expect(composition.key).toBe(`diff-composition:${"p".repeat(40)}`);
    const state = await r.analyze(job(), composition, io);
    expect(state).toMatchObject({ id: "diff-composition", status: "ready", origin: "default" });
    if (state?.status !== "ready") throw new Error("not ready");
    expect(state.insight.blocks[0]).toMatchObject({ type: "breakdown", unit: "lines" });
  });

  test("my inbox.ts: classifiers, analyzers, and the kit from this nod", async () => {
    const r = await runner(await folder({ "inbox.ts": YOURS, "analyzers/more.ts": MORE }));
    expect(r.status()).toMatchObject({ config: "yours", state: "ready" });
    expect(r.status().classifiers.map((c) => [c.name, c.origin])).toContainEqual([
      "watch(auth)",
      "yours",
    ]);
    const io = fakeInboxIO({ diff: DIFF });
    const prepared = (await r.prepare(job(), io))!;
    expect(prepared.attention).toMatchObject({ attention: 1, tags: ["auth"] });
    expect(prepared.analyzers.map((a) => a.id)).toContain("later");
    expect(await r.analyze(job(), plan("count"), io)).toMatchObject({
      status: "ready",
      insight: { blocks: [{ type: "stats", items: [{ label: "files", value: 2 }] }] },
    });
    const wip = (await r.prepare(job({ pr: { ...input().pr, title: "WIP auth" } }), io))!;
    expect(wip.attention.attention).toBe(0); // +1 and -1
    expect(wip.attention.marks.map((m) => m.classifier)).toEqual(["watch(auth)", "wip"]);
  });

  test("an analyzer that hangs: failed, the process killed and restarted", async () => {
    const r = await runner(await folder({ "inbox.ts": YOURS, "analyzers/more.ts": MORE }), {
      timeouts: { poll: 300 },
      graceMs: 200,
    });
    const io = fakeInboxIO();
    // Awaits forever: the kit's own timeout answers.
    expect(await r.analyze(job(), plan("slow"), io)).toMatchObject({
      status: "failed",
      error: "timed out after 300 ms",
    });
    // Spins: only killing the process ends it.
    const spun = await r.analyze(job(), plan("spin"), io);
    expect(spun).toMatchObject({ status: "failed" });
    expect(spun?.status === "failed" && spun.error).toContain("the inbox process was restarted");
    // The next job runs in the new process.
    expect(await r.analyze(job(), plan("count"), io)).toMatchObject({ status: "ready" });
  });

  test("an analyzer that exits the process: failed, and it starts again", async () => {
    const r = await runner(await folder({ "inbox.ts": YOURS, "analyzers/more.ts": MORE }), {
      backoffMs: 10,
    });
    const crashed = await r.analyze(job(), plan("crash"), fakeInboxIO());
    expect(crashed).toMatchObject({ status: "failed" });
    expect(crashed?.status === "failed" && crashed.error).toContain("exited (code 3)");
    expect(await r.analyze(job(), plan("count"), fakeInboxIO())).toMatchObject({ status: "ready" });
  });

  test("the environment is scrubbed: no tokens, nothing of nod's", async () => {
    const env = inboxEnv({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      GH_TOKEN: "gho_secret",
      GITHUB_TOKEN: "ghs_secret",
      GH_ENTERPRISE_TOKEN: "x",
      NOD_DEBUG: "1",
      GIT_CONFIG_COUNT: "1",
      SSH_AUTH_SOCK: "/tmp/agent",
      HTTPS_PROXY: "http://user:pw@proxy",
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/x/config",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/x/config",
      XDG_CACHE_HOME: "/home/someone/.cache",
      XDG_DATA_HOME: "/home/someone/.local/share",
      XDG_STATE_HOME: "/home/someone/.local/state",
      NO_COLOR: "1",
    });
    // And the process sees only that (bun adds nothing that matters here).
    const dir = await folder({ "inbox.ts": YOURS, "analyzers/more.ts": MORE });
    const { dir: home, cleanup } = await tempDir("nod-home-");
    cleanups.push(cleanup);
    const r = await runner(dir, {
      env: inboxEnv({ ...process.env, GH_TOKEN: "gho_secret", NOD_DEBUG: "1", HOME: home }),
    });
    const state = await r.analyze(job(), plan("env"), fakeInboxIO());
    if (state?.status !== "ready" || state.insight.blocks[0]?.type !== "text")
      throw new Error("no env");
    const names = state.insight.blocks[0].markdown.split(" ");
    expect(names).not.toContain("GH_TOKEN");
    expect(names).not.toContain("NOD_DEBUG");
    expect(names.filter((n) => /TOKEN|^NOD_|^GIT_/.test(n))).toEqual([]);
  });

  test("printing does not break the protocol; git I/O runs on the server's side", async () => {
    const r = await runner(await folder({ "inbox.ts": YOURS, "analyzers/more.ts": MORE }));
    expect(await r.analyze(job(), plan("printer"), fakeInboxIO())).toMatchObject({
      status: "ready",
      insight: { blocks: [{ type: "text", markdown: "printed" }] },
    });
    const calls: string[][] = [];
    const io = fakeInboxIO({
      diff: DIFF,
      base: { "README.md": "readme" },
      git: (args) => {
        calls.push([...args]);
        return "abc123 first\n";
      },
    });
    expect(await r.analyze(job(), plan("gitter"), io)).toMatchObject({
      status: "ready",
      insight: {
        blocks: [{ type: "text", markdown: "abc123 first | push refused | readme | true" }],
      },
    });
    expect(calls).toEqual([["log", "--oneline"]]);
  });

  test("a load error is the status; nothing runs until the folder loads again", async () => {
    const dir = await folder({ "inbox.ts": "export default defineInbox({ analyzers: [" });
    const r = await runner(dir);
    expect(r.status()).toMatchObject({ config: "yours", state: "error" });
    expect(r.status().error).toBe("inbox.ts does not load: Unexpected end of file (inbox.ts:1:42)");
    expect(await r.prepare(job(), fakeInboxIO())).toBeNull();
    expect(await r.analyze(job(), plan("count"), fakeInboxIO())).toBeNull();

    await writeFile(join(dir, "inbox.ts"), `export default 42;`);
    r.reload();
    await until(() => r.status().state === "error" && r.status().error!.includes("export default"));

    await writeFile(join(dir, "inbox.ts"), YOURS);
    await writeFile(join(dir, "analyzers/more.ts"), MORE).catch(async () => {
      await mkdir(join(dir, "analyzers"), { recursive: true });
      await writeFile(join(dir, "analyzers/more.ts"), MORE);
    });
    r.reload();
    await until(() => r.status().state === "ready");
    expect(r.status().error).toBeNull();
    expect(await r.analyze(job(), plan("count"), fakeInboxIO())).toMatchObject({ status: "ready" });
  });

  test("two analyzers with one id fail to load", async () => {
    const r = await runner(
      await folder({
        "inbox.ts": `import { defineAnalyzer, defineInbox } from "@frebreco/nod/kit/inbox";
const a = defineAnalyzer({ id: "same", title: "A", when: "poll", run: () => null });
export default defineInbox({ analyzers: [a, a] });`,
      }),
    );
    expect(r.status()).toMatchObject({
      state: "error",
      error: 'inbox.ts does not load: inbox: two analyzers have the id "same" (inbox.ts:3:16)',
    });
  });

  test("reload on save: the watcher notices a change in the folder", async () => {
    const dir = await folder();
    const r = await runner(dir, { watch: true, debounceMs: 50 });
    expect(r.status().config).toBe("default");
    const loads: string[] = [];
    r.subscribe((e) => e === "loaded" && loads.push(r.status().config));
    await writeFile(
      join(dir, "inbox.ts"),
      `import { defineInbox } from "@frebreco/nod/kit/inbox";\nexport default defineInbox({});`,
    );
    await until(() => loads.includes("yours"));
    expect(r.status()).toMatchObject({ config: "yours", state: "ready", analyzers: [] });
  });
});

async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}
