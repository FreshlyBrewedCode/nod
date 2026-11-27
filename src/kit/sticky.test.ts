import { describe, expect, test } from "bun:test";

import type { Enforcement } from "./enforcement.ts";
import { evaluateNods, type ApprovalEvaluation, type PullRequestState } from "./evaluate.ts";
import type { PolicyResult } from "./policy.ts";
import { named, none, peer, self, strictest } from "./requirement.ts";
import type { VerifiedNod } from "./sshsig.ts";
import {
  batchDeepLink,
  escapeMd,
  isStickyComment,
  prDeepLink,
  renderSticky,
  STICKY_MARKER,
} from "./sticky.ts";
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
  more: { approvals?: ApprovalEvaluation[]; enforcement?: Enforcement } = {},
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
    nods: evaluateNods({
      pr,
      requirement: p.requirement,
      verified: nods,
      approvals: more.approvals ?? [],
    }),
    signers,
    enforcement: more.enforcement,
    now: new Date("2026-11-18T19:00:00Z"),
  });
  return renderSticky(summary, { uiBase: "https://ui.example.test/" });
};

describe("renderSticky", () => {
  test("waiting for a peer", () => {
    expect(render({})).toBe(
      [
        STICKY_MARKER,
        "**nod** · decide · risk high · waiting for a peer approval or nod",
        "",
        "- Needs an approval from anyone with write access but the author, or a peer nod from `bob` or `carol`",
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
      "- Needs a nod from `alice` (self) or anyone enrolled, or an approval from anyone with write access",
    );
    expect(render({ risk: 1, requirement: self({ approvals: false }) })).toContain(
      "- Needs a nod from `alice` (self) or anyone enrolled\n",
    );
  });

  test("no peer enrolled yet", () => {
    expect(render({ requirement: peer({ approvals: false }) }, [], ["alice"])).toContain(
      "nobody other than the author is enrolled",
    );
    expect(render({}, [], ["alice"])).toContain(
      "- Needs an approval from anyone with write access but the author\n",
    );
  });

  test("named wording", () => {
    const text = render({
      requirement: strictest(named("carol"), named("dave", { approvals: false })),
    });
    expect(text).toContain("- Needs an approval or a nod from `carol`");
    expect(text).toContain("- Needs a nod from `dave`");
  });

  test("approvals: counted and not", () => {
    const ok: ApprovalEvaluation = {
      reviewer: "bob",
      counts: true,
      commit_id: pr.head_sha,
      submitted_at: null,
      why_not: null,
    };
    const text = render({}, [], undefined, {
      approvals: [
        ok,
        {
          ...ok,
          reviewer: "mallory",
          counts: false,
          why_not: { code: "permission", detail: "no write access to the repository" },
        },
      ],
    });
    expect(text).toContain("approved by bob");
    expect(text).toContain("Approved on GitHub: `bob`");
    expect(text).toContain("Not counted: `mallory`'s approval: no write access to the repository");
  });

  test("not enforced says so; an assumed enforcement says why", () => {
    const off = render({}, [], undefined, { enforcement: { enforced: false, by: null } });
    expect(off).toContain(
      "Not enforced: `main` does not require the `nod` check, so it never blocks a merge. `nod init --ruleset` makes it required.",
    );
    const unknown = render({}, [], undefined, {
      enforcement: { enforced: true, by: "unknown", detail: "could not look it up: GitHub 500" },
    });
    expect(unknown).toContain("Treated as enforced");
    expect(unknown).toContain("GitHub 500");
    expect(render({})).not.toContain("enforced");
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

test("deep links name the host off github.com, in the sticky comment too", () => {
  expect(prDeepLink("https://ui.example.test", "acme/widgets", 12, "https://acme.ghe.com")).toBe(
    "https://ui.example.test/#/pr/acme.ghe.com/acme/widgets/12",
  );
  expect(prDeepLink("https://ui.example.test", "acme/widgets", 12, "https://github.com")).toBe(
    "https://ui.example.test/#/pr/acme/widgets/12",
  );
  expect(batchDeepLink("https://ui.example.test", "acme/widgets", [1, 2], "git.example.test")).toBe(
    "https://ui.example.test/#/batch/git.example.test/acme/widgets/1,2",
  );
  expect(() => prDeepLink("https://ui.example.test", "acme/widgets", 1, "not a host")).toThrow();
  const summary = buildSummary({
    pr: {
      repo: "acme/widgets",
      number: 2,
      author: "mona_acme",
      base: "main",
      head_sha: "a".repeat(40),
      patch_id: "",
    },
    policy: {
      category: "decide",
      risk: 3,
      requirement: { level: "peer", named: [] },
      fyi: false,
      reasons: [],
      rules: [],
      errors: [],
    },
    nods: { nods: [], approvals: [], satisfied: false, filled: [], missing: [{ kind: "peer" }] },
    signers: [],
  });
  expect(
    renderSticky(summary, { uiBase: "https://ui.example.test", host: "https://acme.ghe.com" }),
  ).toContain("(https://ui.example.test/#/pr/acme.ghe.com/acme/widgets/2)");
});

test("batchDeepLink", () => {
  expect(batchDeepLink("https://ui.nod.frebreco.de/next/", "acme/widgets", [12, 7, 12])).toBe(
    "https://ui.nod.frebreco.de/next/#/batch/acme/widgets/12,7",
  );
  expect(batchDeepLink("https://ui.example.test", "acme/widgets", [3])).toBe(
    "https://ui.example.test/#/batch/acme/widgets/3",
  );
});
