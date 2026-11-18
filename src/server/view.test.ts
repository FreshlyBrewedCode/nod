import { describe, expect, test } from "bun:test";

import { STUCK_AFTER_MS, type Slot } from "../shared/protocol";
import { FAKE_PEOPLE, SEEDS, seedFacts } from "./fake-data";
import { canFill, toView, toViews, type PrFacts } from "./view";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const ME = "mara-l";
const ctx = { me: ME, now: NOW, people: Object.values(FAKE_PEOPLE) };
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
