/**
 * From one PR as GraphQL returns it, plus the verifier's decoded summary, to
 * the `PrFacts` that `view.ts` turns into the user's view model. Pure.
 *
 * The verifier is the single source of truth: category, risk, requirement,
 * reasons and which nods count all come from its `CheckSummary` on the PR
 * head. This module never classifies. A PR without a readable summary is
 * shown as what it is ("not classified yet", "verifier error"), with high
 * risk and no slot to fill, never as a low-risk change.
 *
 * What does come from GitHub directly: title, brief, diff stats (lockfiles
 * and generated files left out, as the kit's `diffStat` does), the other
 * checks, FYI acks (👀 reactions), the journey and the last activity.
 */

import { decodePayload, parseNodComments, type NodPayload } from "../../kit/nod.ts";
import type { NodEvaluation } from "../../kit/evaluate.ts";
import type { CheckSummary } from "../../kit/summary.ts";
import { DEPENDENCY_LOCKFILES } from "../../kit/classifiers/dependencies.ts";
import { DIFF_SIZE_IGNORE } from "../../kit/classifiers/diff-size.ts";
import { matchAny } from "../../kit/classifiers/glob.ts";
import { RISK_NAMES, type Finding } from "../../kit/classifiers/types.ts";
import type {
  Checks,
  DiffStats,
  FileChange,
  Fyi,
  JourneyEvent,
  Login,
  PrState,
  Reason,
  Signature,
  Slot,
  UnclassifiedPr,
} from "../../shared/protocol";
import { sameLogin, type PrFacts } from "../view";
import { parseBody } from "./brief";
import type { RawCheckRun, RawContext, RawPr } from "./queries";

/** The name of the verifier's check run (ADR 0001, rule 9). */
export const NOD_CHECK = "nod";
/** The app that creates the `nod` check in Actions mode (ADR 0003). */
export const NOD_CHECK_APP = "github-actions";
/** The FYI ack (concept decision 6): a 👀 reaction on the PR. */
export const ACK_REACTION = "eyes";

/** What the verifier said about the PR's head. */
export type SummaryRead =
  | { readonly kind: "ok"; readonly summary: CheckSummary }
  /** No `nod` check run on the head yet. */
  | { readonly kind: "none" }
  /** A `nod` check run whose output holds no v1 summary. */
  | { readonly kind: "unreadable"; readonly title: string | null }
  /** A summary, but for another base than the PR's current one: the verifier runs again. */
  | { readonly kind: "outdated"; readonly summary: CheckSummary };

export interface MapContext {
  readonly repo: string;
  readonly defaultBranch: string;
  /** The verifier's word on this head. */
  readonly summary: SummaryRead;
  /** Computed locally (ADR 0001 rule 6); null until known. */
  readonly patchId: string | null;
  /** Open PRs by head branch: a base that is one of them is a stacked PR. */
  readonly headBranches: ReadonlyMap<string, number>;
  readonly epicTitles: ReadonlyMap<number, string>;
  /** The humans who should notice an FYI: the enrolled signers, plus me. */
  readonly team: ReadonlyArray<Login>;
  readonly me: Login | null;
}

export interface Mapped {
  readonly facts: PrFacts;
  /** null when the verifier's summary was read; else why the PR is not classified. */
  readonly unclassified: UnclassifiedPr["reason"] | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** The latest `nod` check run on the head, from the verifier's app. */
export function nodCheckRun(pr: RawPr, app = NOD_CHECK_APP): RawCheckRun | null {
  const runs = contexts(pr).filter(
    (c): c is RawCheckRun =>
      c.__typename === "CheckRun" && c.name === NOD_CHECK && c.checkSuite?.app?.slug === app,
  );
  return runs.sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}

function contexts(pr: RawPr): RawContext[] {
  const commit = pr.commits.nodes[0]?.commit;
  return (commit?.statusCheckRollup?.contexts.nodes ?? []).filter(
    (c): c is RawContext => c !== null,
  );
}

/** The verifier's own workflow (its job checks say nothing beyond `nod`). */
const isNodWorkflow = (c: RawCheckRun) =>
  /\/workflows\/nod\.ya?ml$/.test(c.checkSuite?.workflowRun?.workflow?.resourcePath ?? "");

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** The repo's CI on the head, without `nod` and the verifier's own job. */
export function ciChecks(pr: RawPr): Checks {
  const latest = new Map<string, { ok: boolean; pending: boolean; failed: boolean }>();
  const runs: Array<{
    name: string;
    at: number;
    state: { ok: boolean; pending: boolean; failed: boolean };
  }> = [];
  for (const c of contexts(pr)) {
    if (c.__typename === "CheckRun") {
      if (c.name === NOD_CHECK || isNodWorkflow(c)) continue;
      const pending = c.status !== "COMPLETED";
      const failed = !pending && FAILED.has(c.conclusion ?? "");
      runs.push({
        name: c.name,
        at: ms(c.completedAt) ?? ms(c.startedAt) ?? 0,
        state: { ok: !pending && !failed, pending, failed },
      });
    } else {
      const s = c.state;
      runs.push({
        name: c.context,
        at: ms(c.createdAt) ?? 0,
        state: {
          ok: s === "SUCCESS",
          pending: s === "PENDING" || s === "EXPECTED",
          failed: s === "FAILURE" || s === "ERROR",
        },
      });
    }
  }
  // The same check twice (a re-run, two suites): the latest says it.
  runs.sort((a, b) => a.at - b.at);
  for (const r of runs) latest.set(r.name, r.state);
  const all = [...latest.entries()];
  const failing = all.filter(([, s]) => s.failed).map(([n]) => n);
  const total = all.length;
  const passed = all.filter(([, s]) => s.ok).length;
  const state: Checks["state"] =
    total === 0
      ? "none"
      : failing.length
        ? "failing"
        : all.some(([, s]) => s.pending)
          ? "pending"
          : "passing";
  return { state, passed, total, failing };
}

/** Diff stats and the file list, lockfiles and generated files left out (concept decision 13). */
export function diffOf(pr: RawPr): { diff: DiffStats; files: FileChange[] | null } {
  const nodes = pr.files?.nodes ?? [];
  const files: FileChange[] = nodes.map((f) => ({
    path: f.path,
    added: f.additions,
    removed: f.deletions,
    area: null,
    excluded: matchAny(DEPENDENCY_LOCKFILES, f.path)
      ? "lockfile"
      : matchAny(DIFF_SIZE_IGNORE, f.path)
        ? "generated"
        : null,
  }));
  const ex = files.filter((f) => f.excluded !== null);
  const excluded = {
    added: ex.reduce((n, f) => n + f.added, 0),
    removed: ex.reduce((n, f) => n + f.removed, 0),
    files: ex.length,
  };
  const complete = pr.files !== null && nodes.length >= pr.files.totalCount;
  // Past the list's cap the totals come from the PR, minus what we know is excluded.
  const diff: DiffStats = {
    added: Math.max(0, pr.additions - excluded.added),
    removed: Math.max(0, pr.deletions - excluded.removed),
    files: Math.max(0, (complete ? files.length : pr.changedFiles) - excluded.files),
    excluded,
  };
  return { diff, files: pr.files === null ? null : files };
}

function stateOf(pr: RawPr): PrState {
  if (pr.state === "MERGED" || pr.merged) return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.isDraft ? "draft" : "open";
}

/** A nod comment as posted, not verified: only for display (SHAs, batch size, link). */
interface PostedNod {
  readonly payload: NodPayload;
  readonly url: string;
  readonly at: number;
}

function postedNods(pr: RawPr): PostedNod[] {
  const out: PostedNod[] = [];
  for (const c of pr.comments.nodes) {
    if (!c || !c.body.includes("```nod")) continue;
    for (const block of parseNodComments(c.body)) {
      const decoded = decodePayload(block.payloadLine);
      if (decoded.ok && decoded.payload.entries.some((e) => e.pr === pr.number))
        out.push({ payload: decoded.payload, url: c.url, at: ms(c.createdAt) ?? 0 });
    }
  }
  return out;
}

const whyText = (n: NodEvaluation): string | null => {
  const w = n.why_not;
  if (!w) return null;
  switch (w.code) {
    case "stale":
      return "content changed since";
    case "base":
      return "base changed";
    case "signature":
      return /signature invalid/i.test(w.detail) ? "key not enrolled" : w.detail;
    default:
      return w.detail;
  }
};

const ROLE_LEVEL = { self: "self", peer: "peer" } as const;

/** Signatures from the summary, enriched from the comments; plus nods posted after the run. */
function signaturesOf(
  pr: RawPr,
  summary: CheckSummary | null,
  headSha: string,
  patchId: string | null,
  author: Login,
): { signatures: Omit<Signature, "byMe">[]; evaluated: NodEvaluation[] } {
  const posted = postedNods(pr);
  const used = new Set<PostedNod>();
  const signatures: Omit<Signature, "byMe">[] = [];
  const evaluated: NodEvaluation[] = [];
  for (const n of summary?.nods ?? []) {
    const match = posted.find(
      (p) =>
        !used.has(p) &&
        sameLogin(p.payload.reviewer, n.reviewer) &&
        (n.signed_at === null || p.payload.signed_at === n.signed_at),
    );
    if (match) used.add(match);
    const entry = match?.payload.entries.find((e) => e.pr === pr.number);
    signatures.push({
      by: n.reviewer ?? "unknown",
      level: n.role ? ROLE_LEVEL[n.role] : sameLogin(n.reviewer, author) ? "self" : "peer",
      at: ms(n.signed_at) ?? match?.at ?? 0,
      headSha: entry?.head_sha ?? "",
      patchId: entry?.patch_id ?? "",
      matchedBy: n.matched,
      counts: n.counts,
      why: n.counts ? null : whyText(n),
      batchSize: match?.payload.entries.length ?? 1,
      commentUrl: match?.url ?? null,
    });
    evaluated.push(n);
  }
  // Posted after the verifier's last run: shown at once, counted once it ran.
  const ranAt = ms(summary?.generated_at) ?? 0;
  for (const p of posted) {
    if (used.has(p) || p.at <= ranAt) continue;
    const entry = p.payload.entries.find((e) => e.pr === pr.number)!;
    const matchedBy =
      entry.head_sha === headSha
        ? ("head_sha" as const)
        : patchId && entry.patch_id === patchId
          ? ("patch_id" as const)
          : null;
    signatures.push({
      by: p.payload.reviewer,
      level: sameLogin(p.payload.reviewer, author) ? "self" : "peer",
      at: ms(p.payload.signed_at) ?? p.at,
      headSha: entry.head_sha,
      patchId: entry.patch_id,
      matchedBy,
      counts: false,
      why: "being verified",
      batchSize: p.payload.entries.length,
      commentUrl: p.url,
    });
  }
  return { signatures, evaluated };
}

/**
 * The requirement's slots from the summary, filled the way the kit's
 * `evaluateNods` counts: any counting nod fills the prompter's slot, a
 * counting peer nod the peer slot, a named person's nod their slot. A slot
 * none fills but whose candidate's nod went stale is `stale` (re-attest).
 * A slot the summary says a GitHub approval filled (`filled`, ADR 0006) is
 * `ok` with `approval` set; one the policy keeps for nods has `nodsOnly`.
 */
function slotsOf(summary: CheckSummary, nods: readonly NodEvaluation[], author: Login): Slot[] {
  const index = (pred: (n: NodEvaluation) => boolean, prefer?: Login | null) => {
    const hits = nods.map((n, i) => [n, i] as const).filter(([n]) => pred(n));
    const preferred = prefer ? hits.find(([n]) => sameLogin(n.reviewer, prefer)) : undefined;
    return (preferred ?? hits[0])?.[1] ?? null;
  };
  const stale = (n: NodEvaluation) => !n.counts && n.why_not?.code === "stale";
  const { level, named } = summary.requirement;
  const nodsOnly = summary.requirement.nodsOnly ?? { level: "none", named: [] };
  const nodNamed = (login: Login) => nodsOnly.named.some((l) => sameLogin(l, login));
  const filledSlots = summary.filled ?? [];
  // The approval the verifier says fills a slot (it lists a nod first when both do).
  const approvedBy = (kind: "self" | "peer" | "named", login: Login | null): Login | null => {
    const f = filledSlots.find(
      (x) => x.slot === kind && (kind !== "named" || sameLogin(x.login ?? null, login)),
    );
    return f?.by === "approval" ? f.reviewer : null;
  };
  const slot = (
    role: Slot["role"],
    label: string,
    who: Login | null,
    except: Login | null,
    filled: (n: NodEvaluation) => boolean,
    candidate: (n: NodEvaluation) => boolean,
    approval: Login | null,
    onlyNods: boolean,
  ): Slot => {
    const base = { role, label, who, except, ...(onlyNods ? { nodsOnly: true } : {}) };
    const ok = index((n) => n.counts && filled(n), who);
    if (ok !== null) return { ...base, state: "ok", signature: ok };
    if (approval) return { ...base, state: "ok", signature: null, approval };
    const old = index((n) => stale(n) && candidate(n));
    return old !== null
      ? { ...base, state: "stale", signature: old }
      : { ...base, state: "missing", signature: null };
  };
  const slots: Slot[] = [];
  const namedAuthor = named.some((l) => sameLogin(l, author));
  const byAuthor = (n: NodEvaluation) => sameLogin(n.reviewer, author);
  // `self` is met by any counting nod (or approval); the author named by name only by their own nod.
  // A peer level that takes approvals with a nod-only self below it shows both slots.
  const selfSlot = level === "self" || (level === "peer" && nodsOnly.level === "self");
  if (selfSlot || namedAuthor)
    slots.push(
      slot(
        "prompter",
        "Prompter",
        author,
        null,
        namedAuthor ? byAuthor : () => true,
        byAuthor,
        namedAuthor || nodsOnly.level !== "none" ? null : approvedBy("self", null),
        namedAuthor || nodsOnly.level !== "none",
      ),
    );
  if (level === "peer")
    slots.push(
      slot(
        "peer",
        "Peer",
        null,
        author,
        (n) => n.role === "peer",
        (n) => n.role === "peer",
        nodsOnly.level === "peer" ? null : approvedBy("peer", null),
        nodsOnly.level === "peer",
      ),
    );
  for (const login of named) {
    if (sameLogin(login, author)) continue;
    slots.push(
      slot(
        "owner",
        `Named: ${login}`,
        login,
        null,
        (n) => sameLogin(n.reviewer, login),
        (n) => sameLogin(n.reviewer, login),
        nodNamed(login) ? null : approvedBy("named", login),
        nodNamed(login),
      ),
    );
  }
  // The verifier's verdict wins over our reading of it.
  if (summary.satisfied) return slots.map((s) => (s.state === "ok" ? s : { ...s, state: "ok" }));
  return slots;
}

function requirementLabel(summary: CheckSummary, author: Login): string {
  const { level, named } = summary.requirement;
  const parts: string[] = [];
  if (level === "self") parts.push("Prompter self-attest");
  if (level === "peer") parts.push("Another human (not the prompter)");
  for (const n of named) parts.push(sameLogin(n, author) ? "the prompter by name" : `named: ${n}`);
  return parts.length ? parts.join(" + ") : "None (auto-merge)";
}

const reasonOf = (f: Finding): Reason => ({
  classifier: f.classifier,
  fact: f.detail || f.tag,
  effect: f.risk === undefined ? `tag ${f.tag}` : `risk ${RISK_NAMES[f.risk]}`,
  raises: (f.risk ?? 0) > 0,
});

const QUIET_TAGS = new Set(["declared:risk", "epic", "depends-on"]);

function tagsOf(summary: CheckSummary): string[] {
  const out: string[] = [];
  if (summary.errors.some((e) => e.source === "verifier")) out.push("verifier error");
  const sorted = [...summary.reasons].sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1));
  for (const f of sorted) if (!QUIET_TAGS.has(f.tag) && !out.includes(f.tag)) out.push(f.tag);
  return out;
}

function fyiOf(
  pr: RawPr,
  summary: CheckSummary,
  team: readonly Login[],
  author: Login,
): Fyi | null {
  if (!summary.fyi && summary.category !== "fyi") return null;
  const declared = summary.reasons.find((f) => f.tag === "fyi" && f.classifier === "declared");
  const fyiLine = (pr.body ?? "")
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[\s>*+-]+/, "")
        .replace(/\*\*|__/g, "")
        .trim(),
    )
    .find((l) => /^fyi\s*:\s*\S/i.test(l));
  const policyReason = summary.reasons.find((f) => f.tag !== "fyi");
  const reason = declared
    ? `declared by author${fyiLine ? `: ${fyiLine.replace(/^fyi\s*:\s*/i, "")}` : ""}`
    : `policy: ${policyReason?.detail ?? policyReason?.tag ?? "FYI rule"}`;
  const acked: Login[] = [];
  for (const r of pr.reactions.nodes) {
    const login = r?.user?.login;
    if (login && !acked.some((a) => sameLogin(a, login))) acked.push(login);
  }
  const pending = team.filter(
    (l, i) =>
      !sameLogin(l, author) &&
      !acked.some((a) => sameLogin(a, l)) &&
      team.findIndex((x) => sameLogin(x, l)) === i,
  );
  return { reason, source: declared ? "declared" : "policy", acked, pending };
}

const event = (
  kind: JourneyEvent["kind"],
  text: string,
  at: number,
  detail: string | null = null,
  tone: JourneyEvent["tone"] = "plain",
): JourneyEvent => ({ kind, text, detail, at, phase: "done", tone });

interface Push {
  readonly at: number;
  readonly commits: number;
  readonly force: boolean;
}

/** Commits after the PR was opened, grouped into pushes; force pushes and base changes. */
function pushesOf(
  pr: RawPr,
  openedAt: number,
): { pushes: Push[]; bases: Array<{ at: number; to: string }> } {
  const pushes: Push[] = [];
  const bases: Array<{ at: number; to: string }> = [];
  let pending: { at: number; commits: number; force: boolean } | null = null;
  const flush = () => {
    if (pending) pushes.push(pending);
    pending = null;
  };
  for (const item of pr.timelineItems.nodes) {
    if (!item) continue;
    if (item.__typename === "PullRequestCommit") {
      const at = ms(item.commit.committedDate) ?? 0;
      if (at <= openedAt + 60_000 && !pending) continue; // the commits it was opened with
      if (pending?.force && pending.commits === 0) {
        pending.commits = 1;
        pending.at = Math.max(pending.at, at);
        continue;
      }
      if (pending && !pending.force && Math.abs(at - pending.at) < 10 * 60_000) {
        pending.commits++;
        pending.at = Math.max(pending.at, at);
        continue;
      }
      flush();
      pending = { at, commits: 1, force: false };
    } else if (item.__typename === "HeadRefForcePushedEvent") {
      flush();
      pending = { at: ms(item.createdAt) ?? 0, commits: 0, force: true };
    } else if (item.__typename === "BaseRefChangedEvent") {
      flush();
      bases.push({ at: ms(item.createdAt) ?? 0, to: item.currentRefName });
    }
  }
  flush();
  return { pushes, bases };
}

/** Everything about one PR, ready for `toViews`. */
export function mapPr(pr: RawPr, ctx: MapContext): Mapped {
  const author = pr.author?.login ?? "ghost";
  const state = stateOf(pr);
  const openedAt = ms(pr.createdAt) ?? 0;
  const mergedAt = ms(pr.mergedAt);
  const closedAt = ms(pr.closedAt);
  const parsed = parseBody(pr.body, author);
  const { diff, files } = diffOf(pr);
  const checks = ciChecks(pr);
  const mine = sameLogin(author, ctx.me);
  const summary = ctx.summary.kind === "ok" ? ctx.summary.summary : null;
  const { signatures, evaluated } = signaturesOf(pr, summary, pr.headRefOid, ctx.patchId, author);
  const isLive = state === "open" || state === "draft";

  // -- the verifier's word, or an honest "not yet" --------------------------
  let unclassified: Mapped["unclassified"] = null;
  let category: PrFacts["category"] = "decide";
  let risk: PrFacts["risk"] = 3;
  let tags: string[];
  let reasons: Reason[];
  let requirement: PrFacts["requirement"];
  let fyi: Fyi | null = null;
  if (summary) {
    category = summary.category;
    risk = summary.risk;
    tags = isLive ? tagsOf(summary) : tagsOf(summary).filter((t) => t !== "verifier error");
    reasons = [
      ...summary.errors.map((e) => ({
        classifier: e.source === "verifier" ? "verifier" : "policy",
        fact: e.message,
        effect: e.source === "verifier" ? "the check fails until it runs cleanly" : "failed safe",
        raises: true,
      })),
      ...summary.reasons.map(reasonOf),
    ];
    requirement = {
      policy: summary.reasons[0]?.tag ?? summary.requirement.level,
      label: requirementLabel(summary, author),
      slots: slotsOf(summary, evaluated, author),
      enforced: summary.enforcement.enforced,
    };
    fyi = fyiOf(pr, summary, ctx.team, author);
    if (isLive && summary.errors.some((e) => e.source === "verifier"))
      unclassified = "verifier-error";
  } else if (!isLive) {
    // Merged or closed before the verifier wrote a summary we can read: nobody
    // can act on it, so it is a plain quiet item, not an error.
    category = "auto";
    risk = 0;
    tags = [];
    reasons = [];
    requirement = { policy: "none", label: "No summary recorded", slots: [] };
  } else {
    const r = ctx.summary;
    unclassified = r.kind === "unreadable" ? "verifier-error" : "pending";
    const fact =
      r.kind === "unreadable"
        ? `the nod check has no readable summary${r.title ? ` (“${r.title}”)` : ""}`
        : r.kind === "outdated"
          ? `the summary is for base ${r.summary.base}; the verifier runs again for ${pr.baseRefName}`
          : "the verifier has not run on this head yet";
    tags = [r.kind === "unreadable" ? "verifier error" : "not classified"];
    reasons = [
      { classifier: "nod", fact, effect: "treated as high risk until it has", raises: true },
    ];
    requirement = {
      policy: "not-classified",
      label: r.kind === "unreadable" ? "Unknown: verifier error" : "Not classified yet",
      slots: [],
    };
  }

  // -- the journey ------------------------------------------------------------
  const { pushes, bases } = pushesOf(pr, openedAt);
  const lastPush = Math.max(0, ...pushes.map((p) => p.at), ...bases.map((b) => b.at));
  const journey: JourneyEvent[] = [
    event("opened", "Opened", openedAt, parsed.agent ?? (mine ? "by you" : null)),
  ];
  for (const p of pushes)
    journey.push(
      p.force
        ? event("rebased", "Force-pushed", p.at, null)
        : event("pushed", p.commits === 1 ? "New commit" : `${p.commits} new commits`, p.at),
    );
  for (const b of bases) journey.push(event("rebased", `Base changed to ${b.to}`, b.at));
  if (summary)
    journey.push(
      event(
        "classified",
        "Classified",
        ms(summary.generated_at) ?? openedAt,
        requirement.slots.length === 0
          ? "auto-merge"
          : `needs ${requirement.slots.length === 1 ? "1 signature" : `${requirement.slots.length} people`}`,
      ),
    );
  signatures.forEach((s) => {
    const who = sameLogin(s.by, ctx.me) ? "You" : s.by;
    journey.push(
      event("nodded", `${who} signed`, s.at, s.batchSize > 1 ? `batch of ${s.batchSize}` : s.level),
    );
    if (!s.counts && s.why === "content changed since") {
      const after = pushes.find((p) => p.at > s.at)?.at ?? lastPush;
      journey.push(
        event("nod-dropped", "Content changed", Math.max(after, s.at), "signature dropped", "bad"),
      );
    }
  });
  for (const r of pr.reactions.nodes) {
    if (!r?.user || !fyi) continue;
    const who = sameLogin(r.user.login, ctx.me) ? "You" : r.user.login;
    journey.push(event("fyi-acked", `${who} got it`, ms(r.createdAt) ?? 0));
  }
  if (state === "open" || state === "draft") {
    const runs = contexts(pr).filter(
      (c): c is RawCheckRun =>
        c.__typename === "CheckRun" && c.name !== NOD_CHECK && !isNodWorkflow(c),
    );
    const doneAt = Math.max(0, ...runs.map((c) => ms(c.completedAt) ?? 0));
    if (checks.state === "failing" && doneAt)
      journey.push(event("checks", "Check failed", doneAt, checks.failing.join(", "), "bad"));
    else if (checks.state === "passing" && doneAt)
      journey.push(event("checks", "Checks green", doneAt));
  }
  const autoAt = ms(pr.autoMergeRequest?.enabledAt);
  if (autoAt !== null && state !== "closed")
    journey.push(event("requested", "Auto-merge on", autoAt));
  if (state === "merged" && mergedAt !== null) journey.push(event("merged", "Merged", mergedAt));
  if (state === "closed" && closedAt !== null) journey.push(event("closed", "Closed", closedAt));
  journey.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  // A verifier re-run is not news for the chronological view; what made it run is.
  const last = journey.filter((e) => e.kind !== "classified").at(-1) ?? journey.at(-1)!;
  const lastActivity = { at: last.at ?? openedAt, text: activityText(last, mine) };

  // -- links ------------------------------------------------------------------
  const dependsOn = new Set(parsed.dependsOn);
  const stackedOn = ctx.headBranches.get(pr.baseRefName);
  if (pr.baseRefName !== ctx.defaultBranch && stackedOn !== undefined) dependsOn.add(stackedOn);
  dependsOn.delete(pr.number);
  const epic =
    parsed.epic === null
      ? null
      : { number: parsed.epic, title: ctx.epicTitles.get(parsed.epic) ?? `#${parsed.epic}` };

  const facts: PrFacts = {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state,
    author,
    prompter: author,
    agent: parsed.agent,
    topic: epic && ctx.epicTitles.has(epic.number) ? epic.title : null,
    category,
    risk,
    tags,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    patchId: ctx.patchId,
    openedAt,
    mergedAt: state === "merged" ? mergedAt : null,
    diff,
    checks,
    requirement,
    signatures,
    reasons,
    fyi,
    brief: parsed.brief,
    epic,
    dependsOn: [...dependsOn].sort((a, b) => a - b),
    journey,
    files,
    lastActivity,
    waitingSince: Math.max(openedAt, lastPush) || openedAt,
  };
  return { facts, unclassified };
}

/** "2 new commits", "you signed", "merged": a row's last activity, from my side. */
function activityText(e: JourneyEvent, mine: boolean): string {
  if (e.kind === "opened") return mine ? "opened by your agent" : "opened";
  if (e.kind === "nodded" || e.kind === "fyi-acked") return e.text.replace(/^You /, "you ");
  const t = e.text.charAt(0).toLowerCase() + e.text.slice(1);
  return e.kind === "checks" && e.tone === "plain" ? "checks turned green" : t;
}
