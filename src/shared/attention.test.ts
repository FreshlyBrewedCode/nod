import { describe, expect, test } from "bun:test";

import { FakeSource } from "../server/fake-source";
import { ManualClock } from "../server/clock";
import {
  attentionView,
  boardView,
  bucketOf,
  chronologicalView,
  cluster,
  clusterKind,
  compareAttention,
  kindNames,
  tagWording,
  countByTier,
  lane,
  mergedOnTheirOwn,
  oldestWaitingSince,
  selectable,
  startOfDay,
  stateBoardView,
  stateOf,
  tier,
  waitsOnMyKey,
  type Item,
} from "./attention";
import type { PrView } from "./protocol";

// Wed 18 Nov 2026, 14:20 UTC: the mockup's "now".
const NOW = Date.UTC(2026, 10, 18, 14, 20);
const MIN = 60_000;
const HOUR = 60 * MIN;
const UTC = { now: NOW, utcOffsetMinutes: 0 };

const mockup = () => new FakeSource({ clock: new ManualClock(NOW) }).snapshot()!;

/** A PR view with defaults that make it tier 4; tests override what matters. */
function pr(over: Partial<PrView> & { number: number }): PrView {
  return {
    title: `#${over.number}`,
    url: "",
    state: "open",
    author: "jonas-r",
    prompter: "jonas-r",
    agent: null,
    topic: null,
    category: "auto",
    risk: 0,
    tags: [],
    base: "main",
    headSha: "a".repeat(40),
    patchId: "b".repeat(40),
    openedAt: NOW - HOUR,
    mergedAt: null,
    diff: { added: 1, removed: 1, files: 1, excluded: { added: 0, removed: 0, files: 0 } },
    checks: { state: "passing", passed: 1, total: 1, failing: [] },
    requirement: { policy: "p", label: "None", slots: [], satisfied: true },
    signatures: [],
    reasons: [],
    fyi: null,
    brief: null,
    epic: null,
    dependsOn: [],
    unblocks: [],
    journey: [],
    files: null,
    lastActivity: { at: NOW - HOUR, text: "opened" },
    mine: false,
    needsMe: false,
    ask: null,
    fyiForMe: false,
    stuck: null,
    waitingOn: [{ kind: "merge" }],
    waitingSince: null,
    ...over,
  };
}

const show = (items: ReadonlyArray<Item>) =>
  items.map((i) => (i.kind === "pr" ? `${i.pr.number}/${i.form}` : `[${i.label} · ${i.subtitle}]`));

describe("tier", () => {
  const stuck = { reason: "checks-failing", checks: ["e2e"] } as const;

  test("rule 1: needs me, and high risk or a teammate's work → prominent", () => {
    expect(tier(pr({ number: 1, needsMe: true, risk: 0, mine: false }))).toBe(1);
    expect(tier(pr({ number: 1, needsMe: true, risk: 3, mine: true }))).toBe(1);
  });

  test("rule 2: needs me, my own work, risk ≤ 2 → normal", () => {
    for (const risk of [0, 1, 2] as const)
      expect(tier(pr({ number: 1, needsMe: true, risk, mine: true }))).toBe(2);
  });

  test("rule 3: an FYI for me → one line", () => {
    expect(tier(pr({ number: 1, fyiForMe: true }))).toBe(3);
    expect(tier(pr({ number: 1, fyiForMe: true, state: "merged" }))).toBe(3);
  });

  test("rule 4: open, and mine and stuck, or high risk → one line", () => {
    expect(tier(pr({ number: 1, mine: true, stuck }))).toBe(3);
    expect(tier(pr({ number: 1, risk: 3 }))).toBe(3);
    // a teammate's stuck PR is not mine to watch
    expect(tier(pr({ number: 1, mine: false, stuck }))).toBe(4);
    // merged or closed, it no longer needs the room
    expect(tier(pr({ number: 1, risk: 3, state: "merged" }))).toBe(4);
    expect(tier(pr({ number: 1, mine: true, stuck, state: "closed" }))).toBe(4);
    // a draft is still open
    expect(tier(pr({ number: 1, risk: 3, state: "draft" }))).toBe(3);
  });

  test("rule 5: everything else folds", () => {
    expect(tier(pr({ number: 1 }))).toBe(4);
    expect(tier(pr({ number: 1, risk: 2, mine: true }))).toBe(4);
  });

  test("the first rule that matches wins", () => {
    // needs me beats FYI and stuck
    expect(tier(pr({ number: 1, needsMe: true, mine: true, risk: 1, fyiForMe: true, stuck }))).toBe(
      2,
    );
    // FYI beats nothing: a merged high-risk FYI stays one line through rule 3
    expect(tier(pr({ number: 1, fyiForMe: true, risk: 3, state: "merged" }))).toBe(3);
  });
});

describe("the mockup's data", () => {
  test("3 prominent, 3 normal, 5 one-liners, 7 folded (README)", () => {
    expect(countByTier(mockup().prs)).toEqual({ 1: 3, 2: 3, 3: 5, 4: 7 });
  });

  test("the tiers per PR", () => {
    const byTier = (t: number) =>
      mockup()
        .prs.filter((p) => tier(p) === t)
        .map((p) => p.number)
        .sort();
    expect(byTier(1)).toEqual([476, 482, 485]);
    expect(byTier(2)).toEqual([488, 490, 491]);
    expect(byTier(3)).toEqual([478, 479, 480, 487, 493]);
    expect(byTier(4)).toEqual([477, 481, 483, 484, 486, 489, 492]);
  });

  test("lanes by attention: Needs you sorted by tier, risk, age; background ends in one cluster", () => {
    const lanes = attentionView(mockup().prs);
    expect(lanes.map((l) => [l.title, l.count])).toEqual([
      ["Needs you", 6],
      ["Worth knowing", 3],
      ["Background", 9],
    ]);
    // tier 1 first; inside it risk 3 before 2, then the longest wait (#476 waits 5 h, #485 2 h)
    expect(show(lanes[0]!.items)).toEqual(["476/1", "485/1", "482/1", "490/2", "488/2", "491/2"]);
    expect(show(lanes[1]!.items)).toEqual(["487/3", "478/3", "480/3"]);
    expect(show(lanes[2]!.items)).toEqual([
      "479/3",
      "493/3",
      "[7 low-risk changes · 3 deps · 2 tier 1 · 1 signed by you · 1 docs]",
    ]);
  });

  test("chronological: 3 buckets, 2 clusters, 1 single (README)", () => {
    const buckets = chronologicalView(mockup().prs, UTC);
    expect(buckets.map((b) => [b.label, b.count])).toEqual([
      ["Last hour", 5],
      ["Earlier today", 10],
      ["Yesterday", 3],
    ]);
    expect(show(buckets[0]!.items)).toEqual([
      "493/3",
      "491/2",
      "490/2",
      "[2 low-risk changes · 1 tier 1 · 1 deps]",
    ]);
    expect(show(buckets[1]!.items)).toEqual([
      "487/3",
      "488/2",
      "482/1",
      "485/1",
      "478/3",
      "476/1",
      "[4 low-risk changes · 2 deps · 1 tier 1 · 1 signed by you]",
    ]);
    // one low-risk item in the bucket: a dim one-liner in its place in time
    expect(show(buckets[2]!.items)).toEqual(["477/4", "480/3", "479/3"]);
  });

  test("board by Waiting on", () => {
    const snapshot = mockup();
    const columns = boardView(snapshot.prs, { me: snapshot.me, people: snapshot.people });
    expect(columns.map((c) => [c.title, c.count])).toEqual([
      ["You", 6],
      // Jonas first: #492 waits on him, and #485 after me (r3 `09`)
      ["Jonas", 1],
      ["Ines", 1],
      ["Agents & CI", 4],
      ["Merged", 6],
    ]);
    expect(show(columns[0]!.items)).toEqual(["476/1", "485/1", "482/1", "490/2", "488/2", "491/2"]);
    // #485 waits on me first, then on Jonas: "also #485, after you"
    expect(columns[1]!.also).toEqual([485]);
    expect(show(columns[1]!.items)).toEqual(["492/4"]);
    expect(show(columns[3]!.items)).toEqual([
      "478/3",
      "493/3",
      "[2 low-risk changes · 1 tier 1 · 1 signed by you]",
    ]);
    expect(show(columns[4]!.items)).toEqual([
      "487/3",
      "480/3",
      "[4 low-risk changes · 2 deps · 1 tier 1 · 1 docs]",
    ]);
  });
});

describe("the board by state", () => {
  test("the mockup's team in the four State columns (r2 `05`)", () => {
    const snapshot = mockup();
    const columns = stateBoardView(snapshot.prs);
    expect(columns.map((c) => [c.title, c.count, c.mine])).toEqual([
      ["Checks running", 2, 0],
      ["Needs a signature", 8, 6],
      ["Signed · merging", 2, 0],
      ["Merged", 6, 0],
    ]);
    expect(show(columns[1]!.items).slice(0, 3)).toEqual(["476/1", "485/1", "482/1"]);
  });

  test("a missing signature wins over running checks; drafts are with the agent", () => {
    const open = { policy: "p", label: "Peer", slots: [], satisfied: false };
    const pending = { state: "pending", passed: 0, total: 1, failing: [] } as const;
    const slot = {
      role: "peer",
      label: "Peer",
      who: null,
      except: null,
      state: "ok",
      signature: 0,
    } as const;
    expect(stateOf(pr({ number: 1, requirement: open, checks: pending }))).toBe("signature");
    expect(stateOf(pr({ number: 2, checks: pending }))).toBe("checks");
    const signed = { policy: "p", label: "Peer", slots: [slot], satisfied: true };
    expect(stateOf(pr({ number: 6, requirement: signed, checks: pending }))).toBe("merging");
    expect(stateOf(pr({ number: 3, state: "draft" }))).toBe("checks");
    expect(stateOf(pr({ number: 4 }))).toBe("merging");
    expect(stateOf(pr({ number: 5, state: "closed" }))).toBe("done");
  });
});

describe("sorting", () => {
  test("tier, then risk, then the longest wait, then the number", () => {
    const a = pr({ number: 10, needsMe: true, mine: true, risk: 2, waitingSince: NOW - 5 * HOUR });
    const b = pr({ number: 11, needsMe: true, mine: false, risk: 0 });
    const c = pr({ number: 12, needsMe: true, mine: true, risk: 1, waitingSince: NOW - 9 * HOUR });
    const d = pr({ number: 13, needsMe: true, mine: true, risk: 2, waitingSince: NOW - 9 * HOUR });
    const e = pr({ number: 9, needsMe: true, mine: true, risk: 2, waitingSince: NOW - 9 * HOUR });
    expect([a, b, c, d, e].sort(compareAttention).map((p) => p.number)).toEqual([
      11, 9, 13, 10, 12,
    ]);
  });

  test("without waitingSince the age counts from opening", () => {
    const old = pr({ number: 1, needsMe: true, openedAt: NOW - 9 * HOUR });
    const young = pr({ number: 2, needsMe: true, waitingSince: NOW - 2 * HOUR });
    expect([young, old].sort(compareAttention).map((p) => p.number)).toEqual([1, 2]);
  });
});

describe("lanes", () => {
  test("needs me, else an FYI for me, else background", () => {
    expect(lane(pr({ number: 1, needsMe: true, fyiForMe: true }))).toBe("needs");
    expect(lane(pr({ number: 1, fyiForMe: true }))).toBe("know");
    expect(lane(pr({ number: 1 }))).toBe("background");
  });

  test("all three lanes, even empty", () => {
    expect(attentionView([]).map((l) => [l.lane, l.count, l.items.length])).toEqual([
      ["needs", 0, 0],
      ["know", 0, 0],
      ["background", 0, 0],
    ]);
  });

  test("a lone low-risk PR in the background is shown in place, not as a cluster of one", () => {
    const [, , background] = attentionView([pr({ number: 1 })]);
    expect(show(background!.items)).toEqual(["1/4"]);
  });

  test("an open high-risk PR waiting on someone else never folds", () => {
    const [, , background] = attentionView([
      pr({ number: 1, risk: 3, waitingOn: [{ kind: "person", login: "inescal" }] }),
      pr({ number: 2 }),
      pr({ number: 3 }),
    ]);
    expect(show(background!.items)).toEqual(["1/3", "[2 low-risk changes · 2 other]"]);
  });
});

describe("clusters", () => {
  test("kind: deps, docs, signed by me, else the first tag", () => {
    const signed = { by: "mara-l", byMe: true, counts: true } as PrView["signatures"][number];
    expect(clusterKind(pr({ number: 1, tags: ["tier 1", "deps"] }))).toBe("deps");
    expect(clusterKind(pr({ number: 1, tags: ["docs"], signatures: [signed] }))).toBe("docs");
    expect(clusterKind(pr({ number: 1, tags: ["tier 3"], signatures: [signed] }))).toBe(
      "signed by you",
    );
    expect(
      clusterKind(pr({ number: 1, tags: ["tier 3"], signatures: [{ ...signed, counts: false }] })),
    ).toBe("tier 3");
    expect(clusterKind(pr({ number: 1 }))).toBe("other");
  });

  test("tags in words: size tags are left out, tier-N, protected, unknown ones stay", () => {
    expect(tagWording("tier-2")).toBe("tier 2");
    expect(tagWording("tier 3")).toBe("tier 3");
    expect(tagWording("protected")).toBe("protected paths");
    expect(tagWording("deps-only")).toBe("deps");
    expect(tagWording("ci-config")).toBe("ci-config");
    expect(clusterKind(pr({ number: 1, tags: ["size:s", "tier-2"] }))).toBe("tier 2");
    expect(clusterKind(pr({ number: 1, tags: ["size:xl", "protected"] }))).toBe("protected paths");
    expect(clusterKind(pr({ number: 1, tags: ["size:m", "deps-only", "deps"] }))).toBe("deps");
    expect(clusterKind(pr({ number: 1, tags: ["size:l"] }))).toBe("other");
  });

  test("a subtitle from real policy tags reads in words and never prints a raw size", () => {
    const tags = [
      ["size:s", "docs"],
      ["size:s", "docs"],
      ["size:l", "protected"],
      ["size:s", "tier-2"],
      ["size:xl", "tier-2"],
      ["size:s"],
    ];
    const c = cluster(
      "x",
      tags.map((t, i) => pr({ number: i + 1, tags: t })),
    );
    expect(c.subtitle).toBe("2 tier 2 · 2 docs · 1 other · 1 protected paths");
    expect(c.subtitle).not.toContain("size");
  });

  test("at most 4 kinds, then +N more instead of a cut-off word", () => {
    const kinds = ["a", "b", "c", "d", "e", "f"].map((k, i) => ({ kind: k, count: 6 - i }));
    expect(kindNames(kinds, true)).toEqual(["6 a", "5 b", "4 c", "3 d", "+2 more"]);
    expect(kindNames(kinds.slice(0, 4), true)).toEqual(["6 a", "5 b", "4 c", "3 d"]);
    expect(kindNames(kinds, false)).toEqual(["a", "b", "c", "d", "+2 more"]);
    const c = cluster(
      "x",
      ["docs", "deps", "tier-1", "tier-2", "tier-3", "core"].map((t, i) =>
        pr({ number: i + 1, tags: [t] }),
      ),
    );
    expect(c.subtitle).toBe("1 core · 1 tier 3 · 1 tier 2 · 1 tier 1 · +2 more");
    expect(c.kinds).toHaveLength(6);
  });

  test("label, subtitle by count, sums, merged and open, newest first", () => {
    const c = cluster("x", [
      pr({ number: 1, tags: ["tier 1"], lastActivity: { at: NOW - 3 * HOUR, text: "" } }),
      pr({
        number: 2,
        tags: ["deps"],
        state: "merged",
        lastActivity: { at: NOW - HOUR, text: "" },
      }),
      pr({
        number: 3,
        tags: ["deps"],
        diff: { added: 10, removed: 5, files: 1, excluded: { added: 0, removed: 0, files: 0 } },
      }),
    ]);
    expect(c.label).toBe("3 low-risk changes");
    expect(c.subtitle).toBe("2 deps · 1 tier 1");
    expect([c.added, c.removed, c.merged, c.open]).toEqual([12, 7, 1, 2]);
    expect(c.prs.map((p) => p.number)).toEqual([3, 2, 1]);
  });
});

describe("a key that cannot sign", () => {
  /** What the GitHub source makes of a PR that waits on my nod when my key is not enrolled. */
  const blocked = (over: Partial<PrView> & { number: number }) =>
    pr({ needsMe: false, ask: null, waitingOn: [{ kind: "me" }], ...over });
  const asked = (over: Partial<PrView> & { number: number }) =>
    pr({
      needsMe: true,
      ask: { kind: "peer", label: "Sign as peer", then: { outcome: "satisfied" } },
      waitingOn: [{ kind: "me" }],
      ...over,
    });

  test("waitsOnMyKey: an open PR on me without an ask", () => {
    expect(waitsOnMyKey(blocked({ number: 1 }))).toBe(true);
    expect(waitsOnMyKey(asked({ number: 1 }))).toBe(false);
    expect(waitsOnMyKey(blocked({ number: 1, state: "draft" }))).toBe(false);
    expect(waitsOnMyKey(blocked({ number: 1, state: "merged" }))).toBe(false);
    expect(waitsOnMyKey(pr({ number: 1 }))).toBe(false);
  });

  test("it is not folded away: a one-liner, never tier 4, and not selectable", () => {
    expect(tier(blocked({ number: 1 }))).toBe(3);
    expect(tier(blocked({ number: 1, mine: true }))).toBe(3);
    expect(selectable(blocked({ number: 1 }))).toBe(false);
    expect(tier(asked({ number: 1 }))).toBe(1);
    const [needs, , background] = attentionView([
      blocked({ number: 1 }),
      pr({ number: 2 }),
      pr({ number: 3 }),
    ]);
    expect(needs!.count).toBe(0);
    expect(show(background!.items)).toEqual(["1/3", "[2 low-risk changes · 2 other]"]);
  });

  test("the board: the You column says so, and still holds them as cards", () => {
    const prs = [blocked({ number: 1 }), blocked({ number: 2 }), pr({ number: 3 })];
    const [me] = boardView(prs, { me: "mara-l", keyNote: "key not enrolled" });
    expect(me).toMatchObject({ kind: "me", title: "You", note: "key not enrolled", count: 2 });
    expect(show(me!.items)).toEqual(["1/3", "2/3"]);
    const [able] = boardView(prs, { me: "mara-l" });
    expect(able!.note).toBeNull();
    const others = boardView(prs, { me: "mara-l", keyNote: "key not enrolled" }).slice(1);
    expect(others.every((c) => c.note === null)).toBe(true);
  });
});

describe("time buckets", () => {
  test("bucket edges", () => {
    const at = (ms: number) => bucketOf(NOW - ms, UTC);
    expect(at(-5 * MIN)).toBe("hour"); // the future
    expect(at(0)).toBe("hour");
    expect(at(59 * MIN)).toBe("hour");
    expect(at(HOUR)).toBe("today");
    expect(at(14 * HOUR + 20 * MIN)).toBe("today"); // midnight
    expect(at(14 * HOUR + 21 * MIN)).toBe("yesterday");
    expect(at(38 * HOUR + 20 * MIN)).toBe("yesterday");
    expect(at(38 * HOUR + 21 * MIN)).toBe("week");
    expect(at(6 * 24 * HOUR + 14 * HOUR + 20 * MIN)).toBe("week");
    expect(at(6 * 24 * HOUR + 14 * HOUR + 21 * MIN)).toBe("older");
  });

  test("today starts at the viewer's midnight", () => {
    // 23:30 UTC on the 17th is 00:30 on the 18th in UTC+1: today there, yesterday in UTC
    expect(startOfDay(NOW, 60)).toBe(Date.UTC(2026, 10, 17, 23, 0));
    expect(bucketOf(Date.UTC(2026, 10, 17, 23, 30), { now: NOW, utcOffsetMinutes: 60 })).toBe(
      "today",
    );
    expect(bucketOf(Date.UTC(2026, 10, 17, 23, 30), UTC)).toBe("yesterday");
    // just after midnight, the last hour reaches into yesterday
    const early = Date.UTC(2026, 10, 18, 0, 20);
    expect(bucketOf(Date.UTC(2026, 10, 17, 23, 50), { now: early, utcOffsetMinutes: 0 })).toBe(
      "hour",
    );
  });

  test("empty buckets are left out; older PRs get their own buckets", () => {
    const at = (n: number, ms: number) =>
      pr({ number: n, lastActivity: { at: NOW - ms, text: "" } });
    const buckets = chronologicalView(
      [at(1, 3 * 24 * HOUR), at(2, 3 * 24 * HOUR + MIN), at(3, 30 * 24 * HOUR)],
      UTC,
    );
    expect(buckets.map((b) => b.id)).toEqual(["week", "older"]);
    expect(show(buckets[0]!.items)).toEqual(["[2 low-risk changes · 2 other]"]);
    expect(show(buckets[1]!.items)).toEqual(["3/4"]);
  });

  test("a bucket keeps the time order of what is not folded, the cluster goes last", () => {
    const at = (over: Partial<PrView> & { number: number }, min: number) =>
      pr({ ...over, lastActivity: { at: NOW - min * MIN, text: "" } });
    const [bucket] = chronologicalView(
      [
        at({ number: 1 }, 5),
        at({ number: 2, needsMe: true }, 10),
        at({ number: 3 }, 15),
        at({ number: 4, risk: 3 }, 20),
      ],
      UTC,
    );
    expect(show(bucket!.items)).toEqual(["2/1", "4/3", "[2 low-risk changes · 2 other]"]);
  });
});

describe("board", () => {
  test("You, teammates by count, Any teammate, Agents & CI, Merged", () => {
    const columns = boardView(
      [
        pr({ number: 1, waitingOn: [{ kind: "person", login: "inescal" }] }),
        pr({ number: 2, waitingOn: [{ kind: "person", login: "jonas-r" }] }),
        pr({ number: 3, waitingOn: [{ kind: "person", login: "Jonas-R" }] }),
        pr({ number: 4, waitingOn: [{ kind: "anyone", except: "mara-l" }] }),
        pr({ number: 5, waitingOn: [{ kind: "checks" }] }),
        pr({ number: 6, waitingOn: [{ kind: "nothing" }], state: "merged" }),
        pr({ number: 7, waitingOn: [], state: "closed" }),
        pr({ number: 8, waitingOn: [{ kind: "person", login: "mara-l" }] }),
      ],
      { me: "mara-l", people: [{ login: "jonas-r", name: "Jonas Reuter" }] },
    );
    expect(columns.map((c) => [c.id, c.title, c.count])).toEqual([
      ["me", "You", 1],
      ["person:jonas-r", "Jonas", 2],
      ["person:inescal", "inescal", 1],
      ["anyone", "Any teammate", 1],
      ["automation", "Agents & CI", 1],
      ["done", "Merged", 2],
    ]);
  });

  test("empty board: the fixed columns only", () => {
    expect(boardView([], { me: "mara-l" }).map((c) => c.id)).toEqual(["me", "automation", "done"]);
  });
});

describe("hints and summaries", () => {
  test("only tiers 1 and 2 with something to sign get a checkbox", () => {
    const ask = { kind: "peer", label: "Sign as peer", then: { outcome: "satisfied" } } as const;
    expect(selectable(pr({ number: 1, needsMe: true, mine: false, ask }))).toBe(true);
    expect(selectable(pr({ number: 1, needsMe: true, mine: true, risk: 1, ask }))).toBe(true);
    expect(selectable(pr({ number: 1, fyiForMe: true }))).toBe(false);
    expect(selectable(pr({ number: 1, risk: 3 }))).toBe(false);
    expect(selectable(pr({ number: 1 }))).toBe(false);
    // The inbox step: a review requested from me needs me, and there is nothing to sign.
    expect(
      selectable(
        pr({ number: 1, needsMe: true, classifiedBy: "local", waitingOn: [{ kind: "me" }] }),
      ),
    ).toBe(false);
  });

  test("a review requested at the inbox step does not wait on my key", () => {
    const review = { state: "open", ask: null, waitingOn: [{ kind: "me" }] } as const;
    expect(waitsOnMyKey(review)).toBe(true);
    expect(waitsOnMyKey({ ...review, classifiedBy: "local" })).toBe(false);
  });

  test("the inbox scenario: review requests and my stuck PRs need me, by the same tiers", async () => {
    const source = new FakeSource({ clock: new ManualClock(NOW), scenario: "inbox" });
    await source.ready;
    const prs = source.snapshot()!.prs;
    expect(prs.every((p) => p.classifiedBy === "local")).toBe(true);
    // The review requests ask for a GitHub approval; my stuck PRs ask for nothing here.
    expect(prs.filter((p) => p.ask).map((p) => [p.number, p.ask?.kind])).toEqual([
      [512, "approve"],
      [515, "approve"],
    ]);
    expect(prs.filter(selectable).map((p) => p.number)).toEqual([512, 515]);
    const [needs, know, background] = attentionView(prs);
    // A teammate's PR whose review is asked of me (or my team) is tier 1; mine and stuck tier 2.
    expect(show(needs!.items)).toEqual(["515/1", "512/1", "511/2", "509/2"]);
    expect(show(know!.items)).toEqual(["513/3"]);
    // High risk and nobody asked: a one-liner; the rest folded.
    expect(show(background!.items)[0]).toBe("510/3");
    expect(background!.items.at(-1)?.kind).toBe("cluster");
    source.stop();
  });

  test("the oldest wait of what needs me: waitingSince, else the opening", () => {
    expect(oldestWaitingSince([])).toBeNull();
    expect(
      oldestWaitingSince([
        pr({ number: 1, needsMe: true, waitingSince: NOW - 2 * HOUR }),
        pr({ number: 2, needsMe: true, openedAt: NOW - 3 * HOUR }),
        pr({ number: 3, needsMe: false, openedAt: NOW - 9 * HOUR }),
      ]),
    ).toBe(NOW - 3 * HOUR);
    expect(oldestWaitingSince(mockup().prs)).toBe(NOW - 5 * HOUR - 40 * MIN);
  });

  test("merged on their own since a time: merged then, and no nod of mine", () => {
    const mine = { byMe: true } as PrView["signatures"][number];
    const since = NOW - 24 * HOUR;
    expect(
      mergedOnTheirOwn(
        [
          pr({ number: 1, state: "merged", mergedAt: NOW - HOUR }),
          pr({ number: 2, state: "merged", mergedAt: NOW - 30 * HOUR }),
          pr({ number: 3, state: "merged", mergedAt: NOW - HOUR, signatures: [mine] }),
          pr({ number: 4, state: "open" }),
          // The inbox step: a person merged it.
          pr({ number: 5, state: "merged", mergedAt: NOW - HOUR, classifiedBy: "local" }),
        ],
        since,
      ),
    ).toBe(1);
  });
});
