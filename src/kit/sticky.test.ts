import { describe, expect, test } from "bun:test";

import { evaluateNods, type PullRequestState } from "./evaluate.ts";
import type { PolicyResult } from "./policy.ts";
import { none, peer, self } from "./requirement.ts";
import type { VerifiedNod } from "./sshsig.ts";
import { escapeMd, isStickyComment, prDeepLink, renderSticky, STICKY_MARKER } from "./sticky.ts";
import { buildSummary } from "./summary.ts";

const pr: PullRequestState = {
  repo: "acme/widgets",
  number: 6,
  author: "alice",
  base: "main",
  head_sha: "6".repeat(40),
  patch_id: "p".repeat(40),
};

const nod = (reviewer: string, prNumber = 6): VerifiedNod => ({
  payload: {
    v: 1,
    repo: pr.repo,
    entries: [{ pr: prNumber, base: "main", head_sha: pr.head_sha, patch_id: pr.patch_id }],
    verdict: "approve",
    level: "review",
    reviewer,
    signed_at: "2026-11-18T18:43:33.000Z",
  },
  payloadLine: "",
});

const render = (
  policy: Partial<PolicyResult>,
  nods: VerifiedNod[] = [],
  signers = ["alice", "bob", "carol"],
) => {
  const p: PolicyResult = {
    category: "decide",
    risk: 3,
    requirement: peer,
    fyi: false,
    reasons: [
      { classifier: "paths", tag: "core", risk: 3, detail: "1 file under core/**: core/a_b.ts" },
      { classifier: "declared", tag: "epic", detail: "#1" },
    ],
    rules: [],
    errors: [],
    ...policy,
  };
  const summary = buildSummary({
    pr,
    policy: p,
    nods: evaluateNods({ pr, requirement: p.requirement, verified: nods }),
    signers,
    now: new Date("2026-11-18T19:00:00Z"),
  });
  return renderSticky(summary, { uiBase: "https://ui.example.test/" });
};

describe("renderSticky", () => {
  test("waiting for a peer", () => {
    expect(render({})).toBe(
      [
        STICKY_MARKER,
        "**nod** · decide · risk high · waiting for a peer nod",
        "",
        "- Needs a peer nod from `bob` or `carol`",
        "",
        "<details><summary>Why: 2 reasons</summary>",
        "",
        "- `core` · high · 1 file under core/\\*\\*: core/a\\_b.ts",
        "- `epic` · \\#1",
        "",
        "</details>",
        "",
        "[Open in nod](https://ui.example.test/#/pr/acme/widgets/6) to look and nod. A link never approves by itself.",
        "",
      ].join("\n"),
    );
  });

  test("nodded, with a nod that does not count", () => {
    const text = render({}, [nod("bob"), nod("carol", 2)]);
    expect(text).toContain("**nod** · decide · risk high · nodded by bob \\(peer\\)");
    expect(text).toContain("Nothing more is needed.");
    expect(text).toContain("Nodded: `bob` (peer, head_sha)");
    expect(text).toContain("Not counted: `carol`: no entry for this PR");
  });

  test("self nod wording", () => {
    expect(render({ risk: 1, requirement: self })).toContain(
      "- Needs a nod from `alice` (self) or anyone enrolled",
    );
  });

  test("no peer enrolled yet", () => {
    expect(render({}, [], ["alice"])).toContain("nobody other than the author is enrolled");
  });

  test("auto and FYI are calm one-liners", () => {
    const auto = render({ category: "auto", risk: 0, requirement: none, reasons: [] });
    expect(auto).toContain("No nod needed: this PR may merge on its own.");
    expect(auto).not.toContain("<details>");
    expect(render({ category: "fyi", risk: 0, requirement: none, fyi: true })).toContain(
      "worth knowing about",
    );
  });

  test("errors are shown", () => {
    expect(render({ errors: ["tiers: boom"] })).toContain("> policy error: tiers: boom");
  });

  test("is recognised as the sticky comment", () => {
    expect(isStickyComment(render({}))).toBe(true);
    expect(isStickyComment("hello <!-- nod:sticky -->")).toBe(false);
  });
});

test("escapeMd defuses mentions and markup from PR content", () => {
  expect(escapeMd("@bob [x](javascript:1) <img>")).toBe("@​bob \\[x\\]\\(javascript:1\\) \\<img\\>");
});

test("prDeepLink", () => {
  expect(prDeepLink("https://ui.nod.frebreco.de", "acme/widgets", 12)).toBe(
    "https://ui.nod.frebreco.de/#/pr/acme/widgets/12",
  );
});
