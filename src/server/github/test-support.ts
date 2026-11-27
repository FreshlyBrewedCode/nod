/**
 * Recorded-style fixtures for the GitHub source's tests: PRs in the shape
 * GraphQL returns them, the verifier's summaries, nod comments. Fictional
 * team (alice, bob, carol) and repo (`acme/widgets`).
 */

import { createHash } from "node:crypto";

import type { NodEvaluation } from "../../kit/evaluate.ts";
import { renderNodComment, serializePayload, type NodPayload } from "../../kit/nod.ts";
import type { MissingNod, Requirement } from "../../kit/requirement.ts";
import { encodeSummary, type CheckSummary } from "../../kit/summary.ts";
import type { Finding } from "../../kit/classifiers/types.ts";
import type { RawCheckRun, RawContext, RawPr, RawTimelineItem } from "./queries";

export const REPO = "acme/widgets";
export const ALICE = "alice";
export const BOB = "bob";
export const CAROL = "carol";
/** Now, in the fixtures. */
export const T0 = Date.parse("2026-11-18T12:00:00.000Z");
const MIN = 60_000;

export const iso = (minutesAgo: number) => new Date(T0 - minutesAgo * MIN).toISOString();
export const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

export interface CheckSpec {
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly at?: number;
  readonly workflow?: string;
}

export interface PrSpec {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly author?: string;
  readonly base?: string;
  readonly headRef?: string;
  readonly head?: string;
  readonly state?: RawPr["state"];
  readonly draft?: boolean;
  /** Minutes ago. */
  readonly opened?: number;
  readonly merged?: number;
  readonly files?: ReadonlyArray<readonly [string, number, number]>;
  readonly checks?: ReadonlyArray<CheckSpec>;
  /** The `nod` check run on the head. */
  readonly nodRun?: { readonly id: number; readonly title?: string; readonly at?: number };
  readonly comments?: ReadonlyArray<{
    readonly body: string;
    readonly at: number;
    readonly by?: string;
  }>;
  readonly acks?: ReadonlyArray<readonly [string, number]>;
  readonly timeline?: ReadonlyArray<RawTimelineItem>;
  readonly autoMerge?: number;
  /** Logins, or `org/team` for a team, asked to review. */
  readonly requested?: ReadonlyArray<string>;
  /** Latest deciding reviews: login, state, minutes ago, and the commit (default the head). */
  readonly reviews?: ReadonlyArray<
    readonly [string, "APPROVED" | "CHANGES_REQUESTED", number, string?]
  >;
  readonly mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

function checkRun(c: CheckSpec, n: number): RawCheckRun {
  return {
    __typename: "CheckRun",
    id: `CR_${c.name}_${n}`,
    databaseId: 1000 + n,
    name: c.name,
    status: c.status ?? "COMPLETED",
    conclusion: c.conclusion === undefined ? "SUCCESS" : c.conclusion,
    startedAt: iso((c.at ?? 30) + 2),
    completedAt: (c.status ?? "COMPLETED") === "COMPLETED" ? iso(c.at ?? 30) : null,
    title: null,
    checkSuite: {
      app: { slug: "github-actions" },
      workflowRun: {
        workflow: { resourcePath: `/acme/widgets/actions/workflows/${c.workflow ?? "ci.yml"}` },
      },
    },
  };
}

export function rawPr(spec: PrSpec): RawPr {
  const head = spec.head ?? sha(`head-${spec.number}`);
  const files = spec.files ?? [["src/app.ts", 10, 2]];
  const contexts: RawContext[] = (spec.checks ?? [{ name: "test" }]).map(checkRun);
  contexts.push(checkRun({ name: "verify", workflow: "nod.yml", at: 20 }, 90));
  if (spec.nodRun)
    contexts.push({
      ...checkRun(
        { name: "nod", workflow: "nod.yml", at: spec.nodRun.at ?? 20, conclusion: "FAILURE" },
        0,
      ),
      id: `CR_nod_${spec.nodRun.id}`,
      databaseId: spec.nodRun.id,
      title: spec.nodRun.title ?? null,
    });
  const state = spec.state ?? "OPEN";
  return {
    number: spec.number,
    title: spec.title ?? `change ${spec.number}`,
    body: spec.body ?? "",
    url: `https://github.com/${REPO}/pull/${spec.number}`,
    state,
    isDraft: spec.draft ?? false,
    merged: state === "MERGED",
    mergedAt: spec.merged !== undefined ? iso(spec.merged) : null,
    closedAt: spec.merged !== undefined ? iso(spec.merged) : null,
    createdAt: iso(spec.opened ?? 120),
    updatedAt: iso(10),
    author: { login: spec.author ?? ALICE, name: null },
    baseRefName: spec.base ?? "main",
    headRefName: spec.headRef ?? `agent/change-${spec.number}`,
    headRefOid: head,
    baseRef: { target: { oid: sha("main-tip") } },
    additions: files.reduce((n, f) => n + f[1], 0),
    deletions: files.reduce((n, f) => n + f[2], 0),
    changedFiles: files.length,
    autoMergeRequest: spec.autoMerge !== undefined ? { enabledAt: iso(spec.autoMerge) } : null,
    mergeable: spec.mergeable ?? "MERGEABLE",
    reviewRequests: {
      nodes: (spec.requested ?? []).map((r) => ({
        requestedReviewer: r.includes("/")
          ? { __typename: "Team", combinedSlug: r }
          : { __typename: "User", login: r },
      })),
    },
    latestOpinionatedReviews: {
      nodes: (spec.reviews ?? []).map(([login, state, at, commit]) => ({
        state,
        submittedAt: iso(at),
        author: { login },
        commit: { oid: commit ?? head },
      })),
    },
    files: {
      totalCount: files.length,
      nodes: files.map(([path, additions, deletions]) => ({ path, additions, deletions })),
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            committedDate: iso((spec.opened ?? 120) + 5),
            statusCheckRollup: { state: "SUCCESS", contexts: { nodes: contexts } },
          },
        },
      ],
    },
    comments: {
      totalCount: spec.comments?.length ?? 0,
      nodes: (spec.comments ?? []).map((c, i) => ({
        url: `https://github.com/${REPO}/pull/${spec.number}#issuecomment-${spec.number}0${i}`,
        createdAt: iso(c.at),
        author: { login: c.by ?? ALICE },
        body: c.body,
      })),
    },
    reactions: {
      nodes: (spec.acks ?? []).map(([login, at]) => ({
        createdAt: iso(at),
        user: { login, name: null },
      })),
    },
    timelineItems: {
      nodes: spec.timeline ?? [
        {
          __typename: "PullRequestCommit",
          commit: { oid: head, committedDate: iso((spec.opened ?? 120) + 5) },
        },
        ...(state === "MERGED" && spec.merged !== undefined
          ? [{ __typename: "MergedEvent" as const, createdAt: iso(spec.merged) }]
          : []),
      ],
    },
  };
}

/** A nod evaluation as the verifier writes it into the summary. */
export function nodEval(
  reviewer: string,
  author: string,
  minutesAgo: number,
  how: "head_sha" | "patch_id" | "stale" | "signature" = "head_sha",
): NodEvaluation {
  const counts = how === "head_sha" || how === "patch_id";
  return {
    reviewer,
    role: reviewer.toLowerCase() === author.toLowerCase() ? "self" : "peer",
    counts,
    matched: counts ? how : null,
    why_not:
      how === "stale"
        ? { code: "stale", detail: "stale: neither head_sha nor patch_id matches" }
        : how === "signature"
          ? { code: "signature", detail: "signature invalid: Could not verify signature" }
          : null,
    verdict: how === "signature" ? null : "approve",
    level: how === "signature" ? null : "review",
    signed_at: how === "signature" ? null : iso(minutesAgo),
  };
}

export function summaryFor(
  pr: RawPr,
  s: {
    category?: CheckSummary["category"];
    risk?: CheckSummary["risk"];
    fyi?: boolean;
    requirement?: Requirement;
    reasons?: Finding[];
    nods?: NodEvaluation[];
    approvals?: CheckSummary["approvals"];
    filled?: CheckSummary["filled"];
    enforcement?: CheckSummary["enforcement"];
    satisfied?: boolean;
    missing?: MissingNod[];
    errors?: CheckSummary["errors"];
    base?: string;
    at?: number;
  } = {},
): CheckSummary {
  const requirement = s.requirement ?? { level: "none", named: [] };
  return {
    v: 1,
    repo: REPO,
    pr: pr.number,
    author: pr.author!.login,
    base: s.base ?? pr.baseRefName,
    head_sha: pr.headRefOid,
    patch_id: sha(`patch-${pr.number}`),
    category: s.category ?? (requirement.level === "none" ? "auto" : "decide"),
    risk: s.risk ?? 0,
    fyi: s.fyi ?? false,
    requirement,
    reasons: s.reasons ?? [],
    nods: s.nods ?? [],
    approvals: s.approvals ?? [],
    satisfied: s.satisfied ?? requirement.level === "none",
    filled: s.filled ?? [],
    missing: s.missing ?? [],
    enforcement: s.enforcement ?? { enforced: true, by: "ruleset" },
    signers: [ALICE, BOB, CAROL],
    errors: s.errors ?? [],
    generated_at: iso(s.at ?? 20),
  };
}

/** The `output.text` of a `nod` check run. */
export const summaryText = (s: CheckSummary) => encodeSummary(s);

/** A nod comment as the signer posts it; the signature is a placeholder (never verified here). */
export function nodComment(
  reviewer: string,
  entries: ReadonlyArray<{ pr: number; head_sha: string; patch_id?: string; base?: string }>,
  signedAt: string,
): string {
  const payload: NodPayload = {
    v: 1,
    repo: REPO,
    entries: entries.map((e) => ({
      pr: e.pr,
      base: e.base ?? "main",
      head_sha: e.head_sha,
      patch_id: e.patch_id ?? sha(`patch-${e.pr}`),
    })),
    verdict: "approve",
    level: "review",
    reviewer,
    signed_at: signedAt,
  };
  return renderNodComment(
    serializePayload(payload),
    "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQ==\n-----END SSH SIGNATURE-----\n",
    `**nod** · approve · review · by \`${reviewer}\``,
  );
}
