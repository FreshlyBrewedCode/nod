/**
 * The words r3 puts on rows and in the panel, from the view model. Pure and
 * presentational: what a PR *is* (tier, lane, cluster) comes from
 * `shared/attention.ts`; this only says it.
 */

import type { ClusterItem } from "../../shared/attention";
import { isSizeTag, shortName, waitsOnMyKey } from "../../shared/attention";
import type {
  Ask,
  Fyi,
  JourneyEvent,
  Person,
  PrView,
  Signature,
  SignerState,
  Slot,
  WaitingOn,
} from "../../shared/protocol";
import { ago, clockTime, sinceText } from "./time";

export type People = ReadonlyArray<Person>;

/** "you" for my own work, else the prompter's first name. */
export function whoOf(pr: Pick<PrView, "mine" | "prompter">, people: People): string {
  return pr.mine ? "you" : shortName(pr.prompter, people);
}

export function initialOf(login: string, people: People): string {
  return (shortName(login, people)[0] ?? "?").toUpperCase();
}

export interface TagText {
  readonly text: string;
  readonly tone: "plain" | "bad";
}

/**
 * The row's one tag: "changed since you signed" when my nod dropped, else the
 * most telling classifier tag ("migration", "core", "tier 2", "dependency").
 * Never a size tag: the diff indicator next to it says how big.
 */
export function rowTag(pr: Pick<PrView, "ask" | "tags">): TagText | null {
  if (pr.ask?.kind === "re-attest") return { text: "changed since you signed", tone: "bad" };
  const first = pr.tags.find((t) => !isSizeTag(t));
  if (!first) return null;
  return { text: first === "deps" ? "dependency" : first, tone: "plain" };
}

/** On one-line rows and in the panel: "1 check failing" or "checks running". */
export function checksTag(pr: Pick<PrView, "checks" | "state">): TagText | null {
  if (pr.state !== "open" && pr.state !== "draft") return null;
  if (pr.checks.state === "failing") {
    const n = Math.max(1, pr.checks.failing.length || pr.checks.total - pr.checks.passed);
    return { text: `${n} check${n === 1 ? "" : "s"} failing`, tone: "bad" };
  }
  if (pr.checks.state === "pending") return { text: "checks running", tone: "plain" };
  return null;
}

/** The FYI's reason to care, without where it came from: "test commands change". */
export function fyiWhy(fyi: Pick<Fyi, "reason">): string {
  return fyi.reason.replace(/^(declared by author|declared|policy):\s*/i, "");
}

function name(w: WaitingOn, people: People): string | null {
  switch (w.kind) {
    case "me":
      return "you";
    case "person":
      return shortName(w.login, people);
    case "anyone":
      return "a teammate";
    default:
      return null;
  }
}

/** "Jonas", "Jonas and Ines", "Jonas, Ines and a teammate". */
export function namesOf(list: ReadonlyArray<WaitingOn>, people: People): string {
  const names = list.map((w) => name(w, people)).filter((n): n is string => n !== null);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The right-hand status of a row that wants nothing from me: "merged",
 * "agent is fixing it", "merging", "checks running", "waits on Ines".
 */
export function statusText(pr: PrView, people: People): string {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  const first = pr.waitingOn[0];
  const local = pr.classifiedBy === "local";
  if (first?.kind === "agent") {
    if (pr.state === "draft") return "agent is writing it";
    // At the inbox step the stuck reason says more than "the agent".
    if (local && pr.stuck?.reason === "conflict") return "merge conflict";
    if (local && pr.stuck?.reason === "changes-requested") return "changes requested";
    return "agent is fixing it";
  }
  if (local && first?.kind === "merge") return "approved";
  if (pr.requirement.slots.length > 0 && pr.requirement.satisfied) return "merging";
  if (first?.kind === "checks") return "checks running";
  if (first?.kind === "merge" || !first) return "merging";
  const humans = pr.waitingOn.filter(
    (w) => w.kind === "me" || w.kind === "person" || w.kind === "anyone",
  );
  const text = `waits on ${namesOf(humans, people)}`;
  return waitsOnMyKey(pr) ? `${text}, once your key is enrolled` : text;
}

/**
 * Why my key cannot sign, in a few words for the board's "You" column, or
 * null when it can (or the server has not said yet): "no key yet", "key
 * pending", "key not enrolled".
 */
export function keyNoteOf(signer: SignerState | null): string | null {
  if (!signer) return null;
  if (signer.state === "no-key") return "no key yet";
  switch (signer.key.enrolment.state) {
    case "active":
      return null;
    case "pending":
      return "key pending";
    case "not-enrolled":
      return "key not enrolled";
  }
}

/** The cluster's right-hand status: "4 merged · 3 open". */
export function clusterStatus(c: Pick<ClusterItem, "merged" | "open">): string {
  return [c.merged ? `${c.merged} merged` : "", c.open ? `${c.open} open` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** "needs #485 first", "unblocks #482": from brief lines and stacked branches. */
export function dependencyHints(pr: Pick<PrView, "dependsOn" | "unblocks">): string[] {
  return [
    ...pr.dependsOn.map((n) => `needs #${n} first`),
    ...pr.unblocks.map((n) => `unblocks #${n}`),
  ];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * What a locally classified PR (the inbox step) needs of me, for the row's
 * right-hand word, the panel's "Needed from you" and the phone page's bar.
 * There is nothing to sign: the action is on GitHub. null when it needs
 * nothing of me, or has an ask (a policy's).
 */
export interface LocalNeed {
  /** The row's word: "review requested", "changes requested", "merge conflict". */
  readonly row: string;
  /** "Review requested from you", "Changes requested by Jonas". */
  readonly headline: string;
  readonly detail: string;
  /** The button: "Review on GitHub", "Open on GitHub". */
  readonly action: string;
  readonly href: string;
}

export function localNeed(
  pr: Pick<
    PrView,
    "classifiedBy" | "needsMe" | "ask" | "mine" | "stuck" | "review" | "base" | "url"
  >,
  people: People,
  me: string,
): LocalNeed | null {
  if (pr.classifiedBy !== "local" || !pr.needsMe || pr.ask) return null;
  const stuck = pr.stuck;
  if (pr.mine && stuck && stuck.reason !== "waiting") {
    const open = { action: "Open on GitHub", href: pr.url };
    if (stuck.reason === "checks-failing") {
      const n = Math.max(1, stuck.checks.length);
      return {
        ...open,
        row: `${n} check${n === 1 ? "" : "s"} failing`,
        headline: stuck.checks.length ? `Failing: ${stuck.checks.join(", ")}` : "A check fails",
        detail: "Your pull request is stuck until its checks are green.",
      };
    }
    if (stuck.reason === "conflict")
      return {
        ...open,
        row: "merge conflict",
        headline: `Conflicts with ${pr.base}`,
        detail: "Your pull request cannot merge until the conflict is resolved.",
      };
    const names = stuck.by.map((l) => (sameLogin(l, me) ? "you" : shortName(l, people)));
    const list =
      names.length <= 1
        ? (names[0] ?? "a reviewer")
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return {
      ...open,
      // GitHub's "Changes requested" is too wide for the row's column.
      row: "needs changes",
      headline: `Changes requested by ${list}`,
      detail: "Your pull request waits on a new push from your side.",
    };
  }
  const direct = pr.review?.requested.some((l) => sameLogin(l, me)) ?? false;
  return {
    row: "review requested",
    headline: direct ? "Review requested from you" : "Review requested from your team",
    detail: "This repository has no nod policy yet, so it is a review on GitHub.",
    action: "Review on GitHub",
    href: `${pr.url}/files`,
  };
}

/**
 * The panel's headline of what is needed from me: "Sign as peer", "Sign as
 * owner of core/auth", "Self-attest", "Sign again, content changed".
 */
export function askHeadline(pr: Pick<PrView, "ask" | "requirement">): string {
  const ask = pr.ask;
  if (!ask) return "";
  if (ask.kind === "re-attest") return "Sign again, content changed";
  if (ask.kind === "owner") {
    const slot = pr.requirement.slots.find((s) => s.role === "owner" && s.state !== "ok");
    return slot ? `Sign as ${lowerFirst(slot.label)}` : ask.label;
  }
  return ask.label;
}

/** What happens once I sign. */
export function thenText(ask: Ask, people: People): string {
  return ask.then.outcome === "satisfied"
    ? "Then the check turns green and the agent merges."
    : `Then it still waits on ${namesOf(ask.then.on, people)}.`;
}

export interface Pip {
  /** The signer's initial, "+1" for a peer slot, "!" when the content changed since. */
  readonly label: string;
  /** `ok` signed · `stale` signed before the change · `me` mine to fill · `open` someone else's. */
  readonly tone: "ok" | "stale" | "me" | "open";
  readonly title: string;
}

/**
 * The board card's signature pips (r2/r3): one per slot of the requirement,
 * filled when signed, an amber ring for the slot that waits on me.
 */
export function signaturePips(
  pr: Pick<PrView, "requirement" | "signatures" | "needsMe">,
  me: string,
  people: People,
): ReadonlyArray<Pip> {
  return pr.requirement.slots.map((slot) => {
    const signer =
      slot.signature === null
        ? (slot.approval ?? null)
        : (pr.signatures[slot.signature]?.by ?? null);
    const who = slot.who ?? signer;
    const initial = who ? initialOf(who, people) : "+1";
    const mineToFill =
      pr.needsMe &&
      slot.state !== "ok" &&
      (slot.who === null ? !slot.except || !sameLogin(slot.except, me) : sameLogin(slot.who, me));
    const tone =
      slot.state === "ok" ? "ok" : slot.state === "stale" ? "stale" : mineToFill ? "me" : "open";
    const state =
      tone === "ok"
        ? slot.approval && slot.signature === null
          ? "approved on GitHub"
          : "signed"
        : tone === "stale"
          ? "signed before the content changed"
          : tone === "me"
            ? "waits on you"
            : "missing";
    return { label: tone === "stale" ? "!" : initial, tone, title: `${slot.label}: ${state}` };
  });
}

// ---------------------------------------------------------------------------
// the panel's folded sections

export function reasonsSummary(pr: Pick<PrView, "reasons" | "classifiedBy">): string {
  const n = pr.reasons.filter((r) => r.raises).length;
  const text = `${n} reason${n === 1 ? "" : "s"}`;
  return pr.classifiedBy === "local" ? `${text} · classified by your nod` : text;
}

/** The note on a locally classified PR: who classified it, and that the repo did not. */
export const LOCAL_NOTE =
  "Classified by your nod, not the repo. This repository has no nod policy yet, so nod ran its built-in defaults on GitHub’s file list. Only you see it; nothing is posted.";

/** A locally classified PR's "Reviews" fold summary: "1 approved · 2 requested", "none yet". */
export function reviewsSummary(review: PrView["review"]): string {
  if (!review) return "none yet";
  const requested = review.requested.length + review.teams.length;
  const parts = [
    review.approvedBy.length ? `${review.approvedBy.length} approved` : "",
    review.changesRequestedBy.length ? `${review.changesRequestedBy.length} changes requested` : "",
    requested ? `${requested} requested` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "none yet";
}

/** The lines of the "Reviews" fold: who approved, requested changes or is asked to review. */
export function reviewLines(
  review: NonNullable<PrView["review"]>,
  people: People,
  me: string,
): ReadonlyArray<{
  readonly who: string;
  readonly detail: string;
  readonly tone: "ok" | "bad" | "open";
}> {
  const name = (l: string) => (sameLogin(l, me) ? "You" : shortName(l, people));
  return [
    ...review.approvedBy.map((l) => ({ who: name(l), detail: "approved", tone: "ok" as const })),
    ...review.changesRequestedBy.map((l) => ({
      who: name(l),
      detail: "requested changes",
      tone: "bad" as const,
    })),
    ...review.requested.map((l) => ({
      who: name(l),
      detail: "review requested",
      tone: "open" as const,
    })),
    ...review.teams.map((t) => ({
      who: `Team ${t}`,
      // GitHub's search says one of the teams has me; with one team, that is it.
      detail:
        review.teams.length === 1 &&
        review.fromMe &&
        !review.requested.some((l) => sameLogin(l, me))
          ? "review requested; you are in it"
          : "review requested",
      tone: "open" as const,
    })),
  ];
}

export function signaturesSummary(pr: Pick<PrView, "requirement">): string {
  const slots = pr.requirement.slots;
  if (slots.length === 0) return "none needed";
  return `${slots.filter((s) => s.state === "ok").length} of ${slots.length}`;
}

/** "Ines has seen it", "Ines and Jonas have seen it", "nobody yet". */
export function fyiSummary(fyi: Fyi, people: People, me: string): string {
  const names = fyi.acked.map((l) => (sameLogin(l, me) ? "you" : shortName(l, people)));
  if (names.length === 0) return "nobody yet";
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 && names[0] !== "you" ? "has" : "have"} seen it`;
}

export function filesSummary(pr: Pick<PrView, "diff" | "checks">): string {
  const checks =
    pr.checks.state === "passing"
      ? "checks green"
      : pr.checks.state === "none"
        ? "no checks"
        : "checks not green";
  return `${pr.diff.files} changed · ${checks}`;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A signature slot as the panel lists it: "Jonas, as prompter" and what it holds. */
export function slotText(
  slot: Slot,
  signature: Signature | null,
  people: People,
  me: string,
  now: number,
  utcOffsetMinutes: number,
): { who: string; detail: string } {
  const person =
    slot.who === null
      ? slot.except
        ? `Anyone but ${shortName(slot.except, people)}`
        : "Any teammate"
      : sameLogin(slot.who, me)
        ? "You"
        : shortName(slot.who, people);
  const who = `${person}, as ${lowerFirst(slot.label)}`;
  if (slot.state === "missing") return { who, detail: "missing" };
  if (slot.state === "ok" && !signature && slot.approval)
    return {
      who,
      detail: `approved on GitHub${slot.who === null ? ` by ${shortName(slot.approval, people)}` : ""}`,
    };
  if (slot.state === "stale" || !signature)
    return { who, detail: "signed before, but the content changed" };
  const when = sinceText(signature.at, now, utcOffsetMinutes);
  const rebased =
    signature.matchedBy === "patch_id"
      ? ". Rebased since; the patch-id is unchanged, so it still counts."
      : "";
  return { who, detail: `signed ${signature.headSha.slice(0, 7)} ${when}${rebased}` };
}

/**
 * A journey step's small text: its detail ("needs 2 people"), else how long
 * it has been the present ("5h"), else when it happened ("16:12").
 */
export function journeyDetail(e: JourneyEvent, now: number, utcOffsetMinutes: number): string {
  if (e.detail) return e.detail;
  if (e.at === null) return "";
  return e.phase === "now" ? ago(e.at, now) : clockTime(e.at, utcOffsetMinutes);
}

/**
 * The journey fold's summary on a phone: where the PR is now, "waiting on
 * you, 6h". The "now" step's text in lower case, then its small text.
 */
export function journeySummary(
  events: ReadonlyArray<JourneyEvent>,
  now: number,
  utcOffsetMinutes: number,
): string {
  const here = events.find((e) => e.phase === "now") ?? events.at(-1);
  if (!here) return "";
  const text = here.text.charAt(0).toLowerCase() + here.text.slice(1);
  const detail = journeyDetail(here, now, utcOffsetMinutes);
  return detail ? `${text}, ${detail}` : text;
}

const RISK_WORDS = ["no", "low", "medium", "high"] as const;

/**
 * The risk in words for a place that has no tooltip: "high risk", or null when
 * the brief's own risk text already starts with the level ("High. Touches
 * core/auth…"), so it is not said twice.
 */
export function riskWords(risk: PrView["risk"], briefRisk: string | null): string | null {
  const word = RISK_WORDS[risk];
  if (briefRisk && new RegExp(`^\\W*${word}\\b`, "i").test(briefRisk)) return null;
  return `${word} risk`;
}

/**
 * The phone page's action bar line, its bold part: "Needed from you: sign as
 * owner of core/auth." Null when nothing is needed from me.
 */
export function neededFromYou(pr: Pick<PrView, "ask" | "requirement">): string | null {
  if (!pr.ask) return null;
  return `Needed from you: ${lowerFirst(askHeadline(pr))}.`;
}
