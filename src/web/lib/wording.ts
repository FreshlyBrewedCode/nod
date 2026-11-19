/**
 * The words r3 puts on rows and in the panel, from the view model. Pure and
 * presentational: what a PR *is* (tier, lane, cluster) comes from
 * `shared/attention.ts`; this only says it.
 */

import type { ClusterItem } from "../../shared/attention";
import { shortName, waitsOnMyKey } from "../../shared/attention";
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
 */
export function rowTag(pr: Pick<PrView, "ask" | "tags">): TagText | null {
  if (pr.ask?.kind === "re-attest") return { text: "changed since you signed", tone: "bad" };
  const first = pr.tags[0];
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
  if (first?.kind === "agent")
    return pr.state === "draft" ? "agent is writing it" : "agent is fixing it";
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
    const signer = slot.signature === null ? null : (pr.signatures[slot.signature]?.by ?? null);
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
        ? "signed"
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

export function reasonsSummary(pr: Pick<PrView, "reasons">): string {
  const n = pr.reasons.filter((r) => r.raises).length;
  return `${n} reason${n === 1 ? "" : "s"}`;
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
