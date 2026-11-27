/**
 * `nod inbox init | test | path`, and the templates it writes, for real:
 * the templates load in the runner (the commented example too), the
 * example analyzer counts, `init` never writes over a file, and `test` runs
 * one PR of a temp git repo through a clone (`--dir`) and through nod's own
 * clone, with GitHub's part stubbed. Temp folders only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { testInboxContext } from "../../kit/inbox/context.ts";
import { git } from "../../kit/patch-id.ts";
import { tempDir, tempRepo } from "../../kit/test-support.ts";
import { loadTemplates } from "../../init/setup-files.ts";
import { todoCount } from "../../../templates/inbox/analyzers/todo-count.ts";
import { inboxEnv } from "./env";
import {
  inboxTemplates,
  parseInboxArgs,
  parsePrInput,
  runInbox,
  type InboxDeps,
  type InboxFlags,
} from "./cli";
import { InboxRunner } from "./runner";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function temp(prefix: string): Promise<string> {
  const { dir, cleanup } = await tempDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

async function load(dir: string) {
  const home = await temp("nod-home-");
  const r = new InboxRunner({
    dir,
    env: inboxEnv({ PATH: process.env.PATH, HOME: home }),
    watch: false,
    size: 1,
    log: () => {},
  });
  cleanups.push(() => r.stop());
  r.start();
  await r.ready();
  return r;
}

async function write(dir: string, files: Array<{ path: string; content: string }>) {
  for (const f of files) {
    await mkdir(join(dir, f.path, ".."), { recursive: true });
    await writeFile(join(dir, f.path), f.content);
  }
}

const flags = (over: Partial<InboxFlags>): InboxFlags => ({
  command: "path",
  inbox: null,
  force: false,
  pr: null,
  dir: null,
  json: false,
  ...over,
});

describe("the inbox templates", () => {
  test("inbox.ts loads as the defaults, labelled yours", async () => {
    const dir = await temp("nod-inbox-");
    await write(dir, await inboxTemplates("^1.0.0"));
    const r = await load(dir);
    expect(r.status()).toMatchObject({ config: "yours", state: "ready", error: null });
    expect(r.status().analyzers.map((a) => `${a.id}:${a.origin}`)).toEqual([
      "diff-composition:default",
      "hotspots:default",
      "overlaps-my-work:default",
    ]);
  });

  test("the commented example is a working inbox", async () => {
    const dir = await temp("nod-inbox-");
    const files = await inboxTemplates("^1.0.0");
    const inbox = files.find((f) => f.path === "inbox.ts")!.content;
    const example = inbox
      .slice(inbox.indexOf("// import"))
      .split("\n")
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n");
    await write(dir, [
      ...files.filter((f) => f.path !== "inbox.ts"),
      { path: "inbox.ts", content: example },
    ]);
    const r = await load(dir);
    expect(r.status()).toMatchObject({ state: "ready", error: null });
    expect(r.status().classifiers.map((c) => c.name)).toEqual([
      "overlapsMyWork",
      "briefMismatch",
      "watch(auth)",
      "mute",
      "watch(db)",
    ]);
    expect(r.status().analyzers.map((a) => a.id)).toContain("todo-count");
  });

  test("package.json pins the kit; nod init's setup leaves the inbox out", async () => {
    const pkg = (await inboxTemplates("github:FreshlyBrewedCode/nod#abc")).find(
      (f) => f.path === "package.json",
    )!;
    expect(JSON.parse(pkg.content).dependencies["@frebreco/nod"]).toBe(
      "github:FreshlyBrewedCode/nod#abc",
    );
    expect((await loadTemplates()).some((t) => t.path.startsWith("inbox/"))).toBe(false);
  });

  test("the example analyzer counts the TODO and FIXME lines a PR adds", async () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1,4 @@
 keep();
+// TODO: later
+// FIXME: now
+// TODO again
-// TODO removed, not counted
`;
    const files = [
      { path: "a.ts", status: "modified" as const, added: 3, removed: 1, binary: false },
    ];
    expect(await todoCount.run(testInboxContext({ files }, { diff }))).toEqual({
      type: "stats",
      items: [
        { label: "TODO", value: 2 },
        { label: "FIXME", value: 1, tone: "warn" },
      ],
    });
    expect(await todoCount.run(testInboxContext({ files }, { diff: "" }))).toBeNull();
  });
});

describe("nod inbox", () => {
  const deps = (over: Partial<InboxDeps> = {}) => {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      lines,
      errors,
      deps: {
        version: "1.2.3",
        out: (l: string) => lines.push(l),
        err: (l: string) => errors.push(l),
        ...over,
      } satisfies InboxDeps,
    };
  };

  test("parses its commands and the ways to name a PR", () => {
    expect(parseInboxArgs(["init", "--force"])).toMatchObject({
      kind: "inbox",
      flags: { command: "init", force: true },
    });
    expect(parseInboxArgs(["test", "acme/widgets#3", "--json"])).toMatchObject({
      flags: { command: "test", pr: "acme/widgets#3", json: true },
    });
    expect(parseInboxArgs(["test"])).toMatchObject({ kind: "error" });
    expect(parseInboxArgs(["path", "--force"])).toMatchObject({ kind: "error" });
    expect(parseInboxArgs(["nope"])).toMatchObject({ kind: "error" });
    expect(parsePrInput("12")).toEqual({ repo: null, number: 12 });
    expect(parsePrInput("#12")).toEqual({ repo: null, number: 12 });
    expect(parsePrInput("acme/widgets#7")).toEqual({
      repo: { host: "github.com", name: "acme/widgets" },
      number: 7,
    });
    expect(parsePrInput("acme.ghe.com/finance/ledger#57")).toEqual({
      repo: { host: "acme.ghe.com", name: "finance/ledger" },
      number: 57,
    });
    expect(parsePrInput("https://acme.ghe.com/finance/ledger/pull/57/files")).toEqual({
      repo: { host: "acme.ghe.com", name: "finance/ledger" },
      number: 57,
    });
    expect(parsePrInput("acme/widgets")).toBeNull();
  });

  test("init writes the templates, never over a file, unless --force; path says what is there", async () => {
    const config = await temp("nod-config-");
    const dir = join(config, "nod", "inbox");
    const a = deps();
    expect(await runInbox(flags({ command: "init", inbox: dir }), a.deps)).toBe(0);
    for (const f of ["inbox.ts", "analyzers/todo-count.ts", "package.json", "tsconfig.json"])
      expect(existsSync(join(dir, f))).toBe(true);
    expect(
      JSON.parse(await readFile(join(dir, "package.json"), "utf8")).dependencies["@frebreco/nod"],
    ).toBe("^1.2.3");

    await writeFile(join(dir, "inbox.ts"), "// mine");
    const b = deps();
    expect(await runInbox(flags({ command: "init", inbox: dir }), b.deps)).toBe(1);
    expect(b.errors.join("\n")).toContain("nothing was written");
    expect(await readFile(join(dir, "inbox.ts"), "utf8")).toBe("// mine");
    expect(await runInbox(flags({ command: "init", inbox: dir, force: true }), deps().deps)).toBe(
      0,
    );
    expect(await readFile(join(dir, "inbox.ts"), "utf8")).toContain("defineInbox");

    const c = deps();
    await runInbox(flags({ command: "path", inbox: dir }), c.deps);
    expect(c.lines).toEqual([dir, "  inbox.ts: yours, nod serve runs exactly what it lists"]);
  });

  /** An upstream with `main` and a PR head; the PR adds a TODO under src/auth/. */
  async function upstream() {
    const repo = await tempRepo();
    cleanups.push(repo.cleanup);
    await repo.write("src/auth/keys.ts", "export const a = 1;\n");
    await repo.write("README.md", "readme\n");
    await repo.commit("base");
    await repo.git("checkout", "-q", "-b", "pr");
    await repo.write(
      "src/auth/keys.ts",
      "export const a = 1;\n// TODO rotate\nexport const b = 2;\n",
    );
    await repo.write("docs/keys.md", "keys\n");
    const head = await repo.commit("pr");
    await repo.git("checkout", "-q", "main");
    return { repo, head };
  }

  const INBOX = `import { defaults, defineInbox, watch } from "@frebreco/nod/kit/inbox";
import { todoCount } from "./analyzers/todo-count.ts";
const base = defaults();
export default defineInbox({
  classifiers: [...base.classifiers, watch("src/auth/**", { tag: "auth" })],
  analyzers: [...base.analyzers, todoCount],
});
`;

  async function inboxWith() {
    const dir = await temp("nod-inbox-");
    await write(dir, await inboxTemplates("^1.0.0"));
    await writeFile(join(dir, "inbox.ts"), INBOX);
    return dir;
  }

  const readPr =
    (head: string): InboxDeps["readPr"] =>
    async ({ name, number }) => ({
      pr: {
        repo: name,
        number,
        title: "auth: rotate keys",
        body: "",
        author: "alice",
        labels: [],
        base: "main",
        head_sha: head,
      },
      state: "open",
      me: "bob",
      myWork: [],
    });

  test("test runs one PR of a --dir clone and prints what the panel would show", async () => {
    const { repo, head } = await upstream();
    const clone = await temp("nod-clone-");
    await git(clone, ["init", "-q", "-b", "main"]);
    await git(clone, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    const inbox = await inboxWith();
    const r = deps({ token: () => "t", readPr: readPr(head), remote: repo.dir });
    const code = await runInbox(flags({ command: "test", inbox, pr: "3", dir: clone }), r.deps);
    expect(r.errors).toEqual([]);
    expect(code).toBe(0);
    const text = r.lines.join("\n");
    expect(text).toContain("acme/widgets#3 · auth: rotate keys · alice");
    expect(text).toContain("attention: +1 (up a tier)");
    expect(text).toContain("watch(auth): +1 [auth]");
    expect(text).toContain("What changed (diff-composition, default, poll)");
    expect(text).toContain("TODOs added (todo-count, yours, poll)");
    expect(text).toMatch(/TODO: 1\n\s+FIXME: 0/);
  });

  test("test fetches into nod's own clone, in the cache, and prints JSON", async () => {
    const { repo, head } = await upstream();
    const cache = await temp("nod-cache-");
    const configDir = await temp("nod-config-");
    const configFile = join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({ version: 1, repos: [{ host: "github.com", repo: "acme/widgets" }] }),
    );
    const r = deps({
      token: () => "t",
      readPr: readPr(head),
      remote: `file://${repo.dir}`,
      cacheDir: cache,
      configFile,
    });
    const code = await runInbox(
      flags({ command: "test", inbox: await inboxWith(), pr: "#3", json: true }),
      r.deps,
    );
    expect(r.errors.filter((e) => !e.includes("filtering not recognized"))).toEqual([]);
    expect(code).toBe(0);
    const out = JSON.parse(r.lines.join("\n"));
    expect(out.attention.tags).toEqual(["auth"]);
    expect(out.insights.find((s: { id: string }) => s.id === "todo-count")).toMatchObject({
      status: "ready",
      insight: {
        blocks: [
          {
            type: "stats",
            items: [
              { label: "TODO", value: 1 },
              { label: "FIXME", value: 0 },
            ],
          },
        ],
      },
    });
    expect(existsSync(join(cache, "clones", "github.com", "acme", "widgets.git"))).toBe(true);
  });

  test("test says what is missing: the repo, the login, an open PR", async () => {
    const configDir = await temp("nod-config-");
    const configFile = join(configDir, "none.json");
    const a = deps({ configFile, token: () => "t" });
    expect(await runInbox(flags({ command: "test", pr: "3" }), a.deps)).toBe(1);
    expect(a.errors[0]).toContain("name the repository: owner/name#3");
    const b = deps({ configFile, token: () => null });
    expect(await runInbox(flags({ command: "test", pr: "acme/widgets#3" }), b.deps)).toBe(1);
    expect(b.errors[0]).toContain("`gh` is not logged in to github.com");
    const c = deps({
      configFile,
      token: () => "t",
      readPr: async (i) => ({ ...(await readPr("a".repeat(40))!(i)), state: "merged" }),
    });
    expect(await runInbox(flags({ command: "test", pr: "acme/widgets#3" }), c.deps)).toBe(1);
    expect(c.errors[0]).toContain("is merged; the inbox runs on open pull requests");
  });
});
