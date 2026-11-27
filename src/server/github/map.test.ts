import { expect, test } from "bun:test";

import { tier } from "../../shared/attention";
import { toViews } from "../view";
import { classifyLocally } from "./local";
import { ciChecks, mapPr, nodCheckRun, reviewOf, type SummaryRead } from "./map";
import type { RawPr } from "./queries";
import {
  ALICE,
  BOB,
  CAROL,
  REPO,
  T0,
  iso,
  nodComment,
  nodEval,
  rawPr,
  sha,
  summaryFor,
} from "./test-support";

type Summary = Parameters<typeof summaryFor>[1];

const ctx = (summary: SummaryRead, extra: { headBranches?: Map<string, number> } = {}) => ({
  repo: REPO,
  defaultBranch: "main",
  summary,
  patchId: "f".repeat(40),
  headBranches: extra.headBranches ?? new Map<string, number>(),
  epicTitles: new Map([[7, "Search v2"]]),
  team: [ALICE, BOB, CAROL],
  me: ALICE,
});

/** One PR through `mapPr` and `toViews`, as alice sees it. */
function seen(raw: RawPr, summary: Summary | null, me = ALICE) {
  const read: SummaryRead = summary
    ? { kind: "ok", summary: summaryFor(raw, summary) }
    : { kind: "none" };
  const mapped = mapPr(raw, { ...ctx(read), me });
  const [view] = toViews([mapped.facts], { me, now: T0, people: [] });
  return { ...mapped, view: view! };
}

test("needs a peer: bob's core change asks alice for a peer nod, tier 1", () => {
  const raw = rawPr({ number: 26, author: BOB, files: [["core/scheduler.ts", 30, 4]] });
  const { view, unclassified } = seen(raw, {
    risk: 3,
    requirement: { level: "peer", named: [] },
    missing: [{ kind: "peer" }],
    reasons: [{ classifier: "paths", tag: "core", risk: 3, detail: "1 file under core/" }],
    satisfied: false,
  });
  expect(unclassified).toBeNull();
  expect(view).toMatchObject({
    category: "decide",
    risk: 3,
    tags: ["core"],
    mine: false,
    needsMe: true,
    ask: { kind: "peer", label: "Sign as peer", then: { outcome: "satisfied" } },
    requirement: {
      label: "Another human (not the prompter)",
      satisfied: false,
      slots: [{ role: "peer", who: null, except: BOB, state: "missing" }],
    },
    waitingOn: [{ kind: "me" }],
    reasons: [
      { classifier: "paths", fact: "1 file under core/", effect: "risk high", raises: true },
    ],
  });
  expect(tier(view)).toBe(1);
});

test("needs a self nod: alice's small change, tier 2", () => {
  const raw = rawPr({ number: 27, files: [["app/server.ts", 4, 0]] });
  const { view } = seen(raw, {
    risk: 1,
    requirement: { level: "self", named: [] },
    missing: [{ kind: "self", login: ALICE }],
    satisfied: false,
  });
  expect(view).toMatchObject({
    mine: true,
    needsMe: true,
    ask: { kind: "self", label: "Self-attest" },
    requirement: { label: "Prompter self-attest", slots: [{ role: "prompter", who: ALICE }] },
  });
  expect(tier(view)).toBe(2);
});

test("a self requirement on a teammate's PR waits on its author, not on me", () => {
  const raw = rawPr({ number: 40, author: BOB });
  const { view } = seen(raw, {
    requirement: { level: "self", named: [] },
    missing: [{ kind: "self", login: BOB }],
    satisfied: false,
  });
  expect(view.needsMe).toBe(false);
  expect(view.waitingOn).toEqual([{ kind: "person", login: BOB }]);
});

test("FYI declared by the author: acks are 👀 reactions, alice has not acked yet", () => {
  const raw = rawPr({
    number: 28,
    author: BOB,
    body: "**What** Adds `docs/oncall.md`.\n\nFYI: new on-call page\n",
    files: [["docs/oncall.md", 20, 0]],
    acks: [[CAROL, 15]],
  });
  const { view } = seen(raw, {
    category: "fyi",
    fyi: true,
    reasons: [{ classifier: "declared", tag: "fyi", detail: "the brief marks this as FYI" }],
  });
  expect(view.fyi).toEqual({
    reason: "declared by author: new on-call page",
    source: "declared",
    acked: [CAROL],
    pending: [ALICE],
  });
  expect(view.fyiForMe).toBe(true);
  expect(view.needsMe).toBe(false);
  expect(tier(view)).toBe(3);
  expect(view.journey.map((e) => e.text)).toContain("carol got it");
  // and for bob, the author, it asks nothing
  expect(seen(raw, { category: "fyi", fyi: true }, BOB).view.fyiForMe).toBe(false);
});

test("auto, waiting on checks: a pending check, no nod needed", () => {
  const raw = rawPr({
    number: 29,
    checks: [{ name: "test", status: "WAITING", conclusion: null }],
  });
  const { view } = seen(raw, {
    reasons: [{ classifier: "moduleTier", tag: "tier-3", detail: "copy" }],
  });
  expect(view.checks).toEqual({ state: "pending", passed: 0, total: 1, failing: [] });
  expect(view.requirement).toMatchObject({
    label: "None (auto-merge)",
    slots: [],
    satisfied: true,
  });
  expect(view.waitingOn).toEqual([{ kind: "checks" }]);
  expect(tier(view)).toBe(4);
});

test("a failing check: stuck, waiting on the agent; nod's own checks are left out", () => {
  const raw = rawPr({
    number: 30,
    checks: [{ name: "test", conclusion: "FAILURE" }, { name: "lint" }],
    nodRun: { id: 9030 },
  });
  const { view } = seen(raw, {
    risk: 1,
    requirement: { level: "self", named: [] },
    nods: [nodEval(ALICE, ALICE, 25)],
    satisfied: true,
  });
  expect(view.checks).toEqual({ state: "failing", passed: 1, total: 2, failing: ["test"] });
  expect(view.stuck).toEqual({ reason: "checks-failing", checks: ["test"] });
  expect(view.waitingOn[0]).toEqual({ kind: "agent" });
  expect(view.needsMe).toBe(false);
  expect(tier(view)).toBe(3);
  expect(view.journey.find((e) => e.kind === "checks")).toMatchObject({
    text: "Check failed",
    tone: "bad",
  });
});

test("a stale nod: alice's nod dropped after a push, she is asked to re-attest", () => {
  const head = sha("new-head-22");
  const raw = rawPr({
    number: 22,
    head,
    opened: 300,
    comments: [
      { body: nodComment(ALICE, [{ pr: 22, head_sha: sha("old-head-22") }], iso(200)), at: 200 },
    ],
    timeline: [
      {
        __typename: "PullRequestCommit",
        commit: { oid: sha("old-head-22"), committedDate: iso(305) },
      },
      { __typename: "PullRequestCommit", commit: { oid: head, committedDate: iso(100) } },
    ],
  });
  const { view } = seen(raw, {
    risk: 1,
    requirement: { level: "self", named: [] },
    nods: [nodEval(ALICE, ALICE, 200, "stale")],
    missing: [{ kind: "self", login: ALICE }],
    satisfied: false,
    at: 90,
  });
  expect(view.requirement.slots).toEqual([
    { role: "prompter", label: "Prompter", who: ALICE, except: null, state: "stale", signature: 0 },
  ]);
  expect(view.signatures[0]).toMatchObject({
    by: ALICE,
    byMe: true,
    counts: false,
    why: "content changed since",
    headSha: sha("old-head-22"),
    commentUrl: expect.stringContaining("#issuecomment-"),
  });
  expect(view.ask).toMatchObject({ kind: "re-attest", label: "Re-attest" });
  const texts = view.journey.map((e) => e.text);
  expect(texts.indexOf("You signed")).toBeLessThan(texts.indexOf("New commit"));
  expect(view.journey.find((e) => e.kind === "nod-dropped")).toMatchObject({
    at: T0 - 100 * 60_000,
    tone: "bad",
  });
  // the requirement waits since the last push
  expect(view.waitingSince).toBe(T0 - 100 * 60_000);
});

test("large with a self nod: the self nod is listed but does not count as a peer", () => {
  const raw = rawPr({
    number: 31,
    files: [["app/synonyms.ts", 1103, 0]],
    comments: [
      { body: nodComment(ALICE, [{ pr: 31, head_sha: sha("head-31") }], iso(40)), at: 40 },
    ],
  });
  const { view } = seen(raw, {
    risk: 3,
    requirement: { level: "peer", named: [] },
    reasons: [{ classifier: "diffSize", tag: "size:xl", risk: 3, detail: "+1103 −0 in 1 file" }],
    nods: [nodEval(ALICE, ALICE, 40)],
    missing: [{ kind: "peer" }],
    satisfied: false,
  });
  expect(view.signatures).toEqual([
    expect.objectContaining({ by: ALICE, level: "self", counts: true, matchedBy: "head_sha" }),
  ]);
  expect(view.requirement.slots).toEqual([
    expect.objectContaining({ role: "peer", except: ALICE, state: "missing" }),
  ]);
  expect(view.needsMe).toBe(false);
  expect(view.waitingOn).toEqual([{ kind: "anyone", except: ALICE }]);
  expect(tier(view)).toBe(3); // mine and high risk: one line, never folded
});

test("docs only: auto, green, waits for the merge", () => {
  const raw = rawPr({ number: 32, files: [["docs/architecture.md", 3, 1]] });
  const { view } = seen(raw, {
    reasons: [{ classifier: "paths", tag: "docs", detail: "1 file under docs/" }],
  });
  expect(view).toMatchObject({
    category: "auto",
    risk: 0,
    tags: ["docs"],
    waitingOn: [{ kind: "merge" }],
  });
  expect(view.diff).toMatchObject({ added: 3, removed: 1, files: 1 });
  expect(tier(view)).toBe(4);
});

test("a stacked pair: the upper PR needs the lower first, from its base and its brief", () => {
  const lower = rawPr({ number: 33, headRef: "agent/search-phrases", body: "Epic: #7" });
  const upper = rawPr({
    number: 34,
    base: "agent/search-phrases",
    body: "**What** Rank.\n\nDepends on #33\n",
  });
  const bare = rawPr({ number: 35, base: "agent/search-phrases", body: "no links" });
  const heads = new Map([["agent/search-phrases", 33]]);
  const s = (raw: RawPr): SummaryRead => ({
    kind: "ok",
    summary: summaryFor(raw, {
      requirement: { level: "self", named: [] },
      missing: [{ kind: "self", login: ALICE }],
    }),
  });
  const facts = [lower, upper, bare].map((r) => mapPr(r, ctx(s(r), { headBranches: heads })).facts);
  expect(facts.map((f) => f.dependsOn)).toEqual([[], [33], [33]]);
  expect(facts[0]!.epic).toEqual({ number: 7, title: "Search v2" });
  expect(facts[0]!.topic).toBe("Search v2");
  const views = toViews(facts, { me: ALICE, now: T0, people: [] });
  expect(views[0]!.unblocks).toEqual([34, 35]);
});

test("merged: done, the journey ends with the merge, waits on nothing", () => {
  const raw = rawPr({ number: 21, state: "MERGED", merged: 30, autoMerge: 60 });
  const { view } = seen(raw, { at: 40 });
  expect(view.state).toBe("merged");
  expect(view.mergedAt).toBe(T0 - 30 * 60_000);
  expect(view.waitingOn).toEqual([{ kind: "nothing" }]);
  expect(view.journey.at(-1)).toMatchObject({ kind: "merged", phase: "done" });
  expect(view.journey.map((e) => e.text)).toContain("Auto-merge on");
  expect(view.lastActivity).toEqual({ at: T0 - 30 * 60_000, text: "merged" });
});

test("no summary yet: high risk, no slots, listed as not classified", () => {
  const raw = rawPr({ number: 36 });
  const { facts, unclassified } = seen(raw, null);
  expect(unclassified).toBe("pending");
  expect(facts).toMatchObject({
    category: "decide",
    risk: 3,
    tags: ["not classified"],
    requirement: { policy: "not-classified", label: "Not classified yet", slots: [] },
  });
  expect(facts.reasons[0]!.fact).toBe("the verifier has not run on this head yet");
});

test("a verifier error: the summary's fail-safe requirement, tagged first", () => {
  const raw = rawPr({ number: 37, author: BOB });
  const { view, unclassified } = seen(raw, {
    category: "decide",
    risk: 3,
    requirement: { level: "peer", named: [] },
    missing: [{ kind: "peer" }],
    errors: [{ source: "verifier", message: "fetching the head failed" }],
    satisfied: false,
  });
  expect(unclassified).toBe("verifier-error");
  expect(view.tags[0]).toBe("verifier error");
  expect(view.reasons[0]).toMatchObject({
    classifier: "verifier",
    fact: "fetching the head failed",
  });
  // a nod check with no readable summary is a verifier error too
  const unreadable = mapPr(raw, ctx({ kind: "unreadable", title: "verifier error: boom" }));
  expect(unreadable.unclassified).toBe("verifier-error");
  expect(unreadable.facts.requirement.label).toBe("Unknown: verifier error");
});

test("a merged or closed PR without a readable summary is quiet history, not an error", () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const raw = rawPr({ number: 41, state, merged: 60 });
    for (const read of [
      { kind: "none" },
      { kind: "unreadable", title: "verifier error: boom" },
      { kind: "outdated", summary: summaryFor(raw, { base: "develop" }) },
    ] as const) {
      const mapped = mapPr(raw, ctx(read));
      expect(mapped.unclassified).toBeNull();
      expect(mapped.facts).toMatchObject({
        category: "auto",
        risk: 0,
        tags: [],
        reasons: [],
        requirement: { slots: [] },
      });
      const [view] = toViews([mapped.facts], { me: ALICE, now: T0, people: [] });
      expect(tier(view!)).toBe(4);
      expect(view!.needsMe).toBe(false);
    }
  }
});

test("an open PR without a readable summary stays an honest error, high risk", () => {
  for (const draft of [false, true]) {
    const mapped = mapPr(rawPr({ number: 42, draft }), ctx({ kind: "unreadable", title: "boom" }));
    expect(mapped.unclassified).toBe("verifier-error");
    expect(mapped.facts).toMatchObject({ risk: 3, tags: ["verifier error"] });
  }
});

test("a merged PR whose summary recorded a verifier error does not carry the error tag", () => {
  const raw = rawPr({ number: 43, state: "MERGED", merged: 60 });
  const { facts, unclassified } = seen(raw, {
    errors: [{ source: "verifier", message: "fetching the head failed" }],
  });
  expect(unclassified).toBeNull();
  expect(facts.tags).not.toContain("verifier error");
});

test("a summary for another base is not used: the verifier runs again", () => {
  const raw = rawPr({ number: 38 });
  const outdated = mapPr(
    raw,
    ctx({ kind: "outdated", summary: summaryFor(raw, { base: "develop" }) }),
  );
  expect(outdated.unclassified).toBe("pending");
  expect(outdated.facts.reasons[0]!.fact).toContain("for base develop");
});

test("named on top of a peer: alice's peer nod still waits on carol", () => {
  const raw = rawPr({ number: 39, author: BOB });
  const { view } = seen(raw, {
    requirement: { level: "peer", named: [CAROL] },
    missing: [{ kind: "named", login: CAROL }],
    satisfied: false,
  });
  expect(view.requirement.slots.map((s) => [s.role, s.who, s.state])).toEqual([
    ["peer", null, "missing"],
    ["owner", CAROL, "missing"],
  ]);
  expect(view.ask).toMatchObject({
    kind: "peer",
    then: { outcome: "waits", on: [{ kind: "person", login: CAROL }] },
  });
});

test("the diff leaves lockfiles and generated files out", () => {
  const raw = rawPr({
    number: 41,
    files: [
      ["bun.lock", 500, 300],
      ["dist/app.min.js", 40, 40],
      ["package.json", 1, 1],
    ],
  });
  const { facts } = seen(raw, {});
  expect(facts.diff).toEqual({
    added: 1,
    removed: 1,
    files: 1,
    excluded: { added: 540, removed: 340, files: 2 },
  });
  expect(facts.files!.map((f) => f.excluded)).toEqual(["lockfile", "generated", null]);
});

test("a batch nod comment fills in SHAs, batch size and the link; a newer one shows as being verified", () => {
  const raw = rawPr({
    number: 42,
    comments: [
      {
        body: nodComment(
          ALICE,
          [
            { pr: 42, head_sha: sha("head-42") },
            { pr: 43, head_sha: sha("head-43") },
          ],
          iso(30),
        ),
        at: 30,
      },
      { body: nodComment(BOB, [{ pr: 42, head_sha: sha("head-42") }], iso(5)), at: 5, by: BOB },
    ],
  });
  const { view } = seen(raw, {
    requirement: { level: "peer", named: [] },
    nods: [nodEval(ALICE, ALICE, 30)],
    missing: [{ kind: "peer" }],
    satisfied: false,
    at: 20,
  });
  expect(view.signatures).toEqual([
    expect.objectContaining({ by: ALICE, batchSize: 2, headSha: sha("head-42"), counts: true }),
    expect.objectContaining({
      by: BOB,
      level: "peer",
      counts: false,
      why: "being verified",
      matchedBy: "head_sha",
    }),
  ]);
  expect(view.lastActivity.text).toBe("bob signed");
});

test("the agent's name and the brief come from the body", () => {
  const raw = rawPr({
    number: 44,
    body: "**What** Retries jobs.\n\n**Why** Imports fail.\n\n_Opened by tern (agent) on behalf of alice._\n",
  });
  const { facts } = seen(raw, {});
  expect(facts.agent).toBe("tern");
  expect(facts.brief).toMatchObject({ what: "Retries jobs.", why: "Imports fail." });
  expect(facts.journey[0]).toMatchObject({ kind: "opened", detail: "tern" });
});

test("nodCheckRun takes the newest nod run from the verifier's app only", () => {
  const raw = rawPr({ number: 45, nodRun: { id: 5 } });
  const contexts = raw.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
  const forged = {
    ...(contexts.at(-1) as object),
    databaseId: 99,
    checkSuite: { app: { slug: "evil-app" }, workflowRun: null },
  };
  const withForged = {
    ...raw,
    commits: {
      nodes: [
        {
          commit: {
            ...raw.commits.nodes[0]!.commit,
            statusCheckRollup: {
              state: "FAILURE",
              contexts: { nodes: [...contexts, forged as never] },
            },
          },
        },
      ],
    },
  } as RawPr;
  expect(nodCheckRun(withForged)?.databaseId).toBe(5);
  expect(ciChecks(withForged).total).toBe(1); // test only: nod and verify are left out
});

test("a GitHub approval fills the peer slot; enforcement is carried (ADR 0006)", () => {
  const raw = rawPr({ number: 40, author: BOB, files: [["core/scheduler.ts", 30, 4]] });
  const { view } = seen(raw, {
    risk: 3,
    requirement: { level: "peer", named: [] },
    approvals: [
      {
        reviewer: CAROL,
        counts: true,
        commit_id: raw.headRefOid,
        submitted_at: iso(30),
        why_not: null,
      },
    ],
    filled: [{ slot: "peer", reviewer: CAROL, by: "approval" }],
    satisfied: true,
    enforcement: { enforced: false, by: null },
  });
  expect(view.requirement).toMatchObject({ satisfied: true, enforced: false });
  expect(view.requirement.slots).toEqual([
    {
      role: "peer",
      label: "Peer",
      who: null,
      except: BOB,
      state: "ok",
      signature: null,
      approval: CAROL,
    },
  ]);
  expect(view.needsMe).toBe(false);
});

test("a slot the policy keeps for nods says so, and an approval does not fill it", () => {
  const raw = rawPr({ number: 41, author: BOB, files: [[".nod/policy.ts", 3, 1]] });
  const { view } = seen(raw, {
    risk: 3,
    requirement: { level: "peer", named: [], nodsOnly: { level: "peer", named: [] } },
    approvals: [
      {
        reviewer: CAROL,
        counts: true,
        commit_id: raw.headRefOid,
        submitted_at: iso(30),
        why_not: null,
      },
    ],
    missing: [{ kind: "peer", approval: false }],
    satisfied: false,
  });
  expect(view.requirement.slots).toEqual([
    expect.objectContaining({ role: "peer", state: "missing", nodsOnly: true, signature: null }),
  ]);
  expect(view.requirement.slots[0]!.approval).toBeUndefined();
  expect(view.requirement.enforced).toBe(true);
});

test("GitHub's reviews: who is asked (people, teams), approvals and changes, writers' latest", () => {
  const raw = rawPr({
    number: 40,
    author: BOB,
    requested: [CAROL, "acme/core"],
    reviews: [
      [ALICE, "APPROVED", 30],
      [CAROL, "CHANGES_REQUESTED", 20],
    ],
  });
  expect(reviewOf(raw, ALICE, false)).toEqual({
    requested: [CAROL],
    teams: ["acme/core"],
    fromMe: false,
    approvedBy: [ALICE],
    approvedAtHead: [ALICE],
    changesRequestedBy: [CAROL],
  });
  // An approval of an older commit is still an approval, but not of this head (ADR 0006).
  const older = rawPr({ number: 42, reviews: [[BOB, "APPROVED", 30, sha("older")]] });
  expect(reviewOf(older, ALICE, false)).toMatchObject({ approvedBy: [BOB], approvedAtHead: [] });
  // Only GitHub's search knows a team request reaches me.
  expect(reviewOf(raw, ALICE, true).fromMe).toBe(true);
  expect(reviewOf(rawPr({ number: 41, requested: ["Alice"] }), ALICE, false).fromMe).toBe(true);
  // The journey shows the reviews.
  const { facts } = mapPr(raw, ctx({ kind: "none" }));
  expect(facts.journey.filter((e) => e.kind === "reviewed").map((e) => [e.text, e.tone])).toEqual([
    ["You approved", "plain"],
    ["carol requested changes", "bad"],
  ]);
});

test("the inbox step: a local classification gives risk, tags and reasons, no slots", async () => {
  const raw = rawPr({
    number: 42,
    author: BOB,
    files: [[".github/workflows/ci.yml", 20, 4]],
    mergeable: "CONFLICTING",
  });
  const local = await classifyLocally({
    repo: REPO,
    number: 42,
    title: raw.title,
    body: raw.body,
    author: BOB,
    base: "main",
    headSha: raw.headRefOid,
    files: raw.files!.nodes,
    totalFiles: 1,
  });
  const mapped = mapPr(raw, { ...ctx({ kind: "none" }), local, reviewRequested: true });
  expect(mapped.unclassified).toBeNull();
  expect(mapped.facts).toMatchObject({
    classifiedBy: "local",
    risk: 3,
    tags: ["protected", "ci-config", "size:s"],
    requirement: { slots: [], enforced: false },
    conflict: true,
  });
  expect(mapped.facts.reasons.map((r) => r.classifier)).toContain("paths");
  const [view] = toViews([mapped.facts], { me: ALICE, now: T0, people: [] });
  expect([view!.needsMe, view!.ask?.kind, tier(view!)]).toEqual([true, "approve", 1]);
});

test("a verifier summary wins over the local classification", async () => {
  const raw = rawPr({ number: 43, author: BOB });
  const local = await classifyLocally({
    repo: REPO,
    number: 43,
    title: raw.title,
    body: "Risk: high",
    author: BOB,
    base: "main",
    headSha: raw.headRefOid,
    files: raw.files!.nodes,
    totalFiles: 1,
  });
  const summary = summaryFor(raw, { risk: 1, requirement: { level: "self", named: [] } });
  const { facts } = mapPr(raw, { ...ctx({ kind: "ok", summary }), local });
  expect([facts.classifiedBy, facts.risk]).toEqual(["verifier", 1]);
});
