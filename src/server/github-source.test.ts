import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test } from "bun:test";

import { githubHost, type GitHubHost } from "../kit/host.ts";
import { tempRepo } from "../kit/test-support.ts";
import type { Ask, Reply, ServerToClient } from "../shared/protocol";
import { ManualClock } from "./clock";
import { GitHubApi } from "./github/api";
import type { PatchIds } from "./github/clone";
import { FakeGitHub } from "./github/fake-github";
import type { RawPr } from "./github/queries";
import {
  ALICE,
  BOB,
  CAROL,
  REPO,
  T0,
  iso,
  nodEval,
  rawPr,
  sha,
  summaryFor,
  summaryText,
} from "./github/test-support";
import { GitHubSource, githubSource } from "./github-source";
import { Session } from "./session";
import { FAKE_KEY, FakeSigner } from "./signer";
import { ed25519PublicKeyBlob, publicKeyLine } from "./signer/ssh-wire";
import type { SourceChange } from "./source";

const SECOND = 1000;
const APPROVE: Ask = { kind: "approve", label: "Approve", then: { outcome: "satisfied" } };

/** Let the fake fetch's promises and the patch-id jobs run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
};

/** Three open PRs, each with the verifier's summary on its head. */
function team(gh: FakeGitHub) {
  const add = (raw: RawPr, s: Parameters<typeof summaryFor>[1]) => {
    gh.open.push(raw);
    const run = raw.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.find(
      (c) => c?.__typename === "CheckRun" && c.name === "nod",
    ) as { databaseId: number };
    gh.texts.set(run.databaseId, summaryText(summaryFor(raw, s)));
    return raw;
  };
  add(rawPr({ number: 26, author: BOB, nodRun: { id: 5026 } }), {
    risk: 3,
    requirement: { level: "peer", named: [] },
    missing: [{ kind: "peer" }],
    satisfied: false,
  });
  add(rawPr({ number: 27, nodRun: { id: 5027 } }), {
    risk: 1,
    requirement: { level: "self", named: [] },
    missing: [{ kind: "self", login: ALICE }],
    satisfied: false,
  });
  add(rawPr({ number: 28, author: BOB, body: "FYI: on-call page", nodRun: { id: 5028 } }), {
    category: "fyi",
    fyi: true,
    reasons: [{ classifier: "declared", tag: "fyi", detail: "the brief marks this as FYI" }],
  });
}

/** The key of a one-repo source's repo. */
const keyOf = (source: GitHubSource) => source.repos()[0]!.key;

/** One repo, `acme/widgets`, as the clone override serves it. */
function oneRepo(o: {
  clock: ManualClock;
  api: GitHubApi | null;
  host?: GitHubHost;
  patchIds: PatchIds | null;
  myKey?: () => string | null;
  identity?: { name: string; email: string };
  openSetupPr?: (input: { login: string; publicKey: string | null }) => Promise<string>;
}) {
  return new GitHubSource({
    clock: o.clock,
    repos: [{ host: o.host ?? githubHost("github.com"), name: REPO }],
    api: () => o.api,
    configFile: null,
    clone: { dir: "/tmp/acme-widgets" },
    repoOptions: () => ({
      patchIds: o.patchIds,
      identity: () => o.identity ?? null,
      ...(o.openSetupPr && { openSetupPr: o.openSetupPr }),
    }),
    ...(o.myKey && { myKey: o.myKey }),
    log: () => {},
  });
}

function setup(options: { myKey?: string | null; patchIds?: PatchIds; withTeam?: boolean } = {}) {
  const gh = new FakeGitHub();
  if (options.withTeam !== false) team(gh);
  const clock = new ManualClock(T0);
  const api = new GitHubApi({ token: "t0ken", fetch: gh.fetch, now: () => clock.now() });
  const computed: Array<{ base: string; headSha: string }> = [];
  const patchIds: PatchIds = options.patchIds ?? {
    compute: async (input) => {
      computed.push(input);
      return sha(`pid-${input.headSha}`);
    },
  };
  let key: string | null = options.myKey === undefined ? FAKE_KEY.publicKey : options.myKey;
  const source = oneRepo({ clock, api, patchIds, myKey: () => key });
  const changes: SourceChange[] = [];
  source.subscribe((c) => changes.push(c));
  const advance = async (ms: number) => {
    clock.advance(ms);
    await settle();
  };
  return {
    gh,
    clock,
    api,
    source,
    changes,
    computed,
    advance,
    setKey: (k: string | null) => (key = k),
    pr: (n: number) => source.snapshot()!.prs.find((p) => p.number === n)!,
  };
}

describe("polling", () => {
  test("the first poll reads the PRs, their summaries and patch-ids", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const snap = t.source.snapshot()!;
    expect(snap).toMatchObject({ me: ALICE, sync: { at: T0, error: null } });
    expect(t.source.repos()).toEqual([
      {
        key: REPO,
        name: REPO,
        github: { host: "github.com", webUrl: "https://github.com" },
        login: ALICE,
      },
    ]);
    expect(snap.prs.every((p) => p.repo === REPO)).toBe(true);
    expect(snap.prs.map((p) => [p.number, p.category, p.needsMe, p.ask?.kind ?? null])).toEqual([
      [26, "decide", true, "peer"],
      [27, "decide", true, "self"],
      [28, "fyi", false, null],
    ]);
    // bob's FYI: alice (the only other enrolled signer here) has not acked it
    expect(t.pr(28).fyi?.pending).toEqual([ALICE]);
    expect(t.pr(28).fyiForMe).toBe(true);
    expect(t.pr(27).patchId).toBe(sha(`pid-${sha("head-27")}`));
    // one Poll, one Details for the three check run texts
    expect(t.gh.queries().map((q) => q.query)).toEqual(["Poll", "Details"]);
    expect(t.computed.map((c) => c.base)).toEqual(["main", "main", "main"]);
  });

  test("a snapshot is pushed only when something changed; texts are read once per check run", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const pushes = () => t.changes.filter((c) => c === "prs").length;
    const first = pushes();
    expect(first).toBeGreaterThan(0);
    await t.advance(60 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(2);
    expect(t.gh.queries("Details")).toHaveLength(1);
    expect(pushes()).toBe(first);

    // a new check result on #27: pushed
    const raw = t.gh.open[1]!;
    t.gh.open[1] = rawPr({
      number: 27,
      nodRun: { id: 5027 },
      checks: [{ name: "test", conclusion: "FAILURE" }],
    });
    void raw;
    await t.advance(60 * SECOND);
    expect(pushes()).toBe(first + 1);
    expect(t.pr(27).checks.state).toBe("failing");
  });

  test("errors back off: 30 s, 60 s, 120 s; the snapshot keeps the last good read", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const polls = () => t.gh.queries("Poll").length;
    for (let i = 0; i < 3; i++)
      t.gh.failNext.push({ status: 502, body: { message: "Bad gateway" } });
    await t.advance(60 * SECOND);
    expect(polls()).toBe(2);
    expect(t.source.snapshot()!.sync).toEqual({ at: T0, error: expect.stringContaining("502") });
    expect(t.source.snapshot()!.prs).toHaveLength(3);
    await t.advance(29 * SECOND);
    expect(polls()).toBe(2);
    await t.advance(1 * SECOND);
    expect(polls()).toBe(3);
    await t.advance(59 * SECOND);
    expect(polls()).toBe(3);
    await t.advance(1 * SECOND);
    expect(polls()).toBe(4);
    await t.advance(120 * SECOND);
    expect(polls()).toBe(5);
    expect(t.source.snapshot()!.sync.error).toBeNull();
  });

  test("a secondary rate limit waits as long as GitHub says, calmly", async () => {
    const t = setup();
    t.source.start();
    await settle();
    t.gh.failNext.push({
      status: 403,
      body: { message: "You have exceeded a secondary rate limit." },
      headers: { "retry-after": "120" },
    });
    await t.advance(60 * SECOND);
    const sync = t.source.snapshot()!.sync;
    expect(sync.error).toBeNull();
    expect(sync.rateLimit).toEqual({ until: T0 + 180 * SECOND });
    // poking does not hurry it
    t.source.poke();
    await t.advance(119 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(2);
    await t.advance(1 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(3);
    expect(t.source.snapshot()!.sync.rateLimit).toBeUndefined();
  });

  test("a low GraphQL budget pauses until it resets", async () => {
    const t = setup();
    t.gh.rateLimit = {
      cost: 2,
      remaining: 12,
      limit: 5000,
      resetAt: new Date(T0 + 30 * 60 * SECOND).toISOString(),
    };
    t.source.start();
    await settle();
    expect(t.source.snapshot()!.sync.rateLimit).toEqual({ until: T0 + 30 * 60 * SECOND });
    await t.advance(29 * 60 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(1);
    await t.advance(60 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(2);
  });

  test("after the user acts it polls every 5 s for two minutes, then every 60 s again", async () => {
    const t = setup();
    t.source.start();
    await settle();
    t.source.poke();
    await t.advance(2 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(2);
    await t.advance(5 * SECOND);
    expect(t.gh.queries("Poll")).toHaveLength(3);
    // a poll is scheduled when the previous one ended: step through it
    for (let s = 0; s < 120; s += 5) await t.advance(5 * SECOND);
    const fast = t.gh.queries("Poll").length;
    expect(fast).toBeGreaterThanOrEqual(25);
    for (let s = 0; s < 55; s += 5) await t.advance(5 * SECOND);
    expect(t.gh.queries("Poll").length).toBeLessThanOrEqual(fast + 1);
    await t.advance(5 * SECOND);
    expect(t.gh.queries("Poll").length).toBe(fast + 1);
  });

  test("merged and closed PRs of the last 14 days are fetched once, then kept", async () => {
    const t = setup();
    const merged = rawPr({ number: 21, state: "MERGED", merged: 60 });
    const old = rawPr({ number: 3, state: "MERGED", merged: 15 * 24 * 60 });
    t.gh.closed.push(
      { number: 21, updatedAt: iso(60), closedAt: iso(60), raw: merged },
      { number: 3, updatedAt: iso(15 * 24 * 60), closedAt: iso(15 * 24 * 60), raw: old },
    );
    t.source.start();
    await settle();
    expect(t.source.snapshot()!.prs.map((p) => p.number)).toEqual([26, 27, 28, 21]);
    expect(t.pr(21).state).toBe("merged");
    await t.advance(60 * SECOND);
    expect(t.gh.queries("Details")).toHaveLength(1);
  });

  test("a PR without a summary is a high-risk row waiting on the verifier, and listed as unclassified", async () => {
    const t = setup();
    t.gh.open.push(rawPr({ number: 36, author: BOB }));
    t.source.start();
    await settle();
    expect(t.pr(36)).toMatchObject({
      risk: 3,
      tags: ["not classified"],
      needsMe: false,
      ask: null,
      requirement: { satisfied: false, slots: [] },
      waitingOn: [{ kind: "checks" }],
    });
    expect(t.source.snapshot()!.unclassified).toEqual([
      {
        repo: REPO,
        number: 36,
        title: "change 36",
        url: `https://github.com/${REPO}/pull/36`,
        reason: "pending",
      },
    ]);
  });
});

describe("merged PRs without a summary", () => {
  test("are quiet history: no error tag, not listed as unclassified", async () => {
    const t = setup();
    const merged = rawPr({ number: 21, state: "MERGED", merged: 60 });
    t.gh.closed.push({ number: 21, updatedAt: iso(60), closedAt: iso(60), raw: merged });
    t.source.start();
    await settle();
    expect(t.pr(21)).toMatchObject({
      state: "merged",
      risk: 0,
      tags: [],
      needsMe: false,
      waitingOn: [{ kind: "nothing" }],
    });
    expect(t.source.snapshot()!.unclassified).toEqual([]);
  });
});

describe("the inbox step: a repo without nod's setup", () => {
  /** No `.nod/`, no workflow, no signers: three PRs, none with a summary. */
  function inbox(myKey: string | null = null) {
    const t = setup({ withTeam: false, myKey });
    t.gh.files = { policy: false, verifier: false, workflow: false };
    t.gh.signers = null;
    t.gh.open.push(
      rawPr({
        number: 30,
        author: BOB,
        requested: ["acme/core"],
        files: [[".github/workflows/ci.yml", 8, 2]],
      }),
      rawPr({ number: 31, reviews: [[BOB, "CHANGES_REQUESTED", 15]] }),
      rawPr({ number: 32, author: BOB, requested: [CAROL], body: "FYI: on-call page" }),
    );
    // GitHub's search: #30's team request reaches alice.
    t.gh.requested = [30];
    return t;
  }

  test("every PR is classified locally; review requests and my stuck PR need me", async () => {
    const t = inbox();
    t.source.start();
    await settle();
    const snap = t.source.snapshot()!;
    expect(snap.unclassified).toEqual([]);
    expect(
      snap.prs.map((p) => [p.number, p.classifiedBy, p.risk, p.needsMe, p.ask, p.waitingOn[0]]),
    ).toEqual([
      [30, "local", 3, true, APPROVE, { kind: "me" }],
      [31, "local", 0, true, null, { kind: "agent" }],
      [32, "local", 0, false, null, { kind: "person", login: CAROL }],
    ]);
    expect(t.pr(31).stuck).toEqual({ reason: "changes-requested", by: [BOB] });
    // No signers file: the FYI is for me alone.
    expect(t.pr(32).fyiForMe).toBe(true);
    // The search rides in the one poll query.
    expect(t.gh.queries("Poll")[0]!.body).toMatchObject({
      q0: `repo:${REPO} is:pr is:open review-requested:@me`,
    });
    expect((await t.source.setup(keyOf(t.source))).step).toBe("inbox");
  });

  test("a key changes nothing: there is nothing to sign, a review request asks for an approval", async () => {
    const t = inbox(FAKE_KEY.publicKey);
    t.source.start();
    await settle();
    expect(t.source.snapshot()!.prs.map((p) => [p.number, p.needsMe, p.ask])).toEqual([
      [30, true, APPROVE],
      [31, true, null],
      [32, false, null],
    ]);
  });

  test("approving: an APPROVED review at the head I looked at; the row leaves needs me at once", async () => {
    const t = inbox();
    t.source.start();
    await settle();
    const head = t.pr(30).headSha;
    const results = await t.source.postApprovals({
      repo: REPO,
      entries: [{ pr: 30, headSha: head }],
      body: null,
    });
    expect(results).toEqual([
      {
        pr: 30,
        ok: true,
        url: `https://github.com/${REPO}/pull/30#pullrequestreview-1`,
        message: null,
      },
    ]);
    expect(t.gh.rests().filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/repos/${REPO}/pulls/30/reviews`,
        body: { commit_id: head, event: "APPROVE" },
      },
    ]);
    expect(t.pr(30)).toMatchObject({ needsMe: false, ask: null });
    expect(t.pr(30).review).toMatchObject({ approvedBy: [ALICE], approvedAtHead: [ALICE] });
    // Asked through my team: my review answers the team's request, it is ready to merge.
    expect(t.pr(30).review?.teams).toEqual([]);
    expect(t.pr(30).waitingOn).toEqual([{ kind: "merge" }]);
    // The poll after it agrees: GitHub's search no longer finds the request.
    t.gh.requested = [];
    await t.advance(5 * SECOND);
    expect(t.pr(30).needsMe).toBe(false);
  });

  test("a refused approval is a failed entry, the others still post", async () => {
    const t = inbox();
    t.source.start();
    await settle();
    t.gh.routes.set(`POST /repos/${REPO}/pulls/30/reviews`, {
      status: 422,
      body: { message: "Can not approve your own pull request" },
    });
    const results = await t.source.postApprovals({
      repo: REPO,
      entries: [
        { pr: 30, headSha: t.pr(30).headSha },
        { pr: 32, headSha: t.pr(32).headSha },
      ],
      body: "Looks good",
    });
    expect(results.map((r) => [r.pr, r.ok])).toEqual([
      [30, false],
      [32, true],
    ]);
    expect(results[0]!.message).toMatch(
      /^Approving #30 failed: GitHub 422 .*your own pull request/,
    );
    expect(t.gh.rests().find((c) => c.path.endsWith("/32/reviews"))?.body).toEqual({
      commit_id: t.pr(32).headSha,
      event: "APPROVE",
      body: "Looks good",
    });
    expect(t.pr(30).needsMe).toBe(true);
  });

  test("once set up, the verifier is the source: a PR without a summary waits for it", async () => {
    const t = inbox();
    t.source.start();
    await settle();
    t.gh.files = { policy: true, verifier: true, workflow: true };
    t.gh.signers = `${ALICE} namespaces="nod" ${FAKE_KEY.publicKey}\n`;
    await t.source.refresh();
    await settle();
    const snap = t.source.snapshot()!;
    expect(snap.prs.map((p) => [p.classifiedBy ?? null, p.tags[0], p.needsMe])).toEqual([
      [null, "not classified", false],
      [null, "not classified", false],
      [null, "not classified", false],
    ]);
    expect(snap.unclassified.map((u) => u.number)).toEqual([30, 31, 32]);
    // The fake's branch rules require the `nod` check.
    expect((await t.source.setup(keyOf(t.source))).step).toBe("enforced");
  });
});

describe("my key", () => {
  test("enrolled: the asks are nods; pending or no key: approvals, nothing signable", async () => {
    const t = setup();
    t.source.start();
    await settle();
    expect(t.source.enrolment(keyOf(t.source), FAKE_KEY.publicKey)).toEqual({ state: "active" });
    expect(t.pr(26).needsMe).toBe(true);

    const other = publicKeyLine(ed25519PublicKeyBlob(new Uint8Array(32).fill(7)));
    t.setKey(other);
    expect(t.source.enrolment(keyOf(t.source), other)).toEqual({ state: "not-enrolled" });
    // Not enrolled: a teammate's peer slot asks for a GitHub approval instead (ADR 0006).
    expect(t.pr(26)).toMatchObject({ needsMe: true, ask: APPROVE, waitingOn: [{ kind: "me" }] });

    t.setKey(null);
    // My own PR's self slot: GitHub does not let me approve it, it waits on my key.
    expect(t.pr(27)).toMatchObject({ needsMe: false, ask: null, waitingOn: [{ kind: "me" }] });
  });

  test("a key in an open PR's allowed_signers is pending on that PR", async () => {
    const mine = publicKeyLine(ed25519PublicKeyBlob(new Uint8Array(32).fill(9)));
    const t = setup({ myKey: mine });
    const enrol = rawPr({
      number: 50,
      headRef: "nod/enrol-alice",
      files: [[".nod/allowed_signers", 1, 0]],
    });
    t.gh.open.push(enrol);
    t.gh.headSigners.set(enrol.headRefOid, `${t.gh.signers}${ALICE} namespaces="nod" ${mine}\n`);
    t.source.start();
    await settle();
    expect(t.source.enrolment(keyOf(t.source), mine)).toEqual({
      state: "pending",
      pr: { number: 50, url: `https://github.com/${REPO}/pull/50` },
    });
    // the same key under another login is not mine
    t.gh.headSigners.clear();
    expect(
      t.source.enrolment(keyOf(t.source), FAKE_KEY.publicKey.replace("nod-fake", "x")),
    ).toEqual({
      state: "active",
    });
  });

  test("a merged enrolment turns the key active and the asks appear", async () => {
    const mine = publicKeyLine(ed25519PublicKeyBlob(new Uint8Array(32).fill(3)));
    const t = setup({ myKey: mine });
    t.source.start();
    await settle();
    expect(t.pr(27).needsMe).toBe(false);
    t.gh.signers = `${t.gh.signers}${ALICE} namespaces="nod" ${mine}\n`;
    await t.advance(60 * SECOND);
    expect(t.source.enrolment(keyOf(t.source), mine)).toEqual({ state: "active" });
    expect(t.pr(27).needsMe).toBe(true);
    expect(t.changes).toContain("enrolment");
  });
});

describe("signing through the session", () => {
  function session(t: ReturnType<typeof setup>) {
    const signer = new FakeSigner(t.clock);
    const s = new Session({ source: t.source, signer, clock: t.clock, version: null, fake: false });
    const messages: ServerToClient[] = [];
    const client = {
      side: "loopback" as const,
      send: (d: string) => void messages.push(JSON.parse(d) as ServerToClient),
    };
    let id = 0;
    const ask = async (type: string, body: Record<string, unknown> = {}) => {
      const rid = `r${++id}`;
      await s.handle(client, JSON.stringify({ ...body, t: type, id: rid }));
      return messages.find((m) => m.t === "reply" && m.id === rid) as Reply;
    };
    return { signer, ask };
  }

  test("one payload over all entries, signed once, the same body on every PR, patch-ids fresh", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const { ask } = session(t);
    expect((await ask("unlock", { passphrase: "anything" })).ok).toBe(true);
    t.computed.length = 0;
    const reply = await ask("sign", {
      verdict: "approve",
      entries: [
        { repo: REPO, pr: 26, head_sha: sha("head-26") },
        { repo: REPO, pr: 27, head_sha: sha("head-27") },
      ],
    });
    expect(reply.ok).toBe(true);
    const result = (reply as Extract<Reply, { ok: true; to: "sign" }>).result;
    expect(result.posted.map((p) => p.pr)).toEqual([26, 27]);
    expect(result.failed).toEqual([]);
    const payload = JSON.parse(result.payloads[0]!.payload);
    expect(payload).toMatchObject({
      repo: REPO,
      reviewer: ALICE,
      entries: [
        { pr: 26, base: "main", head_sha: sha("head-26"), patch_id: sha(`pid-${sha("head-26")}`) },
        { pr: 27, base: "main", head_sha: sha("head-27"), patch_id: sha(`pid-${sha("head-27")}`) },
      ],
    });
    // computed again at signing time, against the base as it is now
    expect(t.computed).toEqual([
      { base: "main", headSha: sha("head-26") },
      { base: "main", headSha: sha("head-27") },
    ]);
    const posts = t.gh.rests().filter((c) => c.method === "POST" && c.path.endsWith("/comments"));
    expect(posts.map((p) => p.path)).toEqual([
      `/repos/${REPO}/issues/26/comments`,
      `/repos/${REPO}/issues/27/comments`,
    ]);
    const bodies = posts.map((p) => (p.body as { body: string }).body);
    expect(bodies[0]).toBe(bodies[1]!);
    expect(bodies[0]).toContain(result.payloads[0]!.payload);
    expect(bodies[0]).toContain("by `alice` · #26 #27");
    // and it polls fast to show the green check soon
    const before = t.gh.queries("Poll").length;
    await t.advance(2 * SECOND);
    expect(t.gh.queries("Poll").length).toBe(before + 1);
  });

  test("a failed post is reported per PR; the others are posted", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const { ask } = session(t);
    await ask("unlock", { passphrase: "anything" });
    t.gh.routes.set(`POST /repos/${REPO}/issues/27/comments`, {
      status: 500,
      body: { message: "boom" },
    });
    const reply = (await ask("sign", {
      verdict: "approve",
      entries: [
        { repo: REPO, pr: 26, head_sha: sha("head-26") },
        { repo: REPO, pr: 27, head_sha: sha("head-27") },
      ],
    })) as Extract<Reply, { ok: true; to: "sign" }>;
    expect(reply.result.posted.map((p) => p.pr)).toEqual([26]);
    expect(reply.result.failed).toEqual([
      { repo: REPO, pr: 27, message: expect.stringContaining("Retrying posts the same comment") },
    ]);
  });

  test("locked: nothing is fetched, signed or posted", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const { ask } = session(t);
    const reply = await ask("sign", {
      verdict: "approve",
      entries: [{ repo: REPO, pr: 27, head_sha: sha("head-27") }],
    });
    expect(reply).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(t.gh.rests().filter((c) => c.method === "POST")).toEqual([]);
  });

  test("a head that moved since the last poll is stale: nothing is signed", async () => {
    const t = setup();
    t.source.start();
    await settle();
    const { ask } = session(t);
    await ask("unlock", { passphrase: "anything" });
    t.gh.open[1] = rawPr({ number: 27, head: sha("pushed-27"), nodRun: { id: 5027 } });
    const reply = await ask("sign", {
      verdict: "approve",
      entries: [{ repo: REPO, pr: 27, head_sha: sha("head-27") }],
    });
    expect(reply).toMatchObject({ ok: false, error: { code: "stale" } });
    expect(t.gh.rests().filter((c) => c.method === "POST")).toEqual([]);
  });

  test("a pending key cannot sign", async () => {
    const t = setup({ myKey: FAKE_KEY.publicKey });
    t.gh.signers = "";
    t.source.start();
    await settle();
    const { ask } = session(t);
    await ask("unlock", { passphrase: "anything" });
    const reply = await ask("sign", {
      verdict: "approve",
      entries: [{ repo: REPO, pr: 27, head_sha: sha("head-27") }],
    });
    expect(reply).toMatchObject({ ok: false, error: { code: "key-pending" } });
  });
});

describe("FYI acks", () => {
  test("a 👀 reaction, shown at once; a PR without an FYI is not-found", async () => {
    const t = setup({ withTeam: false });
    t.gh.open.push(rawPr({ number: 60, author: BOB, nodRun: { id: 6060 } }));
    t.gh.texts.set(6060, summaryText(summaryFor(t.gh.open[0]!, { category: "fyi", fyi: true })));
    t.source.start();
    await settle();
    expect(t.pr(60).fyiForMe).toBe(true);
    await t.source.ackFyi(keyOf(t.source), 60);
    expect(t.gh.rests().at(-1)).toEqual({
      method: "POST",
      path: `/repos/${REPO}/issues/60/reactions`,
      body: { content: "eyes" },
    });
    expect(t.pr(60).fyiForMe).toBe(false);
    expect(t.pr(60).fyi?.acked).toEqual([ALICE]);
    expect(t.pr(60).journey.some((e) => e.text === "You got it")).toBe(true);
    await expect(t.source.ackFyi(keyOf(t.source), 61)).rejects.toMatchObject({ code: "not-found" });
  });

  test("acks by others come from the reactions on the next poll", async () => {
    const t = setup({ withTeam: false });
    const raw = rawPr({ number: 61, author: BOB, nodRun: { id: 6061 }, acks: [[CAROL, 3]] });
    t.gh.open.push(raw);
    t.gh.texts.set(6061, summaryText(summaryFor(raw, { category: "fyi", fyi: true })));
    t.source.start();
    await settle();
    expect(t.pr(61).fyi).toMatchObject({ acked: [CAROL], pending: [ALICE] });
  });
});

describe("setup and enrolment", () => {
  test("a set-up repo: every check ok", async () => {
    const t = setup();
    t.source.start();
    const status = await t.source.setup(keyOf(t.source));
    expect(status.state).toBe("ready");
    expect(status.checks.map((c) => [c.id, c.state])).toEqual([
      ["policy", "ok"],
      ["verifier", "ok"],
      ["workflow", "ok"],
      ["allowed-signers", "ok"],
      ["required-check", "ok"],
      ["auto-merge", "ok"],
    ]);
    expect(t.gh.rests().map((c) => c.path)).toContain(`/repos/${REPO}/rules/branches/main`);
  });

  test("a plan without rulesets (private repo on Free): the required check says so", async () => {
    const t = setup();
    t.gh.rulesError = {
      status: 403,
      message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    };
    t.source.start();
    const status = await t.source.setup(keyOf(t.source));
    expect(status.checks.find((c) => c.id === "required-check")).toMatchObject({
      state: "missing",
      note: "needs a paid plan",
    });
  });

  test("not set up, with the setup PR open: pending in that PR; the ruleset after the merge", async () => {
    const t = setup({ withTeam: false });
    t.gh.files = { policy: false, verifier: false, workflow: false };
    t.gh.signers = null;
    t.gh.rules = [];
    t.gh.autoMergeAllowed = false;
    t.gh.open.push(rawPr({ number: 14, headRef: "nod/setup" }));
    t.source.start();
    const status = await t.source.setup(keyOf(t.source));
    expect(status).toMatchObject({ state: "pending", setupPr: { number: 14 } });
    expect(status.checks.map((c) => [c.id, c.state, c.note])).toEqual([
      ["policy", "pending", "in #14"],
      ["verifier", "pending", "in #14"],
      ["workflow", "pending", "in #14"],
      ["allowed-signers", "pending", "in #14"],
      ["required-check", "missing", "after merge"],
      ["auto-merge", "missing", "after merge"],
    ]);
    expect(await t.source.openSetupPr(keyOf(t.source), "ssh-ed25519 AAAA")).toEqual({
      number: 14,
      url: expect.any(String),
    });
  });

  test("open-setup-pr runs nod init once, with or without a key, and refuses a set-up repo", async () => {
    const t = setup({ withTeam: false });
    t.gh.files = { policy: false, verifier: false, workflow: false };
    t.gh.signers = null;
    const opened: unknown[] = [];
    const source = oneRepo({
      clock: t.clock,
      api: t.api,
      patchIds: null,
      openSetupPr: async (input) => {
        opened.push(input);
        return `https://github.com/${REPO}/pull/14`;
      },
    });
    source.start();
    // No key: the setup PR opens with an empty allowed_signers (ADR 0006).
    expect(await source.openSetupPr(keyOf(source), null)).toEqual({
      number: 14,
      url: `https://github.com/${REPO}/pull/14`,
    });
    expect(opened).toEqual([{ login: ALICE, publicKey: null }]);
    // Opened once: a key created later is not added to it.
    expect((await source.openSetupPr(keyOf(source), "ssh-ed25519 KEY")).number).toBe(14);
    expect(opened).toHaveLength(1);
    expect((await source.setup(keyOf(source))).state).toBe("pending");
    source.stop();
    const done = setup();
    done.source.start();
    await expect(done.source.openSetupPr(keyOf(done.source), "x")).rejects.toMatchObject({
      code: "already-set-up",
    });
  });

  test("the enrolment PR: one line on nod/enrol-<login>, through the contents API", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "jwk" }).x!;
    const mine = publicKeyLine(ed25519PublicKeyBlob(Buffer.from(raw, "base64url")), "nod");
    const t = setup({ myKey: mine });
    const source = oneRepo({
      clock: t.clock,
      api: t.api,
      patchIds: null,
      myKey: () => mine,
      identity: { name: "Alice Example", email: "alice@example.invalid" },
    });
    source.start();
    await settle();
    const pr = await source.openEnrolPr(keyOf(source), mine);
    expect(pr).toEqual({ number: 77, url: `https://github.com/${REPO}/pull/77` });
    const rest = t.gh.rests().map((c) => `${c.method} ${c.path.split("?")[0]}`);
    // `GET /user`: the account, read once a poll reached GitHub.
    expect(rest.filter((r) => !r.includes("/rules/") && r !== "GET /user")).toEqual([
      `GET /repos/${REPO}/git/ref/heads/main`,
      `GET /repos/${REPO}/contents/.nod/allowed_signers`,
      `POST /repos/${REPO}/git/refs`,
      `PUT /repos/${REPO}/contents/.nod/allowed_signers`,
      `GET /repos/${REPO}/pulls`,
      `POST /repos/${REPO}/pulls`,
    ]);
    const calls = t.gh.rests();
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"))!.body).toEqual({
      ref: "refs/heads/nod/enrol-alice",
      sha: sha("main-tip"),
    });
    const put = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    const content = Buffer.from(String(put.content), "base64").toString("utf8");
    const keyPart = mine.split(" ").slice(0, 2).join(" ");
    expect(content).toBe(`${t.gh.signers}alice namespaces="nod" ${keyPart}\n`);
    expect(put).toMatchObject({
      branch: "nod/enrol-alice",
      sha: "blob-sha",
      author: { name: "Alice Example", email: "alice@example.invalid" },
      committer: { name: "Alice Example", email: "alice@example.invalid" },
    });
    const create = calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!
      .body as Record<string, string>;
    expect(create).toMatchObject({
      title: "chore(nod): enrol the signing key of alice",
      head: "nod/enrol-alice",
      base: "main",
    });
    expect(create.body).toContain("`.nod/**`");
    expect(create.body).toContain("peer");
    expect(source.enrolment(keyOf(source), mine)).toEqual({ state: "pending", pr });
    expect(await source.openEnrolPr(keyOf(source), mine)).toEqual(pr); // twice: the same PR, nothing new
    expect(
      t.gh.rests().filter((c) => c.method === "POST" && c.path.endsWith("/pulls")),
    ).toHaveLength(1);
    await expect(source.openEnrolPr(keyOf(source), FAKE_KEY.publicKey)).rejects.toMatchObject({
      code: "already-enrolled",
    });
    source.stop();
  });

  test("the clone override is a fixed list: no adding, removing or suggestions", async () => {
    const t = setup();
    t.source.start();
    expect(t.source.repoList).toBe("fixed");
    await expect(t.source.addRepo("acme/other")).rejects.toMatchObject({ code: "forbidden" });
    await expect(t.source.removeRepo(REPO)).rejects.toMatchObject({ code: "forbidden" });
    expect(await t.source.suggestRepos()).toEqual([]);
    expect(await t.source.account()).toEqual({
      login: ALICE,
      name: null,
      scopes: ["repo", "read:org"],
    });
  });

  test("without gh: no account, no snapshot, a clear sync error", async () => {
    const source = oneRepo({ clock: new ManualClock(T0), api: null, patchIds: null });
    source.start();
    expect(await source.account()).toBeNull();
    expect(source.snapshot()).toBeNull();
    expect((await source.setup(keyOf(source))).checks.every((c) => c.state === "unknown")).toBe(
      true,
    );
  });
});

test("the verifier's nods show up with what still matches", async () => {
  const t = setup({ withTeam: false });
  const raw = rawPr({ number: 70, author: BOB, nodRun: { id: 7070 } });
  t.gh.open.push(raw);
  t.gh.texts.set(
    7070,
    summaryText(
      summaryFor(raw, {
        requirement: { level: "peer", named: [] },
        nods: [nodEval(CAROL, BOB, 30, "patch_id")],
        satisfied: true,
      }),
    ),
  );
  t.source.start();
  await settle();
  expect(t.pr(70)).toMatchObject({
    needsMe: false,
    requirement: { satisfied: true },
    signatures: [{ by: CAROL, level: "peer", matchedBy: "patch_id", counts: true }],
    waitingOn: [{ kind: "merge" }],
  });
});

describe("on GitHub Enterprise hosts: everything from the clone's origin", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function enterprise(origin: string, host: string, token: string | null = "t0ken") {
    const clone = await tempRepo();
    cleanups.push(clone.cleanup);
    await clone.git("remote", "add", "origin", origin);
    const gh = new FakeGitHub(githubHost(host));
    team(gh);
    const clock = new ManualClock(T0);
    const lines: string[] = [];
    const source = githubSource({
      clock,
      repo: null,
      dir: clone.dir,
      configFile: `${clone.dir}/.no-config.json`,
      cacheDir: `${clone.dir}/.no-cache`,
      token: () => token,
      fetch: () => gh.fetch,
      patchIds: { compute: async (input) => sha(`pid-${input.headSha}`) },
      log: (l) => lines.push(l),
      myKey: () => FAKE_KEY.publicKey,
    });
    cleanups.push(async () => source.stop());
    await source.ready;
    await settle();
    return { gh, source, clock, lines };
  }

  for (const [kind, origin, host, webUrl] of [
    ["GHE.com", "https://acme.ghe.com/acme/widgets.git", "acme.ghe.com", "https://acme.ghe.com"],
    [
      "GHES",
      "ssh://git@git.example.test:2222/acme/widgets.git",
      "git.example.test",
      "https://git.example.test",
    ],
  ] as const)
    test(`${kind}: reads, signs, approves and posts through ${host}'s API only`, async () => {
      const { gh, source, clock } = await enterprise(origin, host);
      expect(source.repos()[0]!.github).toEqual({ host, webUrl });
      // Off github.com the repo key names the host (ADR 0007): another repo than github.com's acme/widgets.
      const KEY = `${host}/${REPO}`;
      expect(keyOf(source)).toBe(KEY);
      expect(source.snapshot()!.prs.every((p) => p.repo === KEY)).toBe(true);
      await expect(source.setup(REPO)).rejects.toMatchObject({ code: "not-found" });
      expect(source.snapshot()!.prs.map((p) => p.number)).toEqual([26, 27, 28]);
      expect(await source.account()).toMatchObject({ login: ALICE });
      // Signing goes through the same API: the comment lands on this host.
      const signer = new FakeSigner(clock);
      const s = new Session({ source, signer, clock, version: null, fake: false });
      const messages: ServerToClient[] = [];
      const client = {
        side: "loopback" as const,
        send: (d: string) => void messages.push(JSON.parse(d) as ServerToClient),
      };
      await s.handle(client, JSON.stringify({ t: "unlock", id: "u", passphrase: "anything" }));
      await s.handle(
        client,
        JSON.stringify({
          t: "sign",
          id: "s",
          verdict: "approve",
          entries: [{ repo: KEY, pr: 26, head_sha: sha("head-26") }],
        }),
      );
      const reply = messages.find((m) => m.t === "reply" && m.id === "s") as Extract<
        Reply,
        { ok: true; to: "sign" }
      >;
      expect(reply.ok).toBe(true);
      expect(reply.result.posted[0]!.url).toStartWith(`${webUrl}/acme/widgets/pull/26`);
      // So does a GitHub approval: the review lands on this host.
      await s.handle(
        client,
        JSON.stringify({
          t: "approve",
          id: "a",
          entries: [{ repo: KEY, pr: 26, head_sha: sha("head-26") }],
        }),
      );
      const approved = messages.find((m) => m.t === "reply" && m.id === "a") as Extract<
        Reply,
        { ok: true; to: "approve" }
      >;
      expect(approved.ok).toBe(true);
      expect(approved.result.posted[0]!.url).toStartWith(
        `${webUrl}/acme/widgets/pull/26#pullrequestreview-`,
      );
      // The welcome tells the web app the host.
      await s.attach(client);
      const welcome = messages.find((m) => m.t === "welcome");
      expect(welcome).toMatchObject({
        repos: [{ key: KEY, name: REPO, github: { host, webUrl } }],
      });
      expect(gh.queries("Poll").length).toBeGreaterThan(0);
      expect(gh.misdirected).toEqual([]);
      s.stop();
    });

  test("not logged in to that host: a sentence that names it", async () => {
    const { source, lines } = await enterprise(
      "git@acme.ghe.com:acme/widgets.git",
      "acme.ghe.com",
      null,
    );
    expect(lines.join("\n")).toContain(
      "`gh` is not logged in to acme.ghe.com. Run `gh auth login --hostname acme.ghe.com`",
    );
    expect(source.snapshot()).toBeNull();
    const setup = await source.setup(keyOf(source));
    expect(setup.checks.every((c) => c.state === "unknown")).toBe(true);
    expect(await source.account()).toBeNull();
  });

  test("an API bound to another host than the repo's is refused", () => {
    const api = new GitHubApi({ token: "t0ken", fetch: new FakeGitHub().fetch });
    expect(() =>
      oneRepo({
        clock: new ManualClock(T0),
        host: githubHost("acme.ghe.com"),
        api,
        patchIds: null,
      }),
    ).toThrow(/bound to github.com/);
  });
});
