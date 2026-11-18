/**
 * The machine-readable result of one verifier run. The verifier writes it
 * into the `nod` check run's `output.text`; the local app reads it from
 * there and never runs repo code itself.
 */
import type { Finding, Risk } from "./classifiers/types.ts";
import type { NodEvaluation, NodsOutcome, PullRequestState } from "./evaluate.ts";
import type { Category, PolicyResult } from "./policy.ts";
import { describeMissing, type MissingNod, type Requirement } from "./requirement.ts";

/** Something that went wrong in a run. Verifier errors fail the check; policy errors already failed safe. */
export interface SummaryError {
  source: "policy" | "verifier";
  message: string;
}

/** Version 1 of the check summary. Fields only get added within a version. */
export interface CheckSummary {
  v: 1;
  repo: string;
  pr: number;
  author: string;
  base: string;
  head_sha: string;
  patch_id: string;
  category: Category;
  risk: Risk;
  fyi: boolean;
  requirement: Requirement;
  /** Findings, highest risk first. */
  reasons: Finding[];
  /** Every nod found on the PR and whether it counts. */
  nods: NodEvaluation[];
  /** The requirement is met and the verifier had no error: the check is `success`. */
  satisfied: boolean;
  missing: MissingNod[];
  /** Logins enrolled in `.nod/allowed_signers` on the base branch. */
  signers: string[];
  errors: SummaryError[];
  /** ISO time of the run. */
  generated_at: string;
  /** Set when lists were shortened to fit the check run's text limit. */
  truncated?: boolean;
}

/** Assembles the summary from the parts of a verifier run. */
export function buildSummary(input: {
  pr: PullRequestState;
  policy: PolicyResult;
  nods: NodsOutcome;
  signers: readonly string[];
  /** Verifier errors (e.g. a failed fetch). Any of them makes the check fail. */
  errors?: readonly string[];
  now?: Date;
}): CheckSummary {
  const { pr, policy, nods, signers, errors = [], now = new Date() } = input;
  const allErrors: SummaryError[] = [
    ...policy.errors.map((message) => ({ source: "policy" as const, message })),
    ...errors.map((message) => ({ source: "verifier" as const, message })),
  ];
  return {
    v: 1,
    repo: pr.repo,
    pr: pr.number,
    author: pr.author,
    base: pr.base,
    head_sha: pr.head_sha,
    patch_id: pr.patch_id,
    category: policy.category,
    risk: policy.risk,
    fyi: policy.fyi,
    requirement: { level: policy.requirement.level, named: [...policy.requirement.named] },
    reasons: policy.reasons,
    nods: nods.nods,
    satisfied: nods.satisfied && errors.length === 0,
    missing: nods.missing,
    signers: [...signers],
    errors: allErrors,
    generated_at: now.toISOString(),
  };
}

/** The only two conclusions the verifier uses: `neutral` and `skipped` would pass a required check. */
export function checkConclusion(summary: CheckSummary): "success" | "failure" {
  return summary.satisfied ? "success" : "failure";
}

/**
 * The check run title, e.g. "waiting for a peer nod", "nodded by alice
 * (self), bob (peer)" or "no nod needed".
 */
export function checkTitle(summary: CheckSummary): string {
  const verifierError = summary.errors.find((e) => e.source === "verifier");
  if (verifierError) return clip(`verifier error: ${verifierError.message}`);
  const by = nodders(summary.nods);
  if (summary.satisfied) {
    if (summary.requirement.level === "none" && summary.requirement.named.length === 0) {
      return summary.category === "fyi" ? "no nod needed (FYI)" : "no nod needed";
    }
    return clip(`nodded by ${by}`);
  }
  return clip(`waiting for ${describeMissing(summary.missing)}${by ? ` (have: ${by})` : ""}`);
}

/** Display-only labels for the PR: `nod:auto|decide|fyi`, `nod:risk-N`, and `nod:fyi` for an FYI that also needs a nod. */
export function summaryLabels(summary: CheckSummary): string[] {
  const labels = [`nod:${summary.category}`, `nod:risk-${summary.risk}`];
  if (summary.fyi && summary.category !== "fyi") labels.push("nod:fyi");
  return labels;
}

/** GitHub's limit for a check run's `output.text`. */
export const CHECK_TEXT_LIMIT = 65_535;

const MARKER = "<!-- nod:summary v1 -->";

/**
 * Encodes the summary for `output.text`: a marker comment and a fenced JSON
 * block. When it would exceed {@link CHECK_TEXT_LIMIT}, the lists are
 * shortened step by step (non-counting nods and low reasons go first) and
 * `truncated` is set.
 */
export function encodeSummary(summary: CheckSummary, limit = CHECK_TEXT_LIMIT): string {
  const wrap = (json: string) => `${MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`;
  const pretty = wrap(JSON.stringify(summary, null, 2));
  if (pretty.length <= limit) return pretty;
  const counting = summary.nods.filter((n) => n.counts);
  const attempts: CheckSummary[] = [
    { ...summary, truncated: true },
    {
      ...summary,
      truncated: true,
      reasons: summary.reasons.slice(0, 50),
      nods: [...counting, ...others(summary, 20)],
    },
    {
      ...summary,
      truncated: true,
      reasons: summary.reasons.slice(0, 10).map(shortReason),
      nods: counting.slice(0, 50),
    },
    {
      ...summary,
      truncated: true,
      reasons: [],
      nods: counting.slice(0, 20),
      signers: summary.signers.slice(0, 50),
    },
  ];
  for (const s of attempts) {
    const text = wrap(JSON.stringify(s));
    if (text.length <= limit) return text;
  }
  return wrap(JSON.stringify({ ...attempts[3]!, nods: [], errors: summary.errors.slice(0, 5) }));
}

/** Reads a summary back from `output.text`. Returns `null` for anything that is not a v1 summary. */
export function decodeSummary(text: unknown): CheckSummary | null {
  if (typeof text !== "string") return null;
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(text.slice(at + MARKER.length).replace(/\r/g, ""));
  if (!m) return null;
  let value: unknown;
  try {
    value = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  return isSummary(value) ? value : null;
}

function isSummary(v: unknown): v is CheckSummary {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const req = s.requirement as Record<string, unknown> | null | undefined;
  return (
    s.v === 1 &&
    typeof s.repo === "string" &&
    typeof s.pr === "number" &&
    typeof s.author === "string" &&
    typeof s.base === "string" &&
    typeof s.head_sha === "string" &&
    typeof s.patch_id === "string" &&
    (s.category === "auto" || s.category === "decide" || s.category === "fyi") &&
    typeof s.risk === "number" &&
    typeof req === "object" &&
    req !== null &&
    typeof req.level === "string" &&
    Array.isArray(req.named) &&
    Array.isArray(s.reasons) &&
    Array.isArray(s.nods) &&
    typeof s.satisfied === "boolean" &&
    Array.isArray(s.missing) &&
    Array.isArray(s.signers) &&
    Array.isArray(s.errors)
  );
}

/** The nods that count, as "alice (self), bob (peer)", one per reviewer. */
export function nodders(nods: readonly NodEvaluation[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of nods) {
    if (!n.counts || !n.reviewer || seen.has(n.reviewer.toLowerCase())) continue;
    seen.add(n.reviewer.toLowerCase());
    out.push(`${n.reviewer} (${n.role})`);
  }
  return out.join(", ");
}

function others(summary: CheckSummary, max: number): NodEvaluation[] {
  return summary.nods.filter((n) => !n.counts).slice(0, max);
}

function shortReason(f: Finding): Finding {
  return { ...f, detail: f.detail.slice(0, 120) };
}

function clip(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
