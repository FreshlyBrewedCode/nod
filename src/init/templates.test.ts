/**
 * The templates `nod init` ships, run for real: the default policy against
 * typical PRs, and `.nod/verify.ts` end to end in a checkout with real git
 * and ssh-keygen against a fake GitHub API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  decodeSummary,
  evaluatePolicy,
  nodHumanLine,
  patchId,
  renderNodComment,
  serializePayload,
  STICKY_MARKER,
  type NodPayload,
} from "../kit/index.ts";
import { git } from "../kit/patch-id.ts";
import { context, file, makeKey, sshSign, tempDir, tempRepo } from "../kit/test-support.ts";
import policy from "../../templates/.nod/policy.ts";
import { loadTemplates, renderSetup } from "./setup-files.ts";

const tiers = {
  "modules/billing/module.json": '{ "tier": 1 }',
  "modules/search/module.json": '{ "tier": 2 }',
  "modules/icons/module.json": '{ "tier": 3 }',
};

describe("the default policy", () => {
  const run = (files: ReturnType<typeof file>[], body = "") =>
    evaluatePolicy(policy, context(files, { body }, tiers));

  test("docs only: auto, no nod", async () => {
    expect(await run([file("docs/guide.md", 30), file("README.md", 2)])).toMatchObject({
      category: "auto",
      requirement: { level: "none" },
    });
  });

  test("a small code change needs a self nod; a big one a peer", async () => {
    expect(await run([file("app/a.ts", 10)])).toMatchObject({ requirement: { level: "self" } });
    expect(await run([file("app/a.ts", 600)])).toMatchObject({
      risk: 2,
      requirement: { level: "self" },
    });
    expect(await run([file("app/a.ts", 1200)])).toMatchObject({
      risk: 3,
      requirement: { level: "peer" },
    });
  });

  test("lockfiles do not count toward the size", async () => {
    expect(await run([file("bun.lock", 5000)])).toMatchObject({
      risk: 1,
      requirement: { level: "self" },
    });
  });

  test("nod's own setup and CI config need a peer", async () => {
    for (const path of [".nod/allowed_signers", ".github/workflows/ci.yml"])
      expect(await run([file(path)])).toMatchObject({ risk: 3, requirement: { level: "peer" } });
  });

  test("module tiers: a tier-3 update merges on its own, tier 1 and core/ need a peer", async () => {
    const leaf = await run([file("modules/icons/star.svg", 20)]);
    expect(leaf).toMatchObject({ category: "auto", risk: 0, requirement: { level: "none" } });
    expect(leaf.reasons.map((r) => r.tag)).toContain("pure-module");
    expect(await run([file("modules/search/q.ts")])).toMatchObject({
      risk: 2,
      requirement: { level: "self" },
    });
    expect(await run([file("modules/billing/pay.ts")])).toMatchObject({
      risk: 3,
      requirement: { level: "peer" },
    });
    expect(await run([file("core/engine.ts")])).toMatchObject({
      risk: 3,
      requirement: { level: "peer" },
    });
    expect(await run([file("modules/icons/a.svg"), file("app/a.ts")])).toMatchObject({
      requirement: { level: "self" },
    });
  });

  test("declared FYI on docs is fyi; declared risk only raises", async () => {
    expect(await run([file("docs/x.md")], "FYI: renamed a heading")).toMatchObject({
      category: "fyi",
      requirement: { level: "none" },
    });
    expect(await run([file("docs/x.md")], "Risk: high")).toMatchObject({
      requirement: { level: "peer" },
    });
    expect(await run([file("core/x.ts")], "Risk: low")).toMatchObject({ risk: 3 });
  });
});

// ---------------------------------------------------------------------------
// .nod/verify.ts end to end

const REPO = "acme/widgets";
const KIT_ROOT = resolve(import.meta.dir, "..", "..");

interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  created_at: string;
  updated_at: string;
}

interface FakeGitHub {
  url: string;
  prs: Map<number, Record<string, unknown>>;
  comments: Map<number, FakeComment[]>;
  checks: Record<string, unknown>[];
  labels: Map<number, string[]>;
  createdLabels: string[];
  stop: () => void;
}

function fakeGitHub(): FakeGitHub {
  const state = {
    prs: new Map<number, Record<string, unknown>>(),
    comments: new Map<number, FakeComment[]>(),
    checks: [] as Record<string, unknown>[],
    labels: new Map<number, string[]>(),
    createdLabels: [] as string[],
  };
  let nextId = 1000;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname.replace(`/repos/${REPO}`, "");
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json();
      let m: RegExpExecArray | null;
      if (req.method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(p))) {
        const pr = state.prs.get(Number(m[1]));
        if (!pr) return json({ message: "Not Found" }, 404);
        const labels = (state.labels.get(Number(m[1])) ?? []).map((name) => ({ name }));
        return json({ ...pr, labels });
      }
      if (req.method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(p)))
        return json(
          url.searchParams.get("page") === "1" ? (state.comments.get(Number(m[1])) ?? []) : [],
        );
      if (req.method === "POST" && p === "/check-runs") {
        state.checks.push(body);
        return json({ id: state.checks.length }, 201);
      }
      if (req.method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
        const c: FakeComment = {
          id: nextId++,
          body: body.body,
          user: { login: "github-actions[bot]", type: "Bot" },
          created_at: "2026-11-18T20:00:00Z",
          updated_at: "2026-11-18T20:00:00Z",
        };
        state.comments.set(Number(m[1]), [...(state.comments.get(Number(m[1])) ?? []), c]);
        return json({ id: c.id }, 201);
      }
      if (req.method === "PATCH" && (m = /^\/issues\/comments\/(\d+)$/.exec(p))) {
        for (const list of state.comments.values())
          for (const c of list) if (c.id === Number(m[1])) c.body = body.body;
        return json({});
      }
      if (req.method === "POST" && p === "/labels") {
        if (state.createdLabels.includes(body.name)) return json({ message: "exists" }, 422);
        state.createdLabels.push(body.name);
        return json({}, 201);
      }
      if (req.method === "POST" && (m = /^\/issues\/(\d+)\/labels$/.exec(p))) {
        const n = Number(m[1]);
        state.labels.set(n, [...(state.labels.get(n) ?? []), ...body.labels]);
        return json([]);
      }
      if (req.method === "DELETE" && (m = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(p))) {
        const n = Number(m[1]);
        const name = decodeURIComponent(m[2]!);
        state.labels.set(
          n,
          (state.labels.get(n) ?? []).filter((l) => l !== name),
        );
        return json([]);
      }
      return json({ message: `unexpected ${req.method} ${p}` }, 500);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, ...state, stop: () => server.stop(true) };
}

describe(".nod/verify.ts", () => {
  let keys: Awaited<ReturnType<typeof tempDir>>;
  let work: Awaited<ReturnType<typeof tempRepo>>;
  let bare: Awaited<ReturnType<typeof tempDir>>;
  let checkout: Awaited<ReturnType<typeof tempDir>>;
  let gh: FakeGitHub;
  let alice = { privateKey: "", publicKey: "" };
  let bob = { privateKey: "", publicKey: "" };
  const heads: Record<number, string> = {};

  beforeAll(async () => {
    keys = await tempDir();
    alice = await makeKey(keys.dir, "alice");
    bob = await makeKey(keys.dir, "bob");

    // The repo after the setup PR merged: the rendered templates on main.
    work = await tempRepo();
    const setup = renderSetup(await loadTemplates(), {
      kitSpec: "^1.0.0",
      signers: [
        { login: "alice", publicKey: alice.publicKey },
        { login: "bob", publicKey: bob.publicKey },
      ],
    });
    for (const f of setup) await work.write(f.path, f.content);
    for (const [path, content] of Object.entries(tiers)) await work.write(path, content);
    await work.write("core/engine.ts", "export const engine = 1;\n");
    await work.write("app/a.ts", "export const a = 1;\n");
    await work.commit("set up nod");
    const changes: Record<number, [string, string]> = {
      1: ["modules/icons/star.svg", "<svg/>\n"],
      2: ["core/engine.ts", "export const engine = 2;\n"],
    };
    for (const [n, [path, content]] of Object.entries(changes)) {
      await work.git("checkout", "-q", "-b", `pr-${n}`, "main");
      await work.write(path, content);
      heads[Number(n)] = await work.commit(`pr ${n}`);
    }
    await work.git("checkout", "-q", "main");

    // GitHub's side: a bare remote. The runner's side: a clone of main, like actions/checkout.
    bare = await tempDir("nod-bare-");
    await git(bare.dir, ["init", "-q", "--bare"]);
    await work.git("push", "-q", bare.dir, "main", "pr-1", "pr-2");
    checkout = await tempDir("nod-checkout-");
    await git(checkout.dir, ["clone", "-q", "--branch", "main", bare.dir, "."]);
    // `bun install` stand-in: the kit from this repo.
    await mkdir(join(checkout.dir, ".nod", "node_modules", "@frebreco"), { recursive: true });
    await symlink(KIT_ROOT, join(checkout.dir, ".nod", "node_modules", "@frebreco", "nod"), "dir");

    gh = fakeGitHub();
    for (const n of [1, 2, 3]) {
      gh.prs.set(n, {
        number: n,
        title: `PR ${n}`,
        body: "",
        user: { login: "alice" },
        base: { ref: "main" },
        head: { sha: heads[n] ?? "f".repeat(40) }, // PR 3's head is not in the repo
        state: "open",
      });
    }
  });

  afterAll(async () => {
    gh.stop();
    for (const d of [keys, work, bare, checkout]) await d.cleanup();
  });

  async function verify(event: Record<string, unknown>) {
    const eventPath = join(keys.dir, "event.json");
    await writeFile(eventPath, JSON.stringify(event));
    const before = gh.checks.length;
    const proc = Bun.spawn([process.execPath, "verify.ts"], {
      cwd: join(checkout.dir, ".nod"),
      env: {
        PATH: process.env.PATH,
        HOME: keys.dir,
        GITHUB_REPOSITORY: REPO,
        GITHUB_TOKEN: "test-token",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_API_URL: gh.url,
        GITHUB_SERVER_URL: gh.url,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const check = gh.checks.length > before ? gh.checks[gh.checks.length - 1]! : null;
    const output = check?.output as { title: string; summary: string; text: string } | undefined;
    return { code, out, err, check, output, summary: decodeSummary(output?.text) };
  }

  async function nod(reviewer: string, privateKey: string, prs: number[]): Promise<string> {
    const entries = [];
    for (const n of prs) {
      const range = { repoDir: work.dir, baseTip: "main", head: heads[n]! };
      entries.push({ pr: n, base: "main", head_sha: heads[n]!, patch_id: await patchId(range) });
    }
    const payload: NodPayload = {
      v: 1,
      repo: REPO,
      entries,
      verdict: "approve",
      level: "review",
      reviewer,
      signed_at: "2026-11-18T20:00:00.000Z",
    };
    const line = serializePayload(payload);
    return renderNodComment(line, await sshSign(privateKey, line), nodHumanLine(payload));
  }

  function comment(n: number, body: string) {
    const list = gh.comments.get(n) ?? [];
    list.push({
      id: list.length + 1,
      body,
      user: { login: "alice", type: "User" },
      created_at: "2026-11-18T20:00:00Z",
      updated_at: "2026-11-18T20:00:00Z",
    });
    gh.comments.set(n, list);
  }

  test("a core change waits for a peer: red check, sticky comment, labels", async () => {
    const r = await verify({ pull_request: { number: 2, head: { sha: heads[2] } } });
    expect(r.code).toBe(0);
    expect(r.check).toMatchObject({ name: "nod", head_sha: heads[2], conclusion: "failure" });
    expect(r.output!.title).toBe("waiting for a peer nod");
    expect(r.summary).toMatchObject({ pr: 2, category: "decide", risk: 3, satisfied: false });
    expect(r.summary!.signers).toEqual(["alice", "bob"]);
    const sticky = gh.comments.get(2)!.find((c) => c.body.startsWith(STICKY_MARKER))!;
    expect(sticky.body).toContain("https://ui.nod.frebreco.de/#/pr/acme/widgets/2");
    expect(gh.labels.get(2)!.sort()).toEqual(["nod:decide", "nod:risk-3"]);
    expect(gh.createdLabels).toContain("nod:decide");
  });

  test("alice's self nod is not enough; bob's peer nod turns it green, the sticky is updated in place", async () => {
    comment(2, await nod("alice", alice.privateKey, [2]));
    const self = await verify({ issue: { number: 2, pull_request: {} } });
    expect(self.output!.title).toBe("waiting for a peer nod (have: alice (self))");

    comment(2, await nod("bob", bob.privateKey, [2]));
    const peer = await verify({ issue: { number: 2, pull_request: {} } });
    expect(peer.check).toMatchObject({ conclusion: "success" });
    expect(peer.output!.title).toBe("nodded by alice (self), bob (peer)");
    expect(gh.comments.get(2)!.filter((c) => c.body.startsWith(STICKY_MARKER))).toHaveLength(1);
  });

  test("a forged nod (bob's key claiming alice) does not count", async () => {
    gh.comments.set(1, []);
    gh.prs.set(4, { ...gh.prs.get(2)!, number: 4 });
    heads[4] = heads[2]!;
    comment(4, (await nod("alice", bob.privateKey, [4])).replace(/\n/g, "\r\n"));
    const r = await verify({ issue: { number: 4, pull_request: {} } });
    expect(r.check).toMatchObject({ conclusion: "failure" });
    expect(r.summary!.nods[0]).toMatchObject({ reviewer: "alice", counts: false });
  });

  test("a pure tier-3 module update needs no nod", async () => {
    const r = await verify({ pull_request: { number: 1, head: { sha: heads[1] } } });
    expect(r.check).toMatchObject({ conclusion: "success" });
    expect(r.output!.title).toBe("no nod needed");
    expect(r.summary).toMatchObject({ category: "auto", requirement: { level: "none" } });
    expect(gh.labels.get(1)!.sort()).toEqual(["nod:auto", "nod:risk-0"]);
  });

  test("a crash ends as a red check with the error, never green", async () => {
    const r = await verify({ pull_request: { number: 3, head: { sha: "f".repeat(40) } } });
    expect(r.code).toBe(1);
    expect(r.check).toMatchObject({ conclusion: "failure", head_sha: "f".repeat(40) });
    expect(r.output!.title).toStartWith("verifier error: git fetch failed");
    expect(r.summary).toMatchObject({ pr: 3, satisfied: false });
    expect(r.summary!.errors[0]).toMatchObject({ source: "verifier" });
  });

  test("closed PRs and plain issues are left alone", async () => {
    gh.prs.set(5, { ...gh.prs.get(1)!, number: 5, state: "closed" });
    expect(await verify({ issue: { number: 5, pull_request: {} } })).toMatchObject({
      code: 0,
      check: null,
    });
    expect(await verify({ issue: { number: 6 } })).toMatchObject({ code: 0, check: null });
  });
});
