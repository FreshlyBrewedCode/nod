/**
 * Which verified nods and GitHub approvals count for a PR right now
 * (ADR 0001, rule 5; ADR 0006) and whether they meet the requirement.
 *
 * A nod counts when its `repo` is this repo, it has an entry for this PR,
 * the entry's `base` is the PR's current base, the entry's `head_sha` or
 * `patch_id` matches the PR now, and its verdict is `approve`. Whether it is
 * a self or a peer nod comes from the signature alone: `reviewer` equal to
 * the PR author (case-insensitive) is self, anyone else enrolled is a peer.
 * Who posted the comment never matters.
 *
 * An approval counts when it is the reviewer's latest deciding review, it
 * approves the PR's head commit as it is now, and the reviewer is a human
 * with write access other than the author ({@link evaluateApprovals}). It
 * fills a slot the requirement does not reserve for nods
 * (`peer({ approvals: false })`); see {@link evaluateNods}.
 */
import type { NodVerdict } from "./nod.ts";
import {
  nodsOnlyOf,
  strictest,
  type MissingNod,
  type Requirement,
  type RequirementLevel,
} from "./requirement.ts";
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

/** A review on the PR, as GitHub lists it (`GET /repos/{o}/{r}/pulls/{n}/reviews`). */
export interface PullRequestReview {
  /** The reviewer's login. */
  reviewer: string;
  /** The reviewer's account type: `User`, `Bot`, … */
  reviewerType: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  /** The commit the review was given on. */
  commit_id: string | null;
  submitted_at: string | null;
}

/** Why an approval does not count. */
export interface ApprovalWhyNot {
  code: "author" | "bot" | "stale" | "permission";
  detail: string;
}

/** One GitHub approval and whether it counts for this PR. */
export interface ApprovalEvaluation {
  reviewer: string;
  /** Whether this approval counts toward the requirement. */
  counts: boolean;
  /** The commit it approved. */
  commit_id: string | null;
  submitted_at: string | null;
  why_not: ApprovalWhyNot | null;
}

/** A slot of the requirement that is filled, by whom, and with what. */
export interface FilledSlot {
  /** The level's slot (`self`, `peer`) or a named person's (`named`). */
  slot: "self" | "peer" | "named";
  /** Whose slot, for `named`. */
  login?: string;
  /** Who filled it. */
  reviewer: string;
  /** A signed nod, or a GitHub approval. */
  by: "nod" | "approval";
}

/** Result of {@link evaluateNods}. */
export interface NodsOutcome {
  /** Every nod found, counting ones first. */
  nods: NodEvaluation[];
  /** Every approval passed in, counting ones first (empty when none were). */
  approvals: ApprovalEvaluation[];
  satisfied: boolean;
  /** The slots that are filled, and whether by a nod or an approval. */
  filled: FilledSlot[];
  /** What is still needed; empty when satisfied. */
  missing: MissingNod[];
}

/**
 * Evaluates the verified nods (and lists the rejected ones, which never
 * count) and the GitHub approvals ({@link evaluateApprovals}) against the PR
 * and its requirement.
 *
 * Slots: a `peer` slot is filled by a peer nod or a counting approval, a
 * named person's by their nod or approval, a `self` slot by any nod or any
 * counting approval; a slot the requirement reserves for nods
 * (`requirement.nodsOnly`) only by a nod. A nod is preferred over an
 * approval when both would fill a slot.
 */
export function evaluateNods(input: {
  pr: PullRequestState;
  requirement: Requirement;
  verified: readonly VerifiedNod[];
  rejected?: readonly RejectedNod[];
  /**
   * Without it, approvals play no part (as before ADR 0006): every slot is
   * a nod-only slot, so a verifier that does not read approvals never says
   * an approval would do.
   */
  approvals?: readonly ApprovalEvaluation[];
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
  const approvals = [...(input.approvals ?? [])].sort(
    (a, b) => Number(b.counts) - Number(a.counts),
  );
  const { filled, missing } = fillSlots(
    pr,
    input.approvals ? requirement : strictest(requirement, nodsOnlyAll(requirement)),
    rows,
    approvals,
  );
  return { nods: rows, approvals, satisfied: missing.length === 0, filled, missing };
}

/**
 * Which approvals count (ADR 0006). Per reviewer, only the latest review
 * that approves, requests changes or was dismissed decides (a comment does
 * not change it); it counts when it is `APPROVED` on the PR's head commit,
 * by a human (not a `Bot`) other than the author, with write access to the
 * repo. `canApprove` answers that last question (e.g. from
 * {@link getRepoPermission}); it is only asked for approvals that pass
 * everything else, and a throw makes that approval not count.
 */
export async function evaluateApprovals(input: {
  pr: PullRequestState;
  /** In GitHub's order, oldest first. */
  reviews: readonly PullRequestReview[];
  canApprove: (login: string) => Promise<boolean>;
}): Promise<ApprovalEvaluation[]> {
  const { pr, reviews, canApprove } = input;
  const latest = new Map<string, PullRequestReview>();
  for (const r of reviews) {
    if (!r.reviewer) continue;
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED" && r.state !== "DISMISSED")
      continue;
    const key = r.reviewer.toLowerCase();
    latest.delete(key); // keep insertion order = order of the deciding review
    latest.set(key, r);
  }
  const out: ApprovalEvaluation[] = [];
  for (const r of latest.values()) {
    if (r.state !== "APPROVED") continue;
    const row: ApprovalEvaluation = {
      reviewer: r.reviewer,
      counts: false,
      commit_id: r.commit_id,
      submitted_at: r.submitted_at,
      why_not: null,
    };
    const no = (code: ApprovalWhyNot["code"], detail: string) =>
      out.push({ ...row, why_not: { code, detail } });
    if (r.reviewer.toLowerCase() === pr.author.toLowerCase()) {
      no("author", "the author's own approval");
      continue;
    }
    if (r.reviewerType === "Bot") {
      no("bot", "an approval by a bot");
      continue;
    }
    if (r.commit_id !== pr.head_sha) {
      no(
        "stale",
        r.commit_id
          ? `approved ${r.commit_id.slice(0, 7)}, not the head commit`
          : "approved no known commit",
      );
      continue;
    }
    let allowed: boolean;
    try {
      allowed = await canApprove(r.reviewer);
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      no("permission", `could not check write access: ${why}`);
      continue;
    }
    if (!allowed) {
      no("permission", "no write access to the repository");
      continue;
    }
    out.push({ ...row, counts: true });
  }
  return out;
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

const RANK: Record<RequirementLevel, number> = { none: 0, self: 1, peer: 2 };

/** The same requirement with every slot nod-only. */
function nodsOnlyAll(r: Requirement): Requirement {
  return { level: r.level, named: r.named, nodsOnly: { level: r.level, named: r.named } };
}

/** Something that fills a slot: a counting nod or a counting approval. */
interface Filler {
  reviewer: string;
  role: NodRole;
  by: "nod" | "approval";
}

function fillSlots(
  pr: PullRequestState,
  req: Requirement,
  nods: readonly NodEvaluation[],
  approvals: readonly ApprovalEvaluation[],
): { filled: FilledSlot[]; missing: MissingNod[] } {
  const author = pr.author.toLowerCase();
  // Nods first, so a nod is preferred over an approval for the same slot.
  const fillers: Filler[] = [
    ...nods
      .filter((n) => n.counts && n.reviewer && n.role)
      .map((n) => ({ reviewer: n.reviewer!, role: n.role!, by: "nod" as const })),
    ...approvals
      .filter((a) => a.counts && a.reviewer.toLowerCase() !== author)
      .map((a) => ({ reviewer: a.reviewer, role: "peer" as const, by: "approval" as const })),
  ];
  const nodsOnly = nodsOnlyOf(req);

  // The level's slots: one when the part only nods fill is as high, else the
  // level with approvals and, below it, the nod-only level.
  const levels: Array<{ kind: "self" | "peer"; nodOnly: boolean }> = [];
  if (RANK[nodsOnly.level] >= RANK[req.level]) {
    if (nodsOnly.level !== "none") levels.push({ kind: nodsOnly.level, nodOnly: true });
  } else {
    levels.push({ kind: req.level as "self" | "peer", nodOnly: false });
    if (nodsOnly.level !== "none") levels.push({ kind: nodsOnly.level, nodOnly: true });
  }
  // Named slots. The author can only nod their own PR, so theirs is nod-only too.
  const nodNamed = new Set(nodsOnly.named.map((n) => n.toLowerCase()));
  const people = [...req.named, ...nodsOnly.named].filter(
    (n, i, all) => all.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i,
  );
  const namedSlots = people.map((login) => ({
    login,
    nodOnly: nodNamed.has(login.toLowerCase()) || login.toLowerCase() === author,
  }));

  const allowed = (f: Filler, nodOnly: boolean) => f.by === "nod" || !nodOnly;
  const filled: FilledSlot[] = [];
  const missing: MissingNod[] = [];

  const openNamed = namedSlots.filter((s) => {
    const f = fillers.find(
      (x) => x.reviewer.toLowerCase() === s.login.toLowerCase() && allowed(x, s.nodOnly),
    );
    if (f) filled.push({ slot: "named", login: s.login, reviewer: f.reviewer, by: f.by });
    return !f;
  });

  const levelFilled: FilledSlot[] = [];
  for (const l of levels) {
    const fits = (f: Filler) => allowed(f, l.nodOnly) && (l.kind === "self" || f.role === "peer");
    const candidates = fillers.filter(fits);
    // For self, the author's own nod first: it is the prompter attesting.
    const f =
      (l.kind === "self" && candidates.find((x) => x.reviewer.toLowerCase() === author)) ||
      candidates[0];
    if (f) {
      levelFilled.push({ slot: l.kind, reviewer: f.reviewer, by: f.by });
      continue;
    }
    // A named person who still has to act also fills this slot when what
    // they must give fits it: a nod always does, an approval only a slot
    // that takes approvals (and a peer slot only from someone but the author).
    const covered = openNamed.some(
      (s) => (s.nodOnly || !l.nodOnly) && (l.kind === "self" || s.login.toLowerCase() !== author),
    );
    if (!covered)
      missing.push(
        l.kind === "peer"
          ? { kind: "peer", approval: !l.nodOnly }
          : { kind: "self", login: pr.author, approval: !l.nodOnly },
      );
  }
  for (const s of openNamed) missing.push({ kind: "named", login: s.login, approval: !s.nodOnly });
  return { filled: [...levelFilled, ...filled], missing };
}
