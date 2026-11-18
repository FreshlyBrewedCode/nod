/**
 * The batch dialog's pure parts (concept decision 14, r2 `11`–`14`): which
 * role I sign each PR in, the sentence that sums the batch up, what happens
 * to each PR after my nod, the "not opened" mark, and the dialog's state
 * machine (review → unlock → signing → signed / stale / error).
 *
 * The passphrase is never in here: it goes from the input straight into the
 * one `unlock` request (`components/batch-dialog.tsx`).
 */

import { shortName } from "../../shared/attention";
import type {
  Ask,
  ErrorCode,
  PrView,
  RequestError,
  SignEntry,
  SignResult,
  SignerState,
} from "../../shared/protocol";
import { namesOf, type People } from "./wording";
import { openedKey, type Opened } from "./storage";

export type Role = Ask["kind"];

/** Peer and owner first (someone else's work), then re-attests, then my own. */
export const ROLE_ORDER: ReadonlyArray<Role> = ["peer", "owner", "re-attest", "self"];

// ---------------------------------------------------------------------------
// rows

export interface BatchRow {
  readonly pr: PrView;
  /** What I sign it as; null when it no longer needs me (someone was faster). */
  readonly role: Role | null;
  /** The head I looked at: what the nod covers. */
  readonly headSha: string;
  /** Ticked: part of the batch (a row can be taken out and put back). */
  readonly included: boolean;
  /** Peer or owner work I never opened in the UI (concept 14). */
  readonly notOpened: boolean;
  /** Its head moved after I looked: the server would refuse it as stale. */
  readonly moved: boolean;
  /** Refreshed after a stale refusal: worth a second look. */
  readonly changed: boolean;
  /** Why it cannot be signed now, or null. */
  readonly blocked: "no-ask" | "no-patch-id" | "not-open" | null;
}

/**
 * Whether to mark a row "not opened": it is someone else's work (peer,
 * owner, or a re-attest on a teammate's PR) and I never showed its details
 * in this browser. For a re-attest only an opening after my old signature
 * counts, since the content changed after it. My own work is never marked.
 */
export function isNotOpened(
  pr: Pick<PrView, "number" | "ask" | "mine" | "signatures">,
  opened: Opened,
  repo: string,
): boolean {
  const kind = pr.ask?.kind;
  if (!kind || kind === "self" || (kind === "re-attest" && pr.mine)) return false;
  const at = opened[openedKey(repo, pr.number)];
  if (at === undefined) return true;
  if (kind !== "re-attest") return false;
  const mine = pr.signatures.filter((s) => s.byMe).map((s) => s.at);
  return mine.length > 0 && at < Math.max(...mine);
}

export interface BatchModel {
  /** The PRs in the order they were picked. */
  readonly numbers: ReadonlyArray<number>;
  /** The head of each PR as I looked at it (when the dialog opened, or after "review again"). */
  readonly heads: Readonly<Record<number, string>>;
  readonly removed: ReadonlyArray<number>;
  readonly changed: ReadonlyArray<number>;
}

export function openModel(prs: ReadonlyArray<PrView>, numbers: ReadonlyArray<number>): BatchModel {
  const found = numbers.filter(
    (n, i) => numbers.indexOf(n) === i && prs.some((p) => p.number === n),
  );
  return {
    numbers: found,
    heads: Object.fromEntries(found.map((n) => [n, prs.find((p) => p.number === n)!.headSha])),
    removed: [],
    changed: [],
  };
}

/** Take a row out of the batch, or put it back. */
export function toggleRow(model: BatchModel, pr: number): BatchModel {
  const removed = model.removed.includes(pr)
    ? model.removed.filter((n) => n !== pr)
    : [...model.removed, pr];
  return { ...model, removed };
}

/** "Review again" after a stale refusal: look at the new heads, mark those rows. */
export function reviewAgain(model: BatchModel, stale: ReadonlyArray<StaleEntry>): BatchModel {
  const heads = { ...model.heads };
  for (const s of stale) heads[s.pr] = s.current;
  const changed = [...new Set([...model.changed, ...stale.map((s) => s.pr)])];
  return { ...model, heads, changed };
}

export function batchRows(
  model: BatchModel,
  prs: ReadonlyArray<PrView>,
  context: { readonly opened: Opened; readonly repo: string },
): ReadonlyArray<BatchRow> {
  return model.numbers.flatMap((n): BatchRow[] => {
    const pr = prs.find((p) => p.number === n);
    if (!pr) return [];
    const headSha = model.heads[n] ?? pr.headSha;
    const blocked =
      pr.state !== "open" && pr.state !== "draft"
        ? "not-open"
        : !pr.ask
          ? "no-ask"
          : pr.patchId === null
            ? "no-patch-id"
            : null;
    return [
      {
        pr,
        role: pr.ask?.kind ?? null,
        headSha,
        included: !model.removed.includes(n) && blocked === null,
        notOpened: isNotOpened(pr, context.opened, context.repo),
        moved: pr.headSha !== headSha,
        changed: model.changed.includes(n),
        blocked,
      },
    ];
  });
}

/** What the `sign` request carries: the included rows at the heads I looked at. */
export function entriesOf(rows: ReadonlyArray<BatchRow>): ReadonlyArray<SignEntry> {
  return rows.filter((r) => r.included).map((r) => ({ pr: r.pr.number, head_sha: r.headSha }));
}

export interface RoleGroup {
  /** null: rows that cannot be signed any more, at the end. */
  readonly role: Role | null;
  /** "Jonas's work · you sign as peer", "Your work · you sign as prompter". */
  readonly title: string;
  readonly rows: ReadonlyArray<BatchRow>;
}

const possessive = (name: string) => `${name}’s`;

/** Rows grouped by my role, in `ROLE_ORDER`; inside a group in the order they were picked. */
export function groupByRole(
  rows: ReadonlyArray<BatchRow>,
  people: People,
): ReadonlyArray<RoleGroup> {
  const groups: RoleGroup[] = [];
  for (const role of [...ROLE_ORDER, null]) {
    const inGroup = rows.filter(
      (r) => (r.blocked === "no-ask" || r.blocked === "not-open" ? null : r.role) === role,
    );
    if (inGroup.length)
      groups.push({ role, title: groupTitle(role, inGroup, people), rows: inGroup });
  }
  return groups;
}

function groupTitle(role: Role | null, rows: ReadonlyArray<BatchRow>, people: People): string {
  const authors = [...new Set(rows.map((r) => r.pr.prompter.toLowerCase()))];
  const whose =
    authors.length === 1 ? possessive(shortName(rows[0]!.pr.prompter, people)) : "Teammates’";
  switch (role) {
    case "peer":
      return `${whose} work · you sign as peer`;
    case "owner": {
      const labels = [...new Set(rows.map((r) => ownerLabel(r.pr)))];
      return `${whose} work · you sign as ${labels.length === 1 ? labels[0] : "owner"}`;
    }
    case "re-attest":
      return "Changed since you signed · you sign again";
    case "self":
      return "Your work · you sign as prompter";
    case null:
      return "Nothing to sign here any more";
  }
}

/** "owner of core/auth", from the open owner slot; "owner" when there is none. */
function ownerLabel(pr: Pick<PrView, "requirement">): string {
  const slot = pr.requirement.slots.find((s) => s.role === "owner" && s.state !== "ok");
  if (!slot) return "owner";
  return slot.label.charAt(0).toLowerCase() + slot.label.slice(1);
}

// ---------------------------------------------------------------------------
// sentences

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "one" … "ten", then digits. */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

const ROLE_PHRASES: Readonly<Record<Role, string>> = {
  peer: "as peer",
  owner: "as owner",
  self: "your own",
  "re-attest": "again after a change",
};

/**
 * The batch in one sentence, by role: "You are signing 4 changes: 2 as
 * peer, 1 as owner, 1 your own." With one role: "You are signing 3 changes
 * as peer."
 */
export function summarySentence(rows: ReadonlyArray<BatchRow>): string {
  const included = rows.filter((r) => r.included && r.role !== null);
  if (included.length === 0) return "Nothing is left to sign. Tick a row to put it back.";
  const parts = ROLE_ORDER.map(
    (role) => [role, included.filter((r) => r.role === role).length] as const,
  ).filter(([, n]) => n > 0);
  if (parts.length === 1) {
    const [role] = parts[0]!;
    const phrase = role === "self" ? "of your own" : ROLE_PHRASES[role];
    return `You are signing ${changes(included.length)} ${phrase}.`;
  }
  return `You are signing ${changes(included.length)}: ${parts.map(([role, n]) => `${n} ${ROLE_PHRASES[role]}`).join(", ")}.`;
}

export type Outcome = { readonly text: string; readonly tone: "ok" | "wait" | "none" };

/**
 * What happens to a PR after my nod, from its ask: the check turns green and
 * the agent merges (after CI, when checks still run), or it still waits on
 * someone. `after`: the same, once signed ("the agent can merge").
 */
export function outcomeOf(
  pr: Pick<PrView, "ask" | "checks">,
  people: People,
  phase: "before" | "after" = "before",
): Outcome {
  const then = pr.ask?.then;
  if (!then) return { text: "nothing needed from you now", tone: "none" };
  if (then.outcome === "waits") {
    const names = namesOf(then.on, people) || "someone else";
    return {
      text: phase === "before" ? `still waits on ${names}` : `waits on ${names}`,
      tone: "wait",
    };
  }
  if (pr.checks.state === "failing")
    return {
      text:
        phase === "before"
          ? "check turns green; a CI check still fails"
          : "signed; a CI check still fails",
      tone: "wait",
    };
  if (pr.checks.state === "pending")
    return {
      text: phase === "before" ? "check turns green, merges after CI" : "merges after CI",
      tone: "ok",
    };
  return {
    text: phase === "before" ? "check turns green, the agent merges" : "the agent can merge",
    tone: "ok",
  };
}

/**
 * What the batch leads to, in r2's words: "Four will be merged by their
 * agents. One still waits on Jonas afterwards." After signing: "Four are
 * with their agents now. One still waits on Jonas."
 */
export function outcomeSentence(
  prs: ReadonlyArray<Pick<PrView, "ask" | "checks">>,
  people: People,
  phase: "before" | "after",
): string {
  const merging = prs.filter((p) => p.ask?.then.outcome === "satisfied").length;
  const waiting = prs.filter((p) => p.ask?.then.outcome === "waits");
  const names = [
    ...new Set(
      waiting.map((p) => (p.ask?.then.outcome === "waits" ? namesOf(p.ask.then.on, people) : "")),
    ),
  ];
  const on = names.length === 1 && names[0] ? ` on ${names[0]}` : "";
  const sentences: string[] = [];
  if (merging)
    sentences.push(
      phase === "before"
        ? `${capital(countWord(merging))} will be merged by ${merging === 1 ? "its agent" : "their agents"}.`
        : `${capital(countWord(merging))} ${merging === 1 ? "is with its agent" : "are with their agents"} now.`,
    );
  if (waiting.length) {
    const n = waiting.length;
    const verb = n === 1 ? "waits" : "wait";
    const subject = merging
      ? `${capital(countWord(n))} still`
      : n === 1
        ? "It still"
        : "They still";
    sentences.push(`${subject} ${verb}${on}${phase === "before" ? " afterwards" : ""}.`);
  }
  return sentences.join(" ");
}

export interface StaleEntry {
  readonly pr: number;
  readonly signed: string;
  readonly current: string;
}

/** How a stale PR changed: "head 9f3c2ab → 1c4d5e6 · 2 new commits". */
export function staleText(entry: StaleEntry, pr: Pick<PrView, "lastActivity"> | null): string {
  const moved = `head ${entry.signed.slice(0, 7)} → ${entry.current.slice(0, 7)}`;
  return pr ? `${moved} · ${pr.lastActivity.text}` : moved;
}

// ---------------------------------------------------------------------------
// the signer, as far as the dialog cares

export type Readiness =
  | { readonly state: "unlocked" }
  | { readonly state: "locked" }
  | { readonly state: "no-key" }
  | { readonly state: "pending"; readonly pr: number | null }
  | { readonly state: "not-enrolled" };

/** Whether I can sign now, must unlock first, or cannot sign at all (and why). */
export function readiness(signer: SignerState | null): Readiness {
  if (!signer) return { state: "locked" };
  if (signer.state === "no-key") return { state: "no-key" };
  const enrolment = signer.key.enrolment;
  if (enrolment.state === "pending") return { state: "pending", pr: enrolment.pr?.number ?? null };
  if (enrolment.state === "not-enrolled") return { state: "not-enrolled" };
  return { state: signer.state };
}

// ---------------------------------------------------------------------------
// the state machine

export interface Attempt {
  /** Every PR the signed step lists, as they were before signing. */
  readonly shown: ReadonlyArray<PrView>;
  /** What this request signs (all of `shown`, or the failed ones on a retry). */
  readonly entries: ReadonlyArray<SignEntry>;
  /** A retry adds to what the first attempt posted. */
  readonly prior: SignResult | null;
}

export interface Failure {
  readonly code: ErrorCode | "offline" | "timeout";
  readonly message: string;
}

export type BatchState =
  | { readonly step: "review" }
  | {
      readonly step: "unlock";
      readonly attempt: Attempt;
      readonly busy: boolean;
      readonly error: Failure | null;
    }
  | { readonly step: "signing"; readonly attempt: Attempt }
  | { readonly step: "signed"; readonly shown: ReadonlyArray<PrView>; readonly result: SignResult }
  | { readonly step: "stale"; readonly stale: ReadonlyArray<StaleEntry> }
  | { readonly step: "error"; readonly failure: Failure };

export type BatchEvent =
  /** The primary button: sign these (from review), or retry the failed ones (from signed). */
  | {
      readonly t: "sign";
      readonly readiness: Readiness["state"];
      readonly rows: ReadonlyArray<PrView>;
      readonly entries: ReadonlyArray<SignEntry>;
    }
  | { readonly t: "unlock" }
  | { readonly t: "unlock-failed"; readonly failure: Failure }
  | { readonly t: "unlocked" }
  | { readonly t: "signed"; readonly result: SignResult }
  | {
      readonly t: "sign-failed";
      readonly failure: Failure;
      readonly details?: RequestError["details"];
    }
  | { readonly t: "back" };

export const INITIAL_BATCH: BatchState = { step: "review" };

/** Posted adds up across a retry; failed is what the last attempt could not post. */
export function mergeResults(prior: SignResult | null, next: SignResult): SignResult {
  if (!prior) return next;
  const posted = [
    ...prior.posted,
    ...next.posted.filter((p) => !prior.posted.some((q) => q.pr === p.pr)),
  ];
  return { payload: next.payload, posted, failed: next.failed };
}

export function batchReducer(state: BatchState, event: BatchEvent): BatchState {
  switch (event.t) {
    case "sign": {
      if (state.step !== "review" && state.step !== "signed") return state;
      if (event.entries.length === 0) return state;
      const attempt: Attempt =
        state.step === "signed"
          ? { shown: state.shown, entries: event.entries, prior: state.result }
          : { shown: event.rows, entries: event.entries, prior: null };
      if (event.readiness === "unlocked") return { step: "signing", attempt };
      if (event.readiness === "locked")
        return { step: "unlock", attempt, busy: false, error: null };
      return state;
    }
    case "unlock":
      return state.step === "unlock" ? { ...state, busy: true, error: null } : state;
    case "unlock-failed":
      if (state.step !== "unlock") return state;
      if (event.failure.code === "bad-key-file" || event.failure.code === "no-key")
        return { step: "error", failure: event.failure };
      return { ...state, busy: false, error: event.failure };
    case "unlocked":
      return state.step === "unlock" ? { step: "signing", attempt: state.attempt } : state;
    case "signed":
      return state.step === "signing"
        ? {
            step: "signed",
            shown: state.attempt.shown,
            result: mergeResults(state.attempt.prior, event.result),
          }
        : state;
    case "sign-failed": {
      if (state.step !== "signing") return state;
      const { prior } = state.attempt;
      // A retry that fails keeps what was posted and says why on the rows still missing.
      if (prior && event.failure.code !== "locked")
        return {
          step: "signed",
          shown: state.attempt.shown,
          result: {
            ...prior,
            failed: prior.failed.map((f) => ({ ...f, message: event.failure.message })),
          },
        };
      const stale = event.details?.stale;
      if (event.failure.code === "stale" && stale?.length) return { step: "stale", stale };
      // Locked again in between (the window ended, or a lock from another tab).
      if (event.failure.code === "locked")
        return {
          step: "unlock",
          attempt: state.attempt,
          busy: false,
          error: {
            code: "locked",
            message: "Signing locked again in the meantime. Unlock to sign.",
          },
        };
      return { step: "error", failure: event.failure };
    }
    case "back":
      if (state.step === "signing" || state.step === "signed") return state;
      // Back from unlocking a retry: the signed step again, as it was.
      if (state.step === "unlock" && state.attempt.prior)
        return { step: "signed", shown: state.attempt.shown, result: state.attempt.prior };
      return INITIAL_BATCH;
  }
}
