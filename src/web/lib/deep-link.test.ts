import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource } from "../../server/fake-source";
import { afterwards, asWhat, githubPrUrl, landingOf, whyNotNeeded } from "./deep-link";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const snapshot = new FakeSource({ clock: new ManualClock(NOW) }).snapshot()!;
const { people, prs } = snapshot;
const pr = (n: number) => prs.find((p) => p.number === n)!;

describe("what a deep link lands on", () => {
  test("a PR that needs me", () => {
    const landing = landingOf(
      { view: "pr", repo: "tallyho/fieldbook", number: 482 },
      snapshot,
      NOW,
    );
    expect(landing).toMatchObject({
      kind: "found",
      targets: [{ pr: { number: 482 }, needsMe: true, why: null }],
      missing: [],
    });
  });

  test("a batch: who still needs me, why the others do not, what is not here", () => {
    const landing = landingOf(
      { view: "batch", repo: "TallyHo/Fieldbook", numbers: [482, 479, 999] },
      snapshot,
      NOW,
    );
    if (landing.kind !== "found") throw new Error(landing.kind);
    expect(landing.targets.map((t) => [t.pr.number, t.needsMe, t.why])).toEqual([
      [482, true, null],
      [479, false, "you signed it already"],
    ]);
    expect(landing.missing).toEqual([999]);
  });

  test("a link for another repo", () => {
    expect(landingOf({ view: "pr", repo: "acme/widgets", number: 12 }, snapshot, NOW)).toEqual({
      kind: "other-repo",
      repo: "acme/widgets",
      here: "tallyho/fieldbook",
    });
    expect(githubPrUrl("acme/widgets", 12)).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("an unclassified PR is named as such", () => {
    const first = new FakeSource({
      clock: new ManualClock(NOW),
      scenario: "first-run",
    }).snapshot()!;
    const n = first.unclassified[0]!.number;
    const landing = landingOf({ view: "pr", repo: first.repo, number: n }, first, NOW);
    expect(landing).toMatchObject({ kind: "found", targets: [], unclassified: [{ number: n }] });
  });
});

describe("why a PR does not need me", () => {
  test("merged, closed, signed already, waits on someone else", () => {
    const merged = prs.find((p) => p.state === "merged")!;
    expect(whyNotNeeded(merged, people, NOW)).toMatch(/^merged .* ago$/);
    expect(whyNotNeeded({ ...pr(482), state: "closed", ask: null }, people, NOW)).toBe(
      "closed without merging",
    );
    expect(whyNotNeeded(pr(482), people, NOW)).toBeNull();
    const waits = prs.find((p) => !p.ask && p.state === "open" && !p.mine && !p.signatures.length);
    if (waits) expect(whyNotNeeded(waits, people, NOW)).not.toBeNull();
  });
});

describe("the request box", () => {
  test("by role, and what happens afterwards", () => {
    expect(asWhat([pr(482), pr(476)])).toBe("#482 as peer, #476 as owner");
    expect(afterwards([pr(482), pr(476)], people)).toBe("Both can merge afterwards.");
    expect(afterwards([pr(482)], people)).toBe("It can merge afterwards.");
    expect(afterwards([pr(485)], people)).toBe("It still waits on Jonas.");
  });
});
