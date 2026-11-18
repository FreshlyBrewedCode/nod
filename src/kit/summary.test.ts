import { describe, expect, test } from "bun:test";

import { evaluateNods, type NodEvaluation, type PullRequestState } from "./evaluate.ts";
import type { PolicyResult } from "./policy.ts";
import { named, none, peer, self, strictest } from "./requirement.ts";
import type { VerifiedNod } from "./sshsig.ts";
import {
  buildSummary,
  checkConclusion,
  checkTitle,
  decodeSummary,
  encodeSummary,
  summaryLabels,
  type CheckSummary,
} from "./summary.ts";

const pr: PullRequestState = {
  repo: "acme/widgets",
  number: 6,
  author: "alice",
  base: "main",
  head_sha: "6".repeat(40),
  patch_id: "p".repeat(40),
};

const nod = (reviewer: string): VerifiedNod => ({
  payload: {
    v: 1,
    repo: pr.repo,
    entries: [{ pr: 6, base: "main", head_sha: pr.head_sha, patch_id: pr.patch_id }],
    verdict: "approve",
    level: "review",
    reviewer,
    signed_at: "2026-11-18T18:43:33.000Z",
  },
  payloadLine: "",
});

const policy = (over: Partial<PolicyResult> = {}): PolicyResult => ({
  category: "decide",
  risk: 3,
  requirement: peer,
  fyi: false,
  reasons: [
    { classifier: "paths", tag: "core", risk: 3, detail: "1 file under core/**: core/a.ts" },
  ],
  rules: [],
  errors: [],
  ...over,
});

const summarize = (p: PolicyResult, nods: VerifiedNod[], errors: string[] = []): CheckSummary =>
  buildSummary({
    pr,
    policy: p,
    nods: evaluateNods({ pr, requirement: p.requirement, verified: nods }),
    signers: ["alice", "bob", "carol"],
    errors,
    now: new Date("2026-11-18T19:00:00Z"),
  });

describe("checkTitle and conclusion", () => {
  test("waiting", () => {
    const s = summarize(policy(), []);
    expect(checkTitle(s)).toBe("waiting for a peer nod");
    expect(checkConclusion(s)).toBe("failure");
  });

  test("waiting, with what is there", () => {
    expect(checkTitle(summarize(policy(), [nod("alice")]))).toBe(
      "waiting for a peer nod (have: alice (self))",
    );
  });

  test("nodded", () => {
    const s = summarize(policy(), [nod("alice"), nod("bob"), nod("bob")]);
    expect(checkTitle(s)).toBe("nodded by alice (self), bob (peer)");
    expect(checkConclusion(s)).toBe("success");
  });

  test("named", () => {
    expect(
      checkTitle(summarize(policy({ requirement: strictest(peer, named("carol")) }), [])),
    ).toBe("waiting for a nod from carol");
  });

  test("no nod needed", () => {
    expect(
      checkTitle(summarize(policy({ category: "auto", risk: 0, requirement: none }), [])),
    ).toBe("no nod needed");
    expect(
      checkTitle(summarize(policy({ category: "fyi", risk: 0, requirement: none, fyi: true }), [])),
    ).toBe("no nod needed (FYI)");
  });

  test("a verifier error fails the check even when nodded", () => {
    const s = summarize(
      policy({ requirement: self }),
      [nod("alice")],
      ["could not fetch the base branch"],
    );
    expect(s.satisfied).toBe(false);
    expect(checkConclusion(s)).toBe("failure");
    expect(checkTitle(s)).toBe("verifier error: could not fetch the base branch");
  });

  test("policy errors are recorded but a peer nod still satisfies the raised requirement", () => {
    const s = summarize(policy({ errors: ["tiers: boom"] }), [nod("bob")]);
    expect(s.errors).toEqual([{ source: "policy", message: "tiers: boom" }]);
    expect(checkConclusion(s)).toBe("success");
  });
});

describe("summaryLabels", () => {
  test("category, risk and FYI", () => {
    expect(summaryLabels(summarize(policy({ fyi: true }), []))).toEqual([
      "nod:decide",
      "nod:risk-3",
      "nod:fyi",
    ]);
    expect(summaryLabels(summarize(policy({ category: "fyi", fyi: true, risk: 0 }), []))).toEqual([
      "nod:fyi",
      "nod:risk-0",
    ]);
  });
});

describe("encode and decode", () => {
  test("round trip", () => {
    const s = summarize(policy(), [nod("bob")]);
    const text = encodeSummary(s);
    expect(text).toStartWith("<!-- nod:summary v1 -->\n```json\n{\n");
    expect(decodeSummary(text)).toEqual(s);
    expect(decodeSummary(`Some words first.\r\n\r\n${text.replace(/\n/g, "\r\n")}`)).toEqual(s);
  });

  test("garbage gives null", () => {
    for (const junk of [
      undefined,
      42,
      "",
      "```json\n{}\n```",
      "<!-- nod:summary v1 -->\n```json\n{not json\n```",
      '<!-- nod:summary v1 -->\n```json\n{"v":2}\n```',
      '<!-- nod:summary v1 -->\n```json\n{"v":1,"pr":"6"}\n```',
    ]) {
      expect(decodeSummary(junk)).toBeNull();
    }
  });

  test("stays under the limit by shortening lists", () => {
    const s = summarize(policy(), [nod("bob")]);
    const filler: NodEvaluation = {
      reviewer: "carol",
      role: "peer",
      counts: false,
      matched: null,
      why_not: { code: "no_entry", detail: "no entry for this PR" },
      verdict: "approve",
      level: "review",
      signed_at: "2026-11-18T18:43:33.000Z",
    };
    const huge: CheckSummary = {
      ...s,
      nods: [...s.nods, ...Array.from({ length: 2000 }, () => filler)],
      reasons: Array.from({ length: 2000 }, (_, i) => ({
        classifier: "paths",
        tag: `t${i}`,
        risk: 1 as const,
        detail: "x".repeat(100),
      })),
    };
    const text = encodeSummary(huge);
    expect(text.length).toBeLessThanOrEqual(65_535);
    const back = decodeSummary(text)!;
    expect(back.truncated).toBe(true);
    expect(back.nods.filter((n) => n.counts)).toHaveLength(1);
    expect(back.satisfied).toBe(true);
    expect(back.head_sha).toBe(pr.head_sha);
  });

  test("a tiny limit still gives a decodable summary", () => {
    const s = summarize(policy(), [nod("bob")]);
    const back = decodeSummary(encodeSummary(s, 900));
    expect(back).not.toBeNull();
    expect(back!.truncated).toBe(true);
  });
});
