import { describe, expect, test } from "bun:test";

import { STUCK_AFTER_MS, type Slot } from "../shared/protocol";
import { FAKE_PEOPLE, SEEDS, seedFacts } from "./fake-data";
import { canFill, fillOf, toView, toViews, type PrFacts } from "./view";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const ME = "mara-l";
const ctx = { repo: "tallyho/fieldbook", me: ME, now: NOW, people: Object.values(FAKE_PEOPLE) };
const facts = (n: number): PrFacts =>
  seedFacts(
    SEEDS.find((s) => s.n === n)!,
    NOW,
  );

const slot = (over: Partial<Slot>): Slot => ({
  role: "peer",
  label: "Peer",
  who: null,
  except: "jonas-r",
  state: "missing",
  signature: null,
  ...over,
});

describe("canFill", () => {
  test("a peer slot: anyone but the prompter", () => {
    expect(canFill(slot({}), ME)).toBe(true);
    expect(canFill(slot({ except: ME }), ME)).toBe(false);
    expect(canFill(slot({ except: "MARA-L" }), ME)).toBe(false);
    expect(canFill(slot({ state: "ok" }), ME)).toBe(false);
  });

  test("a prompter or owner slot: only the person named", () => {
    expect(canFill(slot({ role: "owner", who: ME, except: null }), ME)).toBe(true);
    expect(canFill(slot({ role: "prompter", who: "jonas-r", except: null }), ME)).toBe(false);
    expect(canFill(slot({ role: "prompter", who: ME, except: null, state: "stale" }), ME)).toBe(
      true,
    );
  });
});

describe("the ask", () => {
  test("a teammate's PR that needs a peer: Sign as peer, then satisfied", () => {
    const v = toView(facts(482), ctx);
    expect([v.mine, v.needsMe, v.ask?.kind, v.ask?.label]).toEqual([
      false,
      true,
      "peer",
      "Sign as peer",
    ]);
    expect(v.ask?.then).toEqual({ outcome: "satisfied" });
    expect(v.waitingOn).toEqual([{ kind: "me" }]);
  });

  test("still waits on the prompter after my nod (#485)", () => {
    const v = toView(facts(485), ctx);
    expect(v.ask?.then).toEqual({ outcome: "waits", on: [{ kind: "person", login: "jonas-r" }] });
    expect(v.waitingOn).toEqual([{ kind: "me" }, { kind: "person", login: "jonas-r" }]);
  });

  test("owner beats peer, re-attest beats both", () => {
    expect(toView(facts(476), ctx).ask?.kind).toBe("owner");
    expect(toView(facts(491), ctx).ask).toMatchObject({ kind: "re-attest", label: "Re-attest" });
    expect(toView(facts(488), ctx).ask).toMatchObject({ kind: "self", label: "Self-attest" });
  });

  test("my own PR that needs a peer waits on any teammate, not on me", () => {
    const f = facts(482);
    const mine: PrFacts = {
      ...f,
      author: ME,
      prompter: ME,
      requirement: { ...f.requirement, slots: [slot({ except: ME })] },
    };
    const v = toView(mine, ctx);
    expect([v.mine, v.needsMe, v.ask]).toEqual([true, false, null]);
    expect(v.waitingOn).toEqual([{ kind: "anyone", except: ME }]);
  });

  test("merged, closed and draft PRs ask nothing", () => {
    for (const state of ["merged", "closed", "draft"] as const) {
      const v = toView({ ...facts(482), state }, ctx);
      expect([v.needsMe, v.ask]).toEqual([false, null]);
    }
    expect(toView({ ...facts(482), state: "merged" }, ctx).waitingOn).toEqual([
      { kind: "nothing" },
    ]);
    expect(toView({ ...facts(482), state: "draft" }, ctx).waitingOn[0]).toEqual({ kind: "agent" });
  });
});

describe("waiting on, stuck", () => {
  test("a failing check waits on the agent and is stuck", () => {
    const v = toView(facts(493), ctx);
    expect(v.waitingOn).toEqual([{ kind: "agent" }]);
    expect(v.stuck).toEqual({ reason: "checks-failing", checks: ["e2e (firefox)"] });
  });

  test("running checks, then the merge", () => {
    expect(toView(facts(483), ctx).waitingOn).toEqual([{ kind: "checks" }]);
    const green = {
      ...facts(483),
      checks: { state: "passing" as const, passed: 14, total: 14, failing: [] },
    };
    expect(toView(green, ctx).waitingOn).toEqual([{ kind: "merge" }]);
  });

  test("stuck after 12 hours waiting on a human", () => {
    const f = { ...facts(492), waitingSince: NOW - STUCK_AFTER_MS + 1 };
    expect(toView(f, ctx).stuck).toBeNull();
    const later = toView(f, { ...ctx, now: NOW + 1 });
    expect(later.stuck).toEqual({
      reason: "waiting",
      since: NOW - STUCK_AFTER_MS + 1,
      on: [{ kind: "person", login: "jonas-r" }],
    });
    expect(toView(facts(479), ctx).stuck?.reason).toBe("waiting");
  });

  test("waitingSince is only set while a human is missing", () => {
    expect(toView(facts(483), ctx).waitingSince).toBeNull();
    expect(toView(facts(485), ctx).waitingSince).toBe(NOW - 140 * 60_000);
  });
});

describe("journey, FYI, unblocks", () => {
  test("the present and the future steps follow the past", () => {
    const steps = toView(facts(485), ctx).journey.map((j) => `${j.phase}:${j.text}`);
    expect(steps).toEqual([
      "done:Opened",
      "done:Classified",
      "done:2 new commits",
      "now:Waiting on you",
      "next:Jonas signs",
      "next:Agent merges",
    ]);
    const merged = toView(facts(489), ctx).journey;
    expect(merged.every((j) => j.phase === "done")).toBe(true);
    expect(merged.at(-1)?.text).toBe("Merged");
  });

  test("before the repo requires the check a person merges, not the agent", () => {
    const f = facts(485);
    const shared = { ...f, requirement: { ...f.requirement, enforced: false } };
    expect(toView(shared, ctx).journey.at(-1)?.text).toBe("Merged");
    const enforced = { ...f, requirement: { ...f.requirement, enforced: true } };
    expect(toView(enforced, ctx).journey.at(-1)?.text).toBe("Agent merges");
  });

  test("an FYI I have not acked", () => {
    expect(toView(facts(478), ctx).fyiForMe).toBe(true);
    expect(toView(facts(476), ctx).fyiForMe).toBe(false);
  });

  test("unblocks is the reverse of dependsOn", () => {
    const views = toViews([facts(482), facts(485), facts(492)], ctx);
    expect(views.map((v) => [v.number, v.dependsOn, v.unblocks])).toEqual([
      [482, [485], []],
      [485, [492], [482]],
      [492, [], [485]],
    ]);
  });

  test("signatures know which are mine", () => {
    const v = toView(facts(483), ctx);
    expect(v.signatures.map((s) => [s.by, s.byMe, s.level, s.counts])).toEqual([
      ["mara-l", true, "peer", true],
    ]);
    expect(v.requirement.satisfied).toBe(true);
  });
});

describe("the inbox step: classified locally, needs me from GitHub's reviews", () => {
  const review = (over: Partial<NonNullable<PrFacts["review"]>> = {}) => ({
    requested: [],
    teams: [],
    fromMe: false,
    approvedBy: [],
    changesRequestedBy: [],
    ...over,
  });
  /** #482 (Jonas's) as the inbox step sees it: no slots, GitHub's reviews. */
  const local = (over: Partial<PrFacts> = {}): PrFacts => ({
    ...facts(482),
    classifiedBy: "local",
    requirement: { policy: "none", label: "Nothing: the repository has no nod policy", slots: [] },
    review: review(),
    conflict: false,
    ...over,
  });
  const mine = (over: Partial<PrFacts> = {}) => local({ author: ME, prompter: ME, ...over });

  test("a review requested from me: needs me, asks for an approval, waits on me", () => {
    const v = toView(local({ review: review({ requested: [ME], fromMe: true }) }), ctx);
    expect([v.needsMe, v.ask, v.waitingOn]).toEqual([
      true,
      { kind: "approve", label: "Approve", then: { outcome: "satisfied" } },
      [{ kind: "me" }],
    ]);
    expect(v.requirement.satisfied).toBe(false);
  });

  test("the approval's outcome: it still waits on another reviewer, or on changes requested", () => {
    const two = toView(
      local({ review: review({ requested: [ME, "inescal"], fromMe: true }) }),
      ctx,
    );
    expect(two.ask?.then).toEqual({
      outcome: "waits",
      on: [{ kind: "person", login: "inescal" }],
    });
    const changes = toView(
      local({ review: review({ requested: [ME], fromMe: true, changesRequestedBy: ["inescal"] }) }),
      ctx,
    );
    expect(changes.ask?.then).toEqual({
      outcome: "waits",
      on: [{ kind: "person", login: "inescal" }],
    });
    // Through a team I am in: the same ask.
    const team = toView(local({ review: review({ teams: ["tallyho/core"], fromMe: true }) }), ctx);
    expect(team.ask?.kind).toBe("approve");
  });

  test("no approve: nobody asked me, a draft, or my own PR (GitHub refuses that)", () => {
    expect(toView(local({ review: review({ requested: ["inescal"] }) }), ctx).ask).toBeNull();
    const draft = toView(
      local({ state: "draft", review: review({ requested: [ME], fromMe: true }) }),
      ctx,
    );
    expect([draft.ask, draft.needsMe]).toEqual([null, false]);
    const own = toView(mine({ review: review({ requested: [ME], fromMe: true }) }), ctx);
    expect(own.ask).toBeNull();
  });

  test("approved: the request is answered, the row leaves needs me", () => {
    const v = toView(local({ review: review({ approvedBy: [ME], approvedAtHead: [ME] }) }), {
      ...ctx,
      signing: false,
    });
    expect([v.needsMe, v.ask, v.waitingOn]).toEqual([false, null, [{ kind: "merge" }]]);
  });

  test("through a team I am in: needs me; a team without me is a teammate", () => {
    const mineTeam = toView(
      local({ review: review({ teams: ["tallyho/core"], fromMe: true }) }),
      ctx,
    );
    expect([mineTeam.needsMe, mineTeam.waitingOn]).toEqual([true, [{ kind: "me" }]]);
    const other = toView(local({ review: review({ teams: ["tallyho/web"] }) }), ctx);
    expect([other.needsMe, other.waitingOn]).toEqual([
      false,
      [{ kind: "anyone", except: "jonas-r" }],
    ]);
  });

  test("asked of someone else: waits on them, not me", () => {
    const v = toView(local({ review: review({ requested: ["inescal"] }) }), ctx);
    expect([v.needsMe, v.waitingOn]).toEqual([false, [{ kind: "person", login: "inescal" }]]);
  });

  test("nobody asked: any teammate; approved: the merge, and the reviews are met", () => {
    expect(toView(local(), ctx).waitingOn).toEqual([{ kind: "anyone", except: "jonas-r" }]);
    const approved = toView(local({ review: review({ approvedBy: ["inescal"] }) }), ctx);
    expect(approved.waitingOn).toEqual([{ kind: "merge" }]);
    expect(approved.requirement.satisfied).toBe(true);
    const ready = approved.journey.filter((e) => e.phase !== "done").map((e) => e.text);
    expect(ready).toEqual(["Ready to merge"]);
  });

  test("my own PR, stuck: changes requested, a conflict, a failing check need me", () => {
    const changes = toView(mine({ review: review({ changesRequestedBy: ["jonas-r"] }) }), ctx);
    expect([changes.needsMe, changes.stuck, changes.waitingOn[0]]).toEqual([
      true,
      { reason: "changes-requested", by: ["jonas-r"] },
      { kind: "agent" },
    ]);
    expect(changes.journey.find((e) => e.phase === "now")?.text).toBe("Changes requested");
    const conflict = toView(mine({ conflict: true }), ctx);
    expect([conflict.needsMe, conflict.stuck]).toEqual([true, { reason: "conflict" }]);
    const red = toView(
      mine({ checks: { state: "failing", passed: 13, total: 14, failing: ["e2e"] } }),
      ctx,
    );
    expect([red.needsMe, red.stuck?.reason]).toEqual([true, "checks-failing"]);
  });

  test("my own PR that only waits, even for long, or a draft: does not need me", () => {
    const waiting = toView(mine({ openedAt: NOW - STUCK_AFTER_MS - 1, waitingSince: null }), ctx);
    expect([waiting.needsMe, waiting.stuck?.reason]).toEqual([false, "waiting"]);
    const draft = toView(mine({ state: "draft", conflict: true }), ctx);
    expect([draft.needsMe, draft.waitingOn]).toEqual([false, [{ kind: "agent" }]]);
  });

  test("the journey says review, not sign, and a person merges", () => {
    const v = toView(local({ review: review({ requested: [ME, "inescal"], fromMe: true }) }), ctx);
    expect(v.journey.filter((e) => e.phase !== "done").map((e) => e.text)).toEqual([
      "Waiting on you",
      "Ines reviews",
      "Merged",
    ]);
  });

  test("with a policy, a conflict or requested changes make it stuck too", () => {
    const f = {
      ...facts(482),
      review: review({ changesRequestedBy: ["inescal"] }),
      conflict: true,
    };
    const v = toView(f, ctx);
    expect(v.stuck).toEqual({ reason: "conflict" });
    // The slots still decide what needs me.
    expect([v.needsMe, v.ask?.kind]).toEqual([true, "peer"]);
  });
});

describe("without an active key: GitHub approvals (ADR 0006)", () => {
  const noKey = { ...ctx, signing: false };
  const review = (over: Partial<NonNullable<PrFacts["review"]>> = {}) => ({
    requested: [],
    teams: [],
    fromMe: false,
    approvedBy: [],
    changesRequestedBy: [],
    ...over,
  });

  test("a peer slot takes my approval: Approve, then satisfied", () => {
    const v = toView(facts(482), noKey);
    expect([v.needsMe, v.ask]).toEqual([
      true,
      { kind: "approve", label: "Approve", then: { outcome: "satisfied" } },
    ]);
    expect(v.waitingOn).toEqual([{ kind: "me" }]);
  });

  test("a named slot for me takes it too; the prompter's slot still waits on them", () => {
    expect(toView(facts(476), noKey).ask?.kind).toBe("approve");
    expect(toView(facts(485), noKey).ask?.then).toEqual({
      outcome: "waits",
      on: [{ kind: "person", login: "jonas-r" }],
    });
  });

  test("a nod-only slot asks for nothing: it waits on my key", () => {
    const f = facts(482);
    const v = toView(
      { ...f, requirement: { ...f.requirement, slots: [slot({ nodsOnly: true })] } },
      noKey,
    );
    expect([v.needsMe, v.ask, v.waitingOn]).toEqual([false, null, [{ kind: "me" }]]);
  });

  test("my own PR: no approve (GitHub refuses it); its self slot waits on my key", () => {
    const v = toView(facts(488), noKey);
    expect([v.mine, v.needsMe, v.ask, v.waitingOn]).toEqual([true, false, null, [{ kind: "me" }]]);
  });

  test("I approved this head: no second ask, it waits on the verifier", () => {
    const v = toView({ ...facts(482), review: review({ approvedAtHead: [ME] }) }, noKey);
    expect([v.needsMe, v.ask, v.waitingOn]).toEqual([false, null, [{ kind: "checks" }]]);
    // An approval of an older head does not count: asked again.
    const old = toView({ ...facts(482), review: review({ approvedBy: [ME] }) }, noKey);
    expect(old.ask?.kind).toBe("approve");
  });

  test("with an active key the ask stays a nod", () => {
    expect(toView(facts(482), { ...ctx, signing: true }).ask?.kind).toBe("peer");
    expect(toView(facts(482), ctx).ask?.kind).toBe("peer");
  });

  test("fillOf: how I would fill a slot", () => {
    const f = { author: "jonas-r", review: undefined };
    expect(fillOf(slot({}), f, ME, true)).toBe("nod");
    expect(fillOf(slot({}), f, ME, false)).toBe("approval");
    expect(fillOf(slot({ nodsOnly: true }), f, ME, false)).toBe("key");
    expect(fillOf(slot({ state: "ok" }), f, ME, false)).toBeNull();
    expect(fillOf(slot({ except: ME }), f, ME, false)).toBeNull();
    expect(
      fillOf(slot({ role: "prompter", who: ME, except: null }), { author: ME }, ME, false),
    ).toBe("key");
  });
});
