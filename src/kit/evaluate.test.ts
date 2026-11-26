import { describe, expect, test } from "bun:test";

import {
  evaluateApprovals,
  evaluateNods,
  type ApprovalEvaluation,
  type PullRequestReview,
  type PullRequestState,
} from "./evaluate.ts";
import type { NodEntry, NodPayload } from "./nod.ts";
import { named, none, peer, self, strictest } from "./requirement.ts";
import type { VerifiedNod } from "./sshsig.ts";

const sha = (c: string) => c.repeat(40);

// PR #6 by alice, needs a peer (the replay table of finding 01)
const pr: PullRequestState = {
  repo: "acme/widgets",
  number: 6,
  author: "alice",
  base: "main",
  head_sha: sha("6"),
  patch_id: sha("p"),
};

const nod = (
  reviewer: string,
  entries: Partial<NodEntry>[] = [{}],
  over: Partial<NodPayload> = {},
): VerifiedNod => {
  const payload: NodPayload = {
    v: 1,
    repo: "acme/widgets",
    entries: entries.map((e) => ({
      pr: 6,
      base: "main",
      head_sha: sha("6"),
      patch_id: sha("p"),
      ...e,
    })),
    verdict: "approve",
    level: "review",
    reviewer,
    signed_at: "2026-11-18T18:43:33.000Z",
    ...over,
  };
  return { payload, payloadLine: JSON.stringify(payload) };
};

const one = (n: VerifiedNod, p = pr) =>
  evaluateNods({ pr: p, requirement: peer, verified: [n] }).nods[0]!;

describe("replay and scope (finding 01)", () => {
  test("a nod for another PR pasted here", () => {
    expect(one(nod("bob", [{ pr: 2 }])).why_not).toEqual({
      code: "no_entry",
      detail: "no entry for this PR",
    });
  });

  test("a nod for another repo", () => {
    expect(one(nod("bob", [{}], { repo: "acme/other" })).why_not).toEqual({
      code: "repo",
      detail: "nod is for repo acme/other",
    });
  });

  test("a rejected signature is listed and never counts", () => {
    const r = evaluateNods({
      pr,
      requirement: peer,
      verified: [],
      rejected: [{ reviewer: "bob", reason: "signature invalid: Could not verify signature." }],
    });
    expect(r.satisfied).toBe(false);
    expect(r.nods[0]).toMatchObject({
      reviewer: "bob",
      role: "peer",
      counts: false,
      why_not: { code: "signature" },
    });
  });

  test("verdict reject", () => {
    expect(one(nod("bob", [{}], { verdict: "reject" }))).toMatchObject({
      counts: false,
      matched: "head_sha",
      why_not: { code: "verdict", detail: "verdict reject" },
    });
  });

  test("an old nod after new commits is stale", () => {
    expect(one(nod("bob", [{ head_sha: sha("1"), patch_id: sha("2") }])).why_not).toEqual({
      code: "stale",
      detail: "stale: neither head_sha nor patch_id matches",
    });
  });

  test("a valid peer nod counts", () => {
    const r = evaluateNods({ pr, requirement: peer, verified: [nod("bob")] });
    expect(r.satisfied).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.nods[0]).toMatchObject({
      reviewer: "bob",
      role: "peer",
      counts: true,
      matched: "head_sha",
      why_not: null,
    });
  });

  test("after a clean rebase the patch-id carries the nod", () => {
    expect(one(nod("bob"), { ...pr, head_sha: sha("7") })).toMatchObject({
      counts: true,
      matched: "patch_id",
    });
  });

  test("an empty patch-id never matches by patch-id", () => {
    const empty = { ...pr, head_sha: sha("7"), patch_id: "" };
    expect(one(nod("bob", [{ patch_id: "" }]), empty).why_not?.code).toBe("stale");
  });
});

describe("base", () => {
  test("a retargeted PR loses its nod, even with the same head", () => {
    const retargeted = { ...pr, base: "main" };
    expect(one(nod("bob", [{ base: "feature-x" }]), retargeted)).toMatchObject({
      counts: false,
      why_not: { code: "base", detail: "signed for base feature-x, the PR now targets main" },
    });
  });
});

describe("self vs peer", () => {
  test("the author's nod is self, case-insensitively", () => {
    expect(one(nod("Alice")).role).toBe("self");
    expect(one(nod("ALICE"), { ...pr, author: "alice" }).role).toBe("self");
  });

  test("a self nod does not satisfy peer", () => {
    const r = evaluateNods({ pr, requirement: peer, verified: [nod("alice")] });
    expect(r.satisfied).toBe(false);
    expect(r.missing).toEqual([{ kind: "peer", approval: false }]);
  });

  test("a peer nod satisfies self", () => {
    expect(evaluateNods({ pr, requirement: self, verified: [nod("bob")] }).satisfied).toBe(true);
  });

  test("self waits for the author by name", () => {
    expect(evaluateNods({ pr, requirement: self, verified: [], approvals: [] }).missing).toEqual([
      { kind: "self", login: "alice", approval: true },
    ]);
    // without approvals passed in (a verifier that does not read them), a nod only
    expect(evaluateNods({ pr, requirement: self, verified: [] }).missing).toEqual([
      { kind: "self", login: "alice", approval: false },
    ]);
  });

  test("none needs nothing", () => {
    expect(evaluateNods({ pr, requirement: none, verified: [] })).toEqual({
      nods: [],
      approvals: [],
      satisfied: true,
      filled: [],
      missing: [],
    });
  });
});

describe("batch", () => {
  test("each PR looks up its own entry", () => {
    const batch = nod("bob", [
      { pr: 1, head_sha: sha("1") },
      { pr: 6 },
      { pr: 9, head_sha: sha("9") },
    ]);
    expect(one(batch)).toMatchObject({ counts: true, matched: "head_sha" });
    expect(one(batch, { ...pr, number: 9, head_sha: sha("9") })).toMatchObject({ counts: true });
    expect(one(batch, { ...pr, number: 4 }).why_not?.code).toBe("no_entry");
  });

  test("a batch may mix roles: self on alice's PR, peer on carol's", () => {
    const batch = nod("alice", [{ pr: 6 }, { pr: 7 }]);
    expect(one(batch).role).toBe("self");
    expect(one(batch, { ...pr, number: 7, author: "carol" }).role).toBe("peer");
  });
});

describe("named", () => {
  test("peer plus named(bob) is satisfied by bob alone", () => {
    const requirement = strictest(peer, named("bob"));
    const waiting = evaluateNods({ pr, requirement, verified: [nod("carol")] });
    expect(waiting.satisfied).toBe(false);
    expect(waiting.missing).toEqual([{ kind: "named", login: "bob", approval: false }]);
    expect(waiting.filled).toEqual([{ slot: "peer", reviewer: "carol", by: "nod" }]);
    expect(evaluateNods({ pr, requirement, verified: [nod("Bob")] }).satisfied).toBe(true);
  });

  test("before any nod, peer plus named(bob) asks only for bob", () => {
    expect(
      evaluateNods({ pr, requirement: strictest(peer, named("bob")), verified: [] }).missing,
    ).toEqual([{ kind: "named", login: "bob", approval: false }]);
  });

  test("named(author) with peer still needs someone else", () => {
    const requirement = strictest(peer, named("alice"));
    const r = evaluateNods({ pr, requirement, verified: [nod("alice")], approvals: [] });
    expect(r.missing).toEqual([{ kind: "peer", approval: true }]);
    expect(evaluateNods({ pr, requirement, verified: [nod("alice"), nod("bob")] }).satisfied).toBe(
      true,
    );
  });

  test("a stale nod from the named person does not count", () => {
    const r = evaluateNods({
      pr,
      requirement: named("bob"),
      verified: [nod("bob", [{ head_sha: sha("1"), patch_id: sha("2") }])],
    });
    expect(r.missing).toEqual([{ kind: "named", login: "bob", approval: false }]);
  });

  test("counting nods are listed first", () => {
    const r = evaluateNods({
      pr,
      requirement: peer,
      verified: [nod("carol", [{ pr: 2 }]), nod("bob")],
    });
    expect(r.nods.map((n) => n.reviewer)).toEqual(["bob", "carol"]);
  });
});

// ─── GitHub approvals (ADR 0006) ────────────────────────────────────────────

const review = (reviewer: string, over: Partial<PullRequestReview> = {}): PullRequestReview => ({
  reviewer,
  reviewerType: "User",
  state: "APPROVED",
  commit_id: sha("6"),
  submitted_at: "2026-11-26T09:00:00Z",
  ...over,
});

const writers = new Set(["bob", "carol", "dave"]);
const approvalsOf = (reviews: PullRequestReview[], p = pr) =>
  evaluateApprovals({
    pr: p,
    reviews,
    canApprove: async (login) => writers.has(login.toLowerCase()),
  });

const approval = (reviewer: string): ApprovalEvaluation => ({
  reviewer,
  counts: true,
  commit_id: sha("6"),
  submitted_at: "2026-11-26T09:00:00Z",
  why_not: null,
});

describe("which approvals count", () => {
  test("an approval of the head commit by a writer counts", async () => {
    expect(await approvalsOf([review("bob")])).toEqual([approval("bob")]);
  });

  test("an approval before the last push is stale", async () => {
    const [a] = await approvalsOf([review("bob", { commit_id: sha("1") })]);
    expect(a).toMatchObject({
      counts: false,
      why_not: { code: "stale", detail: "approved 1111111, not the head commit" },
    });
  });

  test("the latest deciding review wins; comments do not change it", async () => {
    // approved, then requested changes: no approval at all
    expect(
      await approvalsOf([review("bob"), review("bob", { state: "CHANGES_REQUESTED" })]),
    ).toEqual([]);
    // approved, then dismissed: none
    expect(await approvalsOf([review("bob"), review("Bob", { state: "DISMISSED" })])).toEqual([]);
    // requested changes, then approved: counts; a later comment keeps it
    expect(
      await approvalsOf([
        review("bob", { state: "CHANGES_REQUESTED" }),
        review("bob"),
        review("bob", { state: "COMMENTED" }),
        review("bob", { state: "PENDING", submitted_at: null }),
      ]),
    ).toEqual([approval("bob")]);
  });

  test("the author, a bot, and someone without write access do not count", async () => {
    const rows = await approvalsOf([
      review("alice"),
      review("renovate[bot]", { reviewerType: "Bot" }),
      review("mallory"),
    ]);
    expect(rows.map((r) => [r.reviewer, r.counts, r.why_not?.code])).toEqual([
      ["alice", false, "author"],
      ["renovate[bot]", false, "bot"],
      ["mallory", false, "permission"],
    ]);
  });

  test("write access is only asked for approvals that pass everything else; a throw does not count", async () => {
    const asked: string[] = [];
    const rows = await evaluateApprovals({
      pr,
      reviews: [review("bob"), review("carol", { commit_id: sha("1") })],
      canApprove: async (login) => {
        asked.push(login);
        throw new Error("GitHub 403 on /permission: Resource not accessible");
      },
    });
    expect(asked).toEqual(["bob"]);
    expect(rows[0]).toMatchObject({
      counts: false,
      why_not: {
        code: "permission",
        detail: "could not check write access: GitHub 403 on /permission: Resource not accessible",
      },
    });
  });
});

describe("approvals fill slots", () => {
  const approved = (...who: string[]) => who.map(approval);

  test("a peer slot is filled by an approval", () => {
    const r = evaluateNods({ pr, requirement: peer, verified: [], approvals: approved("bob") });
    expect(r.satisfied).toBe(true);
    expect(r.filled).toEqual([{ slot: "peer", reviewer: "bob", by: "approval" }]);
  });

  test("a self slot is filled by any approval or nod", () => {
    const r = evaluateNods({ pr, requirement: self, verified: [], approvals: approved("carol") });
    expect(r.filled).toEqual([{ slot: "self", reviewer: "carol", by: "approval" }]);
    // the author's own nod is preferred for self
    const both = evaluateNods({
      pr,
      requirement: self,
      verified: [nod("alice")],
      approvals: approved("carol"),
    });
    expect(both.filled).toEqual([{ slot: "self", reviewer: "alice", by: "nod" }]);
  });

  test("a named slot is filled by that person's approval, not someone else's", () => {
    const requirement = strictest(peer, named("bob"));
    const carol = evaluateNods({ pr, requirement, verified: [], approvals: approved("carol") });
    expect(carol.missing).toEqual([{ kind: "named", login: "bob", approval: true }]);
    const bob = evaluateNods({ pr, requirement, verified: [], approvals: approved("Bob") });
    expect(bob.satisfied).toBe(true);
    expect(bob.filled).toEqual([
      { slot: "peer", reviewer: "Bob", by: "approval" },
      { slot: "named", login: "bob", reviewer: "Bob", by: "approval" },
    ]);
  });

  test("a nod is preferred over an approval for the same slot", () => {
    const r = evaluateNods({
      pr,
      requirement: peer,
      verified: [nod("carol")],
      approvals: approved("bob"),
    });
    expect(r.filled).toEqual([{ slot: "peer", reviewer: "carol", by: "nod" }]);
  });

  test("an approval that does not count fills nothing", () => {
    const r = evaluateNods({
      pr,
      requirement: peer,
      verified: [],
      approvals: [{ ...approval("bob"), counts: false, why_not: { code: "stale", detail: "x" } }],
    });
    expect(r.satisfied).toBe(false);
    expect(r.approvals).toHaveLength(1);
  });

  test("an approval from the author never fills a slot, even if passed in as counting", () => {
    const r = evaluateNods({ pr, requirement: self, verified: [], approvals: approved("alice") });
    expect(r.satisfied).toBe(false);
  });

  describe("approvals: false", () => {
    test("peer({ approvals: false }) needs a peer nod", () => {
      const requirement = peer({ approvals: false });
      const r = evaluateNods({ pr, requirement, verified: [], approvals: approved("bob") });
      expect(r.satisfied).toBe(false);
      expect(r.missing).toEqual([{ kind: "peer", approval: false }]);
      expect(evaluateNods({ pr, requirement, verified: [nod("bob")] }).satisfied).toBe(true);
    });

    test("self({ approvals: false }) needs a nod, a peer's will do", () => {
      const requirement = self({ approvals: false });
      expect(
        evaluateNods({ pr, requirement, verified: [], approvals: approved("bob") }).missing,
      ).toEqual([{ kind: "self", login: "alice", approval: false }]);
      expect(evaluateNods({ pr, requirement, verified: [nod("bob")] }).satisfied).toBe(true);
    });

    test("named(bob, { approvals: false }) needs bob's nod", () => {
      const requirement = named("bob", { approvals: false });
      expect(
        evaluateNods({ pr, requirement, verified: [], approvals: approved("bob") }).missing,
      ).toEqual([{ kind: "named", login: "bob", approval: false }]);
    });

    test("peer plus a nod-only self: a peer approval and any nod", () => {
      const requirement = strictest(peer, self({ approvals: false }));
      const none = evaluateNods({ pr, requirement, verified: [], approvals: [] });
      expect(none.missing).toEqual([
        { kind: "peer", approval: true },
        { kind: "self", login: "alice", approval: false },
      ]);
      const r = evaluateNods({
        pr,
        requirement,
        verified: [nod("alice")],
        approvals: approved("bob"),
      });
      expect(r.satisfied).toBe(true);
      expect(r.filled).toEqual([
        { slot: "peer", reviewer: "bob", by: "approval" },
        { slot: "self", reviewer: "alice", by: "nod" },
      ]);
      // one peer nod fills both
      expect(evaluateNods({ pr, requirement, verified: [nod("bob")] }).satisfied).toBe(true);
    });

    test("a nod-only peer is not covered by a named person who may approve", () => {
      const requirement = strictest(peer({ approvals: false }), named("bob"));
      expect(evaluateNods({ pr, requirement, verified: [], approvals: [] }).missing).toEqual([
        { kind: "peer", approval: false },
        { kind: "named", login: "bob", approval: true },
      ]);
      const approvedOnly = evaluateNods({
        pr,
        requirement,
        verified: [],
        approvals: approved("bob"),
      });
      expect(approvedOnly.missing).toEqual([{ kind: "peer", approval: false }]);
    });

    test("the author named on their own PR can only nod", () => {
      const r = evaluateNods({ pr, requirement: named("alice"), verified: [] });
      expect(r.missing).toEqual([{ kind: "named", login: "alice", approval: false }]);
    });
  });
});
