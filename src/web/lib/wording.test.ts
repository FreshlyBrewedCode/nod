import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource } from "../../server/fake-source";
import { attentionView } from "../../shared/attention";
import type { JourneyEvent, PrView } from "../../shared/protocol";
import {
  actWord,
  askHeadline,
  checksTag,
  clusterStatus,
  dependencyHints,
  filesSummary,
  fyiSummary,
  fyiWhy,
  journeyDetail,
  journeySummary,
  keyNoteOf,
  localNeed,
  neededFromYou,
  ownPrHint,
  reasonsSummary,
  reviewLines,
  reviewsSummary,
  riskWords,
  rowTag,
  signaturePips,
  signaturesSummary,
  slotText,
  statusText,
  mergerOf,
  thenText,
  whoOf,
} from "./wording";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const snapshot = new FakeSource({ clock: new ManualClock(NOW) }).snapshot()!;
const { people, me } = snapshot;
const pr = (n: number) => snapshot.prs.find((p) => p.number === n)!;

describe("the board's pips", () => {
  const pips = (n: number) => signaturePips(pr(n), me, people).map((p) => `${p.label}:${p.tone}`);
  test("one per slot: signed, mine to fill, someone else's, stale", () => {
    expect(pips(482)).toEqual(["+1:me"]);
    expect(pips(485)).toEqual(["J:open", "+1:me"]);
    expect(pips(476)).toEqual(["J:ok", "M:me"]);
    expect(pips(491)).toEqual(["!:stale"]);
    expect(pips(479)).toEqual(["M:ok", "I:open"]);
    expect(pips(487)).toEqual([]);
  });
});

describe("rows", () => {
  test("who: you, or the prompter's first name", () => {
    expect(whoOf(pr(485), people)).toBe("Jonas");
    expect(whoOf(pr(490), people)).toBe("you");
  });

  test("the one tag", () => {
    expect(rowTag(pr(485))).toEqual({ text: "migration", tone: "plain" });
    expect(rowTag(pr(476))).toEqual({ text: "core", tone: "plain" });
    expect(rowTag(pr(491))).toEqual({ text: "changed since you signed", tone: "bad" });
    expect(rowTag(pr(492))).toEqual({ text: "dependency", tone: "plain" });
    expect(rowTag({ ask: null, tags: [] })).toBeNull();
  });

  test("checks on one-liners", () => {
    expect(checksTag(pr(493))).toEqual({ text: "1 check failing", tone: "bad" });
    expect(checksTag(pr(478))).toEqual({ text: "checks running", tone: "plain" });
    expect(checksTag(pr(482))).toBeNull();
    expect(checksTag(pr(489))).toBeNull();
  });

  test("an FYI's reason to care", () => {
    expect(fyiWhy(pr(478).fyi!)).toBe("test commands change");
    expect(fyiWhy(pr(480).fyi!)).toBe("module SDK surface changed");
  });

  test("the status of what wants nothing from me", () => {
    expect(statusText(pr(479), people)).toBe("waits on Ines");
    expect(statusText(pr(493), people)).toBe("agent is fixing it");
    expect(statusText(pr(483), people)).toBe("merging");
    expect(statusText(pr(481), people)).toBe("checks running");
    expect(statusText(pr(492), people)).toBe("waits on Jonas");
    expect(statusText(pr(489), people)).toBe("merged");
  });

  test("the background cluster's status", () => {
    const background = attentionView(snapshot.prs)[2]!;
    const cluster = background.items.find((i) => i.kind === "cluster")!;
    expect(cluster.kind === "cluster" && clusterStatus(cluster)).toBe("4 merged · 3 open");
    expect(clusterStatus({ merged: 0, open: 2 })).toBe("2 open");
  });

  test("dependency hints", () => {
    expect(dependencyHints(pr(482))).toEqual(["needs #485 first"]);
    expect(dependencyHints(pr(485))).toEqual(["needs #492 first", "unblocks #482"]);
    expect(dependencyHints(pr(490))).toEqual([]);
  });
});

describe("the panel", () => {
  test("what is needed from me, and what happens then", () => {
    expect(askHeadline(pr(476))).toBe("Sign as owner of core/auth");
    expect(askHeadline(pr(482))).toBe("Sign as peer");
    expect(askHeadline(pr(491))).toBe("Sign again, content changed");
    expect(askHeadline(pr(488))).toBe("Self-attest");
    expect(thenText(pr(476).ask!, people)).toBe("Then the check turns green and the agent merges.");
    expect(thenText(pr(485).ask!, people)).toBe("Then it still waits on Jonas.");
  });

  test("before the repo requires the check, a person merges (ADR 0006)", () => {
    const shared = { ...pr(476), requirement: { ...pr(476).requirement, enforced: false } };
    expect(mergerOf(pr(476))).toBe("agent");
    expect(mergerOf(shared)).toBe("person");
    expect(thenText(shared.ask!, people, mergerOf(shared))).toBe(
      "Then the check turns green and it is ready to merge.",
    );
  });

  test("section summaries", () => {
    expect(reasonsSummary(pr(476))).toBe("2 reasons");
    expect(signaturesSummary(pr(476))).toBe("1 of 2");
    expect(signaturesSummary(pr(489))).toBe("none needed");
    expect(fyiSummary(pr(476).fyi!, people, me)).toBe("Ines has seen it");
    expect(fyiSummary(pr(480).fyi!, people, me)).toBe("nobody yet");
    expect(filesSummary(pr(476))).toBe("7 changed · checks green");
    expect(filesSummary(pr(493))).toBe("3 changed · checks not green");
  });

  test("signature slots", () => {
    const p = pr(476);
    const [prompter, owner] = p.requirement.slots;
    expect(slotText(prompter!, p.signatures[0]!, people, me, NOW, 0)).toEqual({
      who: "Jonas, as prompter",
      detail:
        "signed 5e0a91c today 08:50. Rebased since; the patch-id is unchanged, so it still counts.",
    });
    expect(slotText(owner!, null, people, me, NOW, 0)).toEqual({
      who: "You, as owner of core/auth",
      detail: "missing",
    });
    const peer = pr(482).requirement.slots[0]!;
    expect(slotText(peer, null, people, me, NOW, 0).who).toBe("Anyone but Jonas, as peer");
    const stale = pr(491).requirement.slots[0]!;
    expect(slotText(stale, pr(491).signatures[0]!, people, me, NOW, 0).detail).toBe(
      "signed before, but the content changed",
    );
  });

  test("a slot filled by a GitHub approval says so (ADR 0006)", () => {
    const base = pr(482);
    const approved = {
      ...base,
      requirement: {
        ...base.requirement,
        slots: [{ ...base.requirement.slots[0]!, state: "ok" as const, approval: "inescal" }],
      },
    };
    const slot = approved.requirement.slots[0]!;
    expect(slotText(slot, null, people, me, NOW, 0)).toEqual({
      who: "Anyone but Jonas, as peer",
      detail: "approved on GitHub by Ines",
    });
    const [pip] = signaturePips(approved, me, people);
    expect(pip).toMatchObject({ tone: "ok", title: "Peer: approved on GitHub" });
  });

  test("journey steps: the detail, else how long now, else the clock", () => {
    const e = (over: Partial<JourneyEvent>): JourneyEvent => ({
      kind: "waiting",
      text: "x",
      detail: null,
      at: null,
      phase: "done",
      tone: "plain",
      ...over,
    });
    expect(journeyDetail(e({ detail: "needs 2 people" }), NOW, 0)).toBe("needs 2 people");
    expect(journeyDetail(e({ phase: "now", at: NOW - 5 * 3_600_000 }), NOW, 0)).toBe("5h");
    expect(journeyDetail(e({ at: Date.UTC(2026, 10, 17, 16, 12) }), NOW, 0)).toBe("16:12");
    expect(journeyDetail(e({ phase: "next" }), NOW, 0)).toBe("");
  });
});

describe("a key that cannot sign", () => {
  const locked = {
    state: "locked",
    key: { fingerprint: "", publicKey: "", location: "" },
  } as const;
  test("keyNoteOf: the muted note on the board's You column", () => {
    expect(keyNoteOf(null, null)).toBeNull();
    expect(keyNoteOf({ state: "no-key" }, null)).toBe("no key yet");
    expect(keyNoteOf(locked, { state: "active" })).toBeNull();
    expect(keyNoteOf(locked, { state: "pending", pr: null })).toBe("key pending");
    expect(keyNoteOf(locked, { state: "not-enrolled" })).toBe("key not enrolled");
  });

  test("statusText says it waits on me once the key is enrolled", () => {
    const waiting = {
      ...pr(482),
      needsMe: false,
      ask: null,
      waitingOn: [{ kind: "me" }],
    } as PrView;
    expect(statusText(waiting, people)).toBe("waits on you, once your key is enrolled");
  });
});

describe("journeySummary", () => {
  const event = (over: Partial<JourneyEvent>): JourneyEvent => ({
    kind: "waiting",
    text: "Waiting on you",
    phase: "now",
    tone: "plain",
    at: null,
    detail: null,
    ...over,
  });
  test("is the present step, lower case, with its small text", () => {
    const events = [
      event({ kind: "opened", text: "Opened", phase: "done" }),
      event({ detail: "6h" }),
    ];
    expect(journeySummary(events, 0, 0)).toBe("waiting on you, 6h");
  });
  test("without a small text it is the step alone", () => {
    expect(journeySummary([event({})], 0, 0)).toBe("waiting on you");
  });
  test("a journey without a present step ends on its last", () => {
    expect(journeySummary([event({ text: "Merged", phase: "done" })], 0, 0)).toBe("merged");
    expect(journeySummary([], 0, 0)).toBe("");
  });
});

describe("riskWords", () => {
  test("says the level when the brief does not", () => {
    expect(riskWords(3, "Touches core/auth/session.ts.")).toBe("high risk");
    expect(riskWords(1, null)).toBe("low risk");
  });
  test("is silent when the brief starts with it", () => {
    expect(riskWords(3, "High. Touches core/auth/session.ts.")).toBeNull();
    expect(riskWords(2, "  medium: money math")).toBeNull();
  });
  test("a different level in the text is still said", () => {
    expect(riskWords(3, "Low in theory, but…")).toBe("high risk");
  });
});

describe("neededFromYou", () => {
  test("is the ask's headline as a sentence", () => {
    const needing = snapshot.prs.find((p) => p.ask?.kind === "owner")!;
    expect(neededFromYou(needing)).toMatch(/^Needed from you: sign as owner/);
    expect(neededFromYou(needing)!.endsWith(".")).toBe(true);
  });
  test("is null without an ask", () => {
    expect(neededFromYou(snapshot.prs.find((p) => !p.ask)!)).toBeNull();
  });
});

describe("the inbox step (classified locally)", () => {
  const source = new FakeSource({ clock: new ManualClock(NOW), scenario: "inbox" });
  const inbox = async () => {
    await source.ready;
    const snap = source.snapshot()!;
    return (n: number) => snap.prs.find((p) => p.number === n)!;
  };

  test("what a row says it needs of me, and where the panel sends me", async () => {
    const at = await inbox();
    // A review request asks for an approval: the ask is the row's button, no local need.
    expect(at(512).ask?.kind).toBe("approve");
    expect(localNeed(at(512), people, me)).toBeNull();
    // A server without approvals: the review request still links to GitHub.
    expect(localNeed({ ...at(512), ask: null }, people, me)).toMatchObject({
      row: "review requested",
      headline: "Review requested from you",
      action: "Review on GitHub",
      href: `${at(512).url}/files`,
    });
    expect(localNeed({ ...at(515), ask: null }, people, me)?.headline).toBe(
      "Review requested from your team",
    );
    expect(localNeed(at(509), people, me)).toMatchObject({
      row: "needs changes",
      headline: "Changes requested by Jonas",
      action: "Open on GitHub",
      href: at(509).url,
    });
    expect(localNeed(at(511), people, me)).toMatchObject({
      row: "merge conflict",
      headline: "Conflicts with main",
    });
    // Nothing needed of me, or a policy's PR: no local need.
    expect(localNeed(at(514), people, me)).toBeNull();
    expect(localNeed(pr(482), people, me)).toBeNull();
  });

  test("the row's tag is never a size, and the status names the stuck reason", async () => {
    const at = await inbox();
    expect(at(512).tags[0]).toBe("size:l");
    expect(rowTag(at(512))).toBeNull();
    expect(rowTag(at(515))).toEqual({ text: "protected", tone: "plain" });
    expect(statusText(at(514), people)).toBe("waits on Jonas");
    expect(statusText(at(507), people)).toBe("approved");
    // Not "once your key is enrolled": a review needs no key.
    expect(statusText({ ...at(512), needsMe: false }, people)).toBe("waits on you");
  });

  test("the panel says who classified it, and GitHub's reviews", async () => {
    const at = await inbox();
    expect(reasonsSummary(at(512))).toBe("2 reasons · classified by your nod");
    expect(reasonsSummary(pr(482))).not.toContain("your nod");
    expect(reviewsSummary(at(507).review)).toBe("1 approved");
    expect(reviewsSummary(at(511).review)).toBe("1 requested");
    expect(reviewsSummary(at(516).review)).toBe("none yet");
    expect(reviewLines(at(515).review!, people, me)).toEqual([
      { who: "Team tallyho/core", detail: "review requested; you are in it", tone: "open" },
    ]);
    expect(reviewLines(at(509).review!, people, me)).toEqual([
      { who: "Jonas", detail: "requested changes", tone: "bad" },
    ]);
  });
});

describe("GitHub approvals (ADR 0006)", () => {
  const source = new FakeSource({ clock: new ManualClock(NOW), scenario: "inbox" });
  const inbox = async () => {
    await source.ready;
    const snap = source.snapshot()!;
    return (n: number) => snap.prs.find((p) => p.number === n)!;
  };

  test("the panel's headline and what follows: the inbox step, a set-up repo", async () => {
    const at = await inbox();
    expect(askHeadline(at(512))).toBe("Your review is requested");
    expect(neededFromYou(at(512))).toBe("Your review is requested.");
    expect(thenText(at(512).ask!, people, "local")).toBe("Then it is ready to merge.");
    expect(mergerOf(at(512))).toBe("local");
    const approve = { kind: "approve", label: "Approve", then: { outcome: "satisfied" } } as const;
    expect(askHeadline({ ...pr(482), ask: approve })).toBe("Approve as peer");
    expect(askHeadline({ ...pr(476), ask: approve })).toBe("Approve as owner of core/auth");
    expect(thenText(approve, people)).toBe("Then the check turns green and the agent merges.");
    expect(
      thenText(
        { ...approve, then: { outcome: "waits", on: [{ kind: "person", login: "jonas-r" }] } },
        people,
      ),
    ).toBe("Then it still waits on Jonas.");
  });

  test("the verb of a selection: approve when its asks are approvals", async () => {
    const at = await inbox();
    expect(actWord([at(512), at(515)])).toBe("approve");
    expect(actWord([pr(482)])).toBe("sign");
    expect(actWord([])).toBe("sign");
  });

  test("my own open PR without a key says GitHub does not let me approve it", async () => {
    const at = await inbox();
    expect(ownPrHint(at(519), false)).toMatch(/^GitHub does not let you approve your own/);
    // A key that signs here, a teammate's PR, a draft, a merged one: nothing to say.
    expect(ownPrHint(at(519), true)).toBeNull();
    expect(ownPrHint(at(514), false)).toBeNull();
    expect(ownPrHint(at(518), false)).toBeNull();
    expect(ownPrHint({ ...at(519), state: "merged" }, false)).toBeNull();
  });
});
