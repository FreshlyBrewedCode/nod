/**
 * Which verified nods count for a PR right now (ADR 0001, rule 5) and
 * whether they meet the requirement.
 *
 * A nod counts when its `repo` is this repo, it has an entry for this PR,
 * the entry's `base` is the PR's current base, the entry's `head_sha` or
 * `patch_id` matches the PR now, and its verdict is `approve`. Whether it is
 * a self or a peer nod comes from the signature alone: `reviewer` equal to
 * the PR author (case-insensitive) is self, anyone else enrolled is a peer.
 * Who posted the comment never matters.
 */
import type { NodVerdict } from "./nod.ts";
import type { MissingNod, Requirement } from "./requirement.ts";
import type { RejectedNod, VerifiedNod } from "./sshsig.ts";

/** The PR as the verifier sees it now. */
export interface PullRequestState {
  /** `owner/name`. */
  repo: string;
  number: number;
  /** Login of the PR author (the human whose token the agent used). */
  author: string;
  /** Current base branch. */
  base: string;
  head_sha: string;
  /** Patch-id computed locally against the current base (`""` for an empty diff). */
  patch_id: string;
}

/** The nod's relation to the PR author. */
export type NodRole = "self" | "peer";

/** Why a nod does not count. */
export interface WhyNot {
  code: "signature" | "repo" | "no_entry" | "base" | "stale" | "verdict";
  detail: string;
}

/** One nod and what it means for this PR. */
export interface NodEvaluation {
  /** The (verified, or for signature failures claimed) reviewer; `null` if unreadable. */
  reviewer: string | null;
  role: NodRole | null;
  /** Whether this nod counts toward the requirement. */
  counts: boolean;
  /** What tied the nod to the PR as it is now. */
  matched: "head_sha" | "patch_id" | null;
  why_not: WhyNot | null;
  verdict: NodVerdict | null;
  level: string | null;
  signed_at: string | null;
}

/** Result of {@link evaluateNods}. */
export interface NodsOutcome {
  /** Every nod found, counting ones first. */
  nods: NodEvaluation[];
  satisfied: boolean;
  /** What is still needed; empty when satisfied. */
  missing: MissingNod[];
}

/**
 * Evaluates the verified nods (and lists the rejected ones, which never
 * count) against the PR and its requirement.
 */
export function evaluateNods(input: {
  pr: PullRequestState;
  requirement: Requirement;
  verified: readonly VerifiedNod[];
  rejected?: readonly RejectedNod[];
}): NodsOutcome {
  const { pr, requirement, verified, rejected = [] } = input;
  const rows = verified.map((nod) => evaluateNod(pr, nod));
  for (const r of rejected) {
    rows.push({
      reviewer: r.reviewer,
      role: r.reviewer ? roleOf(r.reviewer, pr.author) : null,
      counts: false,
      matched: null,
      why_not: { code: "signature", detail: r.reason },
      verdict: null,
      level: null,
      signed_at: null,
    });
  }
  rows.sort((a, b) => Number(b.counts) - Number(a.counts));
  const missing = missingNods(pr, requirement, rows);
  return { nods: rows, satisfied: missing.length === 0, missing };
}

/** Evaluates a single verified nod against the PR. */
export function evaluateNod(pr: PullRequestState, nod: VerifiedNod): NodEvaluation {
  const p = nod.payload;
  const row: NodEvaluation = {
    reviewer: p.reviewer,
    role: roleOf(p.reviewer, pr.author),
    counts: false,
    matched: null,
    why_not: null,
    verdict: p.verdict,
    level: p.level,
    signed_at: p.signed_at,
  };
  const no = (code: WhyNot["code"], detail: string): NodEvaluation => ({
    ...row,
    why_not: { code, detail },
  });
  if (p.repo.toLowerCase() !== pr.repo.toLowerCase())
    return no("repo", `nod is for repo ${p.repo}`);
  const entry = p.entries.find((e) => e.pr === pr.number);
  if (!entry) return no("no_entry", "no entry for this PR");
  if (entry.base !== pr.base)
    return no("base", `signed for base ${entry.base}, the PR now targets ${pr.base}`);
  const matched =
    entry.head_sha === pr.head_sha
      ? "head_sha"
      : pr.patch_id !== "" && entry.patch_id === pr.patch_id
        ? "patch_id"
        : null;
  if (!matched) return no("stale", "stale: neither head_sha nor patch_id matches");
  row.matched = matched;
  if (p.verdict !== "approve") return no("verdict", `verdict ${p.verdict}`);
  return { ...row, counts: true };
}

function roleOf(reviewer: string, author: string): NodRole {
  return reviewer.toLowerCase() === author.toLowerCase() ? "self" : "peer";
}

function missingNods(
  pr: PullRequestState,
  req: Requirement,
  rows: readonly NodEvaluation[],
): MissingNod[] {
  const counting = rows.filter((r) => r.counts);
  const nodded = (login: string) =>
    counting.some((r) => r.reviewer?.toLowerCase() === login.toLowerCase());
  const author = pr.author.toLowerCase();
  const missingNamed = req.named.filter((n) => !nodded(n));
  const missing: MissingNod[] = [];
  // A missing named non-author's nod will also be a peer nod (and any nod satisfies self),
  // so the level is only listed when no named nod would cover it.
  if (req.level === "peer" && !counting.some((r) => r.role === "peer")) {
    if (!missingNamed.some((n) => n.toLowerCase() !== author)) missing.push({ kind: "peer" });
  }
  if (req.level === "self" && counting.length === 0 && missingNamed.length === 0) {
    missing.push({ kind: "self", login: pr.author });
  }
  for (const login of missingNamed) missing.push({ kind: "named", login });
  return missing;
}
