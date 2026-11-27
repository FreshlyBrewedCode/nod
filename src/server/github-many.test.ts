/**
 * The GitHub source with many repos on two hosts (ADR 0007): github.com and
 * `acme.ghe.com`, each a `FakeGitHub` with its own token. Temp config and
 * cache folders; never `~/.config/nod` or `~/.cache/nod`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { githubHost, type GitHubHost } from "../kit/host.ts";
import { tempDir, tempRepo } from "../kit/test-support.ts";
import type { Reply, ServerToClient } from "../shared/protocol";
import { ManualClock } from "./clock";
import { addConfigRepo, type ConfigRepo } from "./config";
import { ownClonePath } from "./github/clone";
import { FakeGitHub } from "./github/fake-github";
import { ALICE, BOB, REPO, T0, rawPr, sha, summaryFor, summaryText } from "./github/test-support";
import { githubSource } from "./github-source";
import { Session } from "./session";
import { FAKE_KEY, FakeSigner } from "./signer";
import type { SourceChange } from "./source";

const SECOND = 1000;
const LEDGER = "acme.ghe.com/finance/ledger";
const settle = async () => {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const WIDGETS: ConfigRepo = { host: "github.com", repo: REPO };
const LEDGER_REPO: ConfigRepo = { host: "acme.ghe.com", repo: "finance/ledger" };
const FIELDBOOK: ConfigRepo = { host: "github.com", repo: "tallyho/fieldbook" };

/** Two hosts with a repo or two each; the list in a temp config file. */
async function many(
  o: {
    list?: ConfigRepo[];
    tokens?: Partial<Record<string, string | null>>;
    cwd?: string;
    cloneUrl?: (host: GitHubHost, name: string) => string;
    noPatchIds?: boolean;
  } = {},
) {
  const tmp = await tempDir();
  cleanups.push(tmp.cleanup);
  const configFile = join(tmp.dir, "config", "nod", "config.json");
  const cacheDir = join(tmp.dir, "cache", "nod");
  for (const r of o.list ?? [WIDGETS, LEDGER_REPO, FIELDBOOK]) addConfigRepo(configFile, r);

  const com = new FakeGitHub();
  com.token = "t0ken-com";
  // acme/widgets: set up, three PRs with the verifier's summary.
  const pr26 = rawPr({ number: 26, author: BOB, nodRun: { id: 5026 } });
  com.open.push(pr26);
  com.texts.set(
    5026,
    summaryText(
      summaryFor(pr26, {
        risk: 3,
        requirement: { level: "peer", named: [] },
        missing: [{ kind: "peer" }],
        satisfied: false,
      }),
    ),
  );
  // tallyho/fieldbook: nothing of nod (the inbox step), one PR.
  const fieldbook = com.repo("tallyho/fieldbook");
  fieldbook.files = { policy: false, verifier: false, workflow: false };
  fieldbook.signers = null;
  fieldbook.open.push(rawPr({ number: 482, author: BOB }));

  const ghe = new FakeGitHub(githubHost("acme.ghe.com"), "alice_acme");
  ghe.token = "t0ken-ghe";
  const ledger = ghe.repo("finance/ledger");
  ledger.files = { policy: false, verifier: false, workflow: false };
  ledger.signers = null;
  ledger.open.push(rawPr({ number: 7, author: "bob_acme", requested: ["alice_acme"] }));
  ledger.requested = [7];

  const fakes: Record<string, FakeGitHub> = { "github.com": com, "acme.ghe.com": ghe };
  const tokens: Record<string, string | null> = {
    "github.com": "t0ken-com",
    "acme.ghe.com": "t0ken-ghe",
    ...o.tokens,
  };
  const clock = new ManualClock(T0);
  const lines: string[] = [];
  const source = githubSource({
    clock,
    repo: null,
    cwd: o.cwd ?? tmp.dir,
    configFile,
    cacheDir,
    token: (h) => tokens[h] ?? null,
    fetch: (h) => fakes[h.name]!.fetch,
    ...(!o.noPatchIds && { patchIds: { compute: async (i) => sha(`pid-${i.headSha}`) } }),
    ...(o.cloneUrl && { cloneUrl: o.cloneUrl }),
    myKey: () => FAKE_KEY.publicKey,
    log: (l) => lines.push(l),
  });
  cleanups.push(async () => source.stop());
  const changes: SourceChange[] = [];
  source.subscribe((c) => changes.push(c));
  await source.ready;
  await settle();
  const advance = async (ms: number) => {
    clock.advance(ms);
    await settle();
  };
  const config = () => JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  return { com, ghe, source, clock, lines, changes, advance, configFile, cacheDir, config, tmp };
}

const rows = (s: { snapshot(): ReturnType<ReturnType<typeof githubSource>["snapshot"]> }) =>
  s.snapshot()!.prs.map((p) => `${p.repo}#${p.number}`);

describe("reading", () => {
  test("three repos on two hosts: one Poll per host, a block per repo, each token to its own host", async () => {
    const t = await many();
    expect(t.source.repos().map((r) => r.key)).toEqual([REPO, LEDGER, "tallyho/fieldbook"]);
    expect(t.source.repos()[1]!.github).toEqual({
      host: "acme.ghe.com",
      webUrl: "https://acme.ghe.com",
    });
    // One query per host, every repo of the host in it.
    expect(t.com.queries("Poll")).toHaveLength(1);
    expect(t.com.queries("Poll")[0]!.body).toEqual({
      o0: "acme",
      n0: "widgets",
      q0: `repo:${REPO} is:pr is:open review-requested:@me`,
      o1: "tallyho",
      n1: "fieldbook",
      q1: "repo:tallyho/fieldbook is:pr is:open review-requested:@me",
    });
    expect(t.ghe.queries("Poll")).toHaveLength(1);
    expect(t.ghe.queries("Poll")[0]!.body).toMatchObject({ o0: "finance", n0: "ledger" });
    // The details of a host: one query too.
    expect(t.com.queries("Details")).toHaveLength(1);
    expect(rows(t.source)).toEqual([`${REPO}#26`, `${LEDGER}#7`, "tallyho/fieldbook#482"]);
    const snap = t.source.snapshot()!;
    // `me` is the first repo's host's login; each row is relative to its own host's.
    expect(snap.me).toBe(ALICE);
    const ledgerRow = snap.prs.find((p) => p.repo === LEDGER)!;
    expect(ledgerRow).toMatchObject({ needsMe: true, classifiedBy: "local" });
    expect(ledgerRow.ask?.kind).toBe("approve");
    expect(snap.sync).toEqual({ at: T0, error: null });
    // Wrong tokens would have been refused (401); no URL of the other host was called.
    expect(t.com.misdirected).toEqual([]);
    expect(t.ghe.misdirected).toEqual([]);
    expect(t.lines.join("\n")).not.toContain("failed");
  });

  test("more repos than one query holds: one more Poll per ten, still one Details", async () => {
    const list = Array.from({ length: 12 }, (_, i) => ({
      host: "github.com",
      repo: `tallyho/r${i}`,
    }));
    const t = await many({ list });
    expect(t.com.queries("Poll")).toHaveLength(2);
    expect(Object.keys(t.com.queries("Poll")[1]!.body as object)).toEqual([
      "o0",
      "n0",
      "q0",
      "o1",
      "n1",
      "q1",
    ]);
    expect(t.ghe.calls).toEqual([]);
  });

  test("my login is the repo's host's", async () => {
    const t = await many();
    const login = (key: string) => t.source.repos().find((r) => r.key === key)?.login;
    expect(login(REPO)).toBe(ALICE);
    expect(login(LEDGER)).toBe("alice_acme");
    expect(t.source.repoList).toBe("managed");
  });

  test("a repo GitHub cannot read fails alone, naming itself; the others show", async () => {
    const gone = { host: "github.com", repo: "tallyho/gone" };
    const t = await many({ list: [WIDGETS, gone, LEDGER_REPO] });
    expect(rows(t.source)).toEqual([`${REPO}#26`, `${LEDGER}#7`]);
    expect(t.source.snapshot()!.sync.error).toBe(
      "tallyho/gone was not found on github.com, or this gh account cannot read it.",
    );
    expect(t.source.repos().map((r) => r.key)).toContain("tallyho/gone");
    // Still one query for the host, and the next poll tries it again.
    await t.advance(60 * SECOND);
    expect(t.com.queries("Poll")).toHaveLength(2);
  });

  test("a host without a gh login: its repos say so, the other host reads", async () => {
    const t = await many({ tokens: { "acme.ghe.com": null } });
    expect(rows(t.source)).toEqual([`${REPO}#26`, "tallyho/fieldbook#482"]);
    expect(t.source.snapshot()!.sync.error).toContain(
      "`gh` is not logged in to acme.ghe.com. Run `gh auth login --hostname acme.ghe.com`",
    );
    expect(t.ghe.calls).toEqual([]);
    expect(t.lines.join("\n")).toContain("not logged in to acme.ghe.com");
    expect((await t.source.setup(LEDGER)).checks.every((c) => c.state === "unknown")).toBe(true);
  });

  test("rate limits are per host: a limited host waits, the other polls on", async () => {
    const t = await many();
    t.ghe.failNext.push({
      status: 403,
      body: { message: "You have exceeded a secondary rate limit." },
      headers: { "retry-after": "600" },
    });
    await t.advance(60 * SECOND);
    expect(t.source.snapshot()!.sync.rateLimit).toEqual({ until: T0 + 60 * SECOND + 600 * SECOND });
    expect(t.source.snapshot()!.sync.error).toBeNull();
    for (let i = 0; i < 5; i++) await t.advance(60 * SECOND);
    expect(t.com.queries("Poll").length).toBeGreaterThanOrEqual(6);
    expect(t.ghe.queries("Poll")).toHaveLength(2);
    // The rows of the limited host stay as they were.
    expect(rows(t.source)).toContain(`${LEDGER}#7`);
  });

  test("NOD_DEBUG: a line per host and poll, with the GraphQL cost", async () => {
    const was = process.env.NOD_DEBUG;
    process.env.NOD_DEBUG = "1";
    try {
      const t = await many();
      const debug = t.lines.filter((l) => l.includes(": poll ")).sort();
      expect(debug).toEqual([
        expect.stringMatching(
          /^nod serve: poll acme\.ghe\.com: 1 GraphQL \(cost 2, 4900 left\), \d+ REST, \d+ ms, 1 repo, 1 open$/,
        ),
        expect.stringMatching(
          /^nod serve: poll github\.com: 2 GraphQL \(cost 4, 4900 left\), \d+ REST, \d+ ms, 2 repos, 2 open$/,
        ),
      ]);
    } finally {
      if (was === undefined) delete process.env.NOD_DEBUG;
      else process.env.NOD_DEBUG = was;
    }
  });

  test("a batch across hosts: each approval goes to its own host", async () => {
    const t = await many();
    const s = new Session({
      source: t.source,
      signer: new FakeSigner(t.clock),
      clock: t.clock,
      version: null,
      fake: false,
    });
    const messages: ServerToClient[] = [];
    const client = {
      side: "loopback" as const,
      send: (d: string) => void messages.push(JSON.parse(d) as ServerToClient),
    };
    await s.handle(
      client,
      JSON.stringify({
        t: "approve",
        id: "a",
        entries: [
          { repo: REPO, pr: 26, head_sha: sha("head-26") },
          { repo: LEDGER, pr: 7, head_sha: sha("head-7") },
        ],
      }),
    );
    const reply = messages.find((m) => m.t === "reply" && m.id === "a") as Extract<
      Reply,
      { ok: true; to: "approve" }
    >;
    expect(reply.ok).toBe(true);
    expect(reply.result.posted.map((p) => p.url.split("#")[0])).toEqual([
      "https://github.com/acme/widgets/pull/26",
      "https://acme.ghe.com/finance/ledger/pull/7",
    ]);
    expect(t.com.rests().some((c) => c.path === "/repos/acme/widgets/pulls/26/reviews")).toBe(true);
    expect(t.ghe.rests().some((c) => c.path === "/repos/finance/ledger/pulls/7/reviews")).toBe(
      true,
    );
    expect(t.com.misdirected).toEqual([]);
    expect(t.ghe.misdirected).toEqual([]);
    s.stop();
  });

  test("the session goes by my login on each repo's host", async () => {
    const t = await many();
    t.ghe.repo("finance/ledger").open.push(rawPr({ number: 8, author: "alice_acme" }));
    await t.source.refresh();
    await settle();
    const s = new Session({
      source: t.source,
      signer: new FakeSigner(t.clock),
      clock: t.clock,
      version: null,
      fake: false,
    });
    const messages: ServerToClient[] = [];
    const client = {
      side: "loopback" as const,
      send: (d: string) => void messages.push(JSON.parse(d) as ServerToClient),
    };
    await s.attach(client);
    const welcome = messages[0] as Extract<ServerToClient, { t: "welcome" }>;
    expect(welcome.repoList).toBe("managed");
    expect(welcome.repos.map((r) => [r.key, r.login])).toEqual([
      [REPO, ALICE],
      [LEDGER, "alice_acme"],
      ["tallyho/fieldbook", ALICE],
    ]);
    expect(t.source.snapshot()!.prs.find((p) => p.repo === LEDGER && p.number === 8)?.mine).toBe(
      true,
    );
    // alice_acme's own PR: GitHub would refuse the approval, so nothing is posted.
    await s.handle(
      client,
      JSON.stringify({
        t: "approve",
        id: "own",
        entries: [{ repo: LEDGER, pr: 8, head_sha: sha("head-8") }],
      }),
    );
    expect(messages.find((m) => m.t === "reply" && m.id === "own")).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(t.ghe.rests().some((c) => c.path.endsWith("/pulls/8/reviews"))).toBe(false);
    s.stop();
  });
});

describe("the list", () => {
  test("adding by URL: checked on its host, written next to the keys it does not know, polled", async () => {
    const t = await many({ list: [WIDGETS] });
    // Another part of nod keeps its update channel in the same file.
    writeFileSync(t.configFile, JSON.stringify({ ...t.config(), channel: "next" }));
    expect(rows(t.source)).toEqual([`${REPO}#26`]);
    const added = await t.source.addRepo("https://acme.ghe.com/Finance/ledger/pull/7");
    expect(added).toEqual({
      key: LEDGER,
      name: "finance/ledger",
      github: { host: "acme.ghe.com", webUrl: "https://acme.ghe.com" },
      // Not read yet: the host's first poll brings it.
      login: null,
    });
    expect(t.config()).toEqual({
      nod: "config",
      version: 1,
      channel: "next",
      repos: [
        { host: "github.com", repo: REPO },
        { host: "acme.ghe.com", repo: "finance/ledger" },
      ],
    });
    // The list first, so a tab knows the repo before its PRs arrive.
    expect(t.changes.slice(-3)).toEqual(["repos", "setup", "enrolment"]);
    await settle();
    expect(t.ghe.rests().map((c) => `${c.method} ${c.path}`)).toContain(
      "GET /repos/Finance/ledger",
    );
    expect(t.ghe.queries("Poll")).toHaveLength(1);
    expect(rows(t.source)).toEqual([`${REPO}#26`, `${LEDGER}#7`]);
    // Once only: the same repo again is no change.
    const before = readFileSync(t.configFile, "utf8");
    expect((await t.source.addRepo("acme.ghe.com/finance/LEDGER")).key).toBe(LEDGER);
    expect(readFileSync(t.configFile, "utf8")).toBe(before);
  });

  test("adding what GitHub does not know, or on a host without a login, fails and writes nothing", async () => {
    const t = await many({ list: [WIDGETS], tokens: { "acme.ghe.com": null } });
    const before = readFileSync(t.configFile, "utf8");
    await expect(t.source.addRepo("tallyho/nothing")).rejects.toMatchObject({
      code: "not-found",
      message: "tallyho/nothing was not found on github.com, or this gh account cannot read it.",
    });
    await expect(t.source.addRepo("acme.ghe.com/finance/ledger")).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("gh auth login --hostname acme.ghe.com"),
    });
    await expect(t.source.addRepo("not a repo")).rejects.toMatchObject({ code: "bad-request" });
    expect(readFileSync(t.configFile, "utf8")).toBe(before);
    expect(t.source.repos()).toHaveLength(1);
  });

  test("removing: off the list and the dashboard; its clone stays in the cache", async () => {
    const t = await many({ list: [WIDGETS, LEDGER_REPO] });
    const clone = ownClonePath(t.cacheDir, "acme.ghe.com", "finance/ledger");
    mkdirSync(clone, { recursive: true });
    await t.source.removeRepo(LEDGER);
    expect(t.config().repos).toEqual([{ host: "github.com", repo: REPO }]);
    expect(t.source.repos().map((r) => r.key)).toEqual([REPO]);
    expect(rows(t.source)).toEqual([`${REPO}#26`]);
    expect(existsSync(clone)).toBe(true);
    await expect(t.source.removeRepo(LEDGER)).rejects.toMatchObject({ code: "not-found" });
    // The host has no repo left: it is not polled any more.
    for (let i = 0; i < 5; i++) await t.advance(60 * SECOND);
    expect(t.ghe.queries("Poll")).toHaveLength(1);
  });

  test("a change to the file (nod repo add in another terminal) is read before the next poll", async () => {
    const t = await many({ list: [WIDGETS] });
    addConfigRepo(t.configFile, FIELDBOOK);
    // A different mtime even on coarse file systems.
    const { utimesSync } = await import("node:fs");
    utimesSync(t.configFile, new Date(T0 + 1000), new Date(T0 + 1000));
    await t.advance(60 * SECOND);
    expect(t.source.repos().map((r) => r.key)).toEqual([REPO, "tallyho/fieldbook"]);
    expect(t.changes).toContain("repos");
    // The host polls a moment after the change.
    await t.advance(5 * SECOND);
    expect(rows(t.source)).toContain("tallyho/fieldbook#482");
    expect(t.lines.join("\n")).toContain("the repo list changed: acme/widgets, tallyho/fieldbook");
  });

  test("suggestions: on every host I am logged in to, the listed left out, most relevant first", async () => {
    const t = await many({ list: [WIDGETS, LEDGER_REPO] });
    t.com.mine = [REPO, "tallyho/fieldbook", "tallyho/fieldbook"];
    t.com.asked = ["tallyho/atlas"];
    t.ghe.mine = ["finance/ledger"];
    t.ghe.asked = ["finance/payroll"];
    expect(await t.source.suggestRepos()).toEqual([
      {
        key: "acme.ghe.com/finance/payroll",
        name: "finance/payroll",
        github: { host: "acme.ghe.com", webUrl: "https://acme.ghe.com" },
        myOpenPrs: 0,
        reviewRequests: 1,
      },
      {
        key: "tallyho/atlas",
        name: "tallyho/atlas",
        github: { host: "github.com", webUrl: "https://github.com" },
        myOpenPrs: 0,
        reviewRequests: 1,
      },
      expect.objectContaining({ key: "tallyho/fieldbook", myOpenPrs: 2, reviewRequests: 0 }),
    ]);
    // One search query per host.
    expect(t.com.queries("Suggest")).toHaveLength(1);
    expect(t.ghe.queries("Suggest")).toHaveLength(1);
  });

  test("no list and no clone: no repo, the suggestions, and adding one", async () => {
    const t = await many({ list: [] });
    expect(t.source.repos()).toEqual([]);
    expect(t.source.repoList).toBe("managed");
    expect(t.source.snapshot()).toBeNull();
    t.com.mine = ["tallyho/fieldbook"];
    expect(await t.source.suggestRepos()).toEqual([
      {
        key: "tallyho/fieldbook",
        name: "tallyho/fieldbook",
        github: { host: "github.com", webUrl: "https://github.com" },
        myOpenPrs: 1,
        reviewRequests: 0,
      },
    ]);
    // github.com only: no other host is known yet.
    expect(t.ghe.calls).toEqual([]);
    // Nothing polls with no repo, and still a `nod repo add` elsewhere is seen within a minute.
    addConfigRepo(t.configFile, WIDGETS);
    await t.advance(60 * SECOND);
    expect(t.source.repos().map((r) => r.key)).toEqual([REPO]);
    await t.source.removeRepo(REPO);
    await t.source.addRepo("tallyho/fieldbook");
    expect(t.config().repos).toEqual([{ host: "github.com", repo: "tallyho/fieldbook" }]);
    await settle();
    expect(rows(t.source)).toEqual(["tallyho/fieldbook#482"]);
    expect(await t.source.account()).toMatchObject({ login: ALICE });
  });
});

describe("the clone override", () => {
  async function clone() {
    const r = await tempRepo();
    cleanups.push(r.cleanup);
    await r.git("remote", "add", "origin", `https://github.com/${REPO}.git`);
    return r.dir;
  }

  test("an empty list in a clone serves that clone, and never writes the list", async () => {
    const dir = await clone();
    const t = await many({ list: [], cwd: dir });
    expect(t.source.cloneMode).toBe(true);
    expect(t.source.repos().map((r) => r.key)).toEqual([REPO]);
    expect(rows(t.source)).toEqual([`${REPO}#26`]);
    await expect(t.source.addRepo("tallyho/fieldbook")).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("nod repo add"),
    });
    await expect(t.source.removeRepo(REPO)).rejects.toMatchObject({ code: "forbidden" });
    expect(await t.source.suggestRepos()).toEqual([]);
    expect(existsSync(t.configFile)).toBe(false);
  });

  test("a list wins over the clone nod serve starts in", async () => {
    const dir = await clone();
    const t = await many({ list: [LEDGER_REPO], cwd: dir });
    expect(t.source.cloneMode).toBe(false);
    expect(t.source.repos().map((r) => r.key)).toEqual([LEDGER]);
  });
});

test("nod's own clone: the first patch-id clones it under the cache, by host", async () => {
  const remote = await tempRepo();
  cleanups.push(remote.cleanup);
  await remote.git("config", "uploadpack.allowFilter", "true");
  await remote.git("config", "uploadpack.allowAnySHA1InWant", "true");
  await remote.write("ledger.ts", "export const a = 1;\n");
  await remote.commit("base");
  await remote.git("switch", "-q", "-c", "agent/change");
  await remote.write("ledger.ts", "export const a = 2;\n");
  const head = await remote.commit("change");
  await remote.git("switch", "-q", "main");

  const urls: string[] = [];
  const t = await many({
    list: [LEDGER_REPO],
    noPatchIds: true,
    cloneUrl: (host, name) => {
      urls.push(`${host.name} ${name}`);
      return `file://${remote.dir}`;
    },
  });
  const ledger = t.ghe.repo("finance/ledger");
  ledger.open = [rawPr({ number: 7, author: "bob_acme", head })];
  const target = await t.source.signTarget(LEDGER, 7);
  expect(target?.patchId).toMatch(/^[0-9a-f]{40}$/);
  expect(urls).toEqual(["acme.ghe.com finance/ledger"]);
  const dir = ownClonePath(t.cacheDir, "acme.ghe.com", "finance/ledger");
  expect(dir).toBe(join(t.cacheDir, "clones", "acme.ghe.com", "finance", "ledger.git"));
  expect(existsSync(join(dir, "HEAD"))).toBe(true);
});
