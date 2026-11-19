import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource } from "../../server/fake-source";
import { attentionView } from "../../shared/attention";
import type { Enrolment as SignerKeyEnrolment, JourneyEvent, PrView } from "../../shared/protocol";
import {
  askHeadline,
  checksTag,
  clusterStatus,
  dependencyHints,
  filesSummary,
  fyiSummary,
  fyiWhy,
  journeyDetail,
  keyNoteOf,
  reasonsSummary,
  rowTag,
  signaturePips,
  signaturesSummary,
  slotText,
  statusText,
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
  const key = (enrolment: SignerKeyEnrolment) =>
    ({
      state: "locked",
      key: { fingerprint: "", publicKey: "", location: "", enrolment },
    }) as const;
  test("keyNoteOf: the muted note on the board's You column", () => {
    expect(keyNoteOf(null)).toBeNull();
    expect(keyNoteOf({ state: "no-key" })).toBe("no key yet");
    expect(keyNoteOf(key({ state: "active" }))).toBeNull();
    expect(keyNoteOf(key({ state: "pending", pr: null }))).toBe("key pending");
    expect(keyNoteOf(key({ state: "not-enrolled" }))).toBe("key not enrolled");
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
