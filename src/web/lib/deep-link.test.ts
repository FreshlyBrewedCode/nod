import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource, setupStatus } from "../../server/fake-source";
import type { RepoInfo, Snapshot } from "../../shared/protocol";
import { repoKey } from "../../shared/repo-key";
import { afterwards, asWhat, githubPrUrl, landingOf, webUrlOf, whyNotNeeded } from "./deep-link";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const snapshot = new FakeSource({ clock: new ManualClock(NOW) }).snapshot()!;
const { people, prs } = snapshot;
const pr = (n: number) => prs.find((p) => p.number === n)!;
const repo = (name: string, host = "github.com"): RepoInfo => ({
  key: repoKey(host, name),
  name,
  github: { host, webUrl: `https://${host}` },
  setup: setupStatus("ready", null),
  enrolment: { state: "active" },
});
const GH = [repo("tallyho/fieldbook")];
const GHE = [repo("tallyho/fieldbook", "acme.ghe.com")];
/** The same data set on acme.ghe.com: every PR keyed by that host. */
const onGhe: Snapshot = {
  ...snapshot,
  prs: prs.map((p) => ({ ...p, repo: GHE[0]!.key })),
};

describe("what a deep link lands on", () => {
  test("a PR that needs me", () => {
    const landing = landingOf(
      { view: "pr", host: "github.com", repo: "tallyho/fieldbook", number: 482 },
      snapshot,
      NOW,
      GH,
    );
    expect(landing).toMatchObject({
      kind: "found",
      targets: [{ pr: { number: 482 }, needsMe: true, why: null }],
      missing: [],
    });
  });

  test("a batch: who still needs me, why the others do not, what is not here", () => {
    const landing = landingOf(
      { view: "batch", host: "github.com", repo: "TallyHo/Fieldbook", numbers: [482, 479, 999] },
      snapshot,
      NOW,
      GH,
    );
    if (landing.kind !== "found") throw new Error(landing.kind);
    expect(landing.targets.map((t) => [t.pr.number, t.needsMe, t.why])).toEqual([
      [482, true, null],
      [479, false, "you signed it already"],
    ]);
    expect(landing.missing).toEqual([999]);
  });

  test("a link for another repo", () => {
    expect(
      landingOf(
        { view: "pr", host: "github.com", repo: "acme/widgets", number: 12 },
        snapshot,
        NOW,
        GH,
      ),
    ).toEqual({
      kind: "other-repo",
      repo: "acme/widgets",
      here: ["tallyho/fieldbook"],
      webUrl: "https://github.com",
    });
    expect(githubPrUrl("https://github.com", "acme/widgets", 12)).toBe(
      "https://github.com/acme/widgets/pull/12",
    );
  });

  test("the same owner/name on another host is another repository, both ways", () => {
    // A github.com link (no host) opened on a server that reads acme.ghe.com.
    expect(
      landingOf(
        { view: "pr", host: "github.com", repo: "tallyho/fieldbook", number: 482 },
        snapshot,
        NOW,
        GHE,
      ),
    ).toEqual({
      kind: "other-repo",
      repo: "tallyho/fieldbook",
      here: ["acme.ghe.com/tallyho/fieldbook"],
      webUrl: "https://github.com",
    });
    // An acme.ghe.com link opened on a github.com server.
    expect(
      landingOf(
        { view: "pr", host: "acme.ghe.com", repo: "tallyho/fieldbook", number: 482 },
        snapshot,
        NOW,
        GH,
      ),
    ).toMatchObject({
      kind: "other-repo",
      repo: "acme.ghe.com/tallyho/fieldbook",
      webUrl: "https://acme.ghe.com",
    });
    // The right host and repo: found, as on github.com.
    expect(
      landingOf(
        { view: "pr", host: "acme.ghe.com", repo: "TallyHo/fieldbook", number: 482 },
        onGhe,
        NOW,
        GHE,
      ),
    ).toMatchObject({ kind: "found", targets: [{ pr: { number: 482 } }] });
  });

  test("many repos: the link's repo among them, and only its PRs (ADR 0007)", () => {
    const both = [GH[0]!, GHE[0]!];
    const mixed: Snapshot = { ...snapshot, prs: [...prs, ...onGhe.prs] };
    const found = landingOf(
      { view: "pr", host: "acme.ghe.com", repo: "tallyho/fieldbook", number: 482 },
      mixed,
      NOW,
      both,
    );
    if (found.kind !== "found") throw new Error(found.kind);
    expect(found.repo.key).toBe("acme.ghe.com/tallyho/fieldbook");
    expect(found.targets.map((t) => t.pr.repo)).toEqual(["acme.ghe.com/tallyho/fieldbook"]);
    expect(
      landingOf({ view: "pr", host: "github.com", repo: "a/b", number: 1 }, mixed, NOW, both),
    ).toMatchObject({
      kind: "other-repo",
      here: ["tallyho/fieldbook", "acme.ghe.com/tallyho/fieldbook"],
    });
  });

  test("a host's web UI", () => {
    expect(webUrlOf("acme.ghe.com")).toBe("https://acme.ghe.com");
    expect(webUrlOf("git.example.test:8443")).toBe("https://git.example.test:8443");
    expect(githubPrUrl("https://acme.ghe.com", "mona_acme/x", 3)).toBe(
      "https://acme.ghe.com/mona_acme/x/pull/3",
    );
  });

  test("an unclassified PR is named as such", () => {
    const first = new FakeSource({
      clock: new ManualClock(NOW),
      scenario: "first-run",
    }).snapshot()!;
    const n = first.unclassified[0]!.number;
    const landing = landingOf(
      { view: "pr", host: "github.com", repo: "tallyho/fieldbook", number: n },
      first,
      NOW,
      GH,
    );
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

  test("GitHub approvals: no patch-id needed, said as approvals", () => {
    const approve = { kind: "approve", label: "Approve", then: { outcome: "satisfied" } } as const;
    const a = { ...pr(482), ask: approve, patchId: null };
    expect(whyNotNeeded(a, people, NOW)).toBeNull();
    expect(asWhat([a])).toBe("An approval on GitHub for #482");
    expect(asWhat([a, { ...pr(476), ask: approve }])).toBe("Approvals on GitHub for #482, #476");
  });
});
