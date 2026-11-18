import { describe, expect, test } from "bun:test";

import { evaluateNods, type PullRequestState } from "./evaluate.ts";
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
    expect(r.missing).toEqual([{ kind: "peer" }]);
  });

  test("a peer nod satisfies self", () => {
    expect(evaluateNods({ pr, requirement: self, verified: [nod("bob")] }).satisfied).toBe(true);
  });

  test("self waits for the author by name", () => {
    expect(evaluateNods({ pr, requirement: self, verified: [] }).missing).toEqual([
      { kind: "self", login: "alice" },
    ]);
  });

  test("none needs nothing", () => {
    expect(evaluateNods({ pr, requirement: none, verified: [] })).toEqual({
      nods: [],
      satisfied: true,
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
    expect(waiting.missing).toEqual([{ kind: "named", login: "bob" }]);
    expect(evaluateNods({ pr, requirement, verified: [nod("Bob")] }).satisfied).toBe(true);
  });

  test("before any nod, peer plus named(bob) asks only for bob", () => {
    expect(
      evaluateNods({ pr, requirement: strictest(peer, named("bob")), verified: [] }).missing,
    ).toEqual([{ kind: "named", login: "bob" }]);
  });

  test("named(author) with peer still needs someone else", () => {
    const requirement = strictest(peer, named("alice"));
    const r = evaluateNods({ pr, requirement, verified: [nod("alice")] });
    expect(r.missing).toEqual([{ kind: "peer" }]);
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
    expect(r.missing).toEqual([{ kind: "named", login: "bob" }]);
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
