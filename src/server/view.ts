/**
 * From what a source knows about a PR to what the user sees: the view model
 * of `protocol.ts`, made relative to `me`.
 *
 * A source (the fake one now, the GitHub one later) produces `PrFacts`: the
 * PR, the verifier's policy result and the nods, the same for every viewer.
 * `toViews` adds what depends on who is looking and when: `mine`, `needsMe`
 * and the ask, `fyiForMe`, `stuck`, `waitingOn`, the journey's present and
 * future steps, and `unblocks` across the snapshot.
 *
 * A PR classified locally (the inbox step, no policy in the repo) has no
 * slots: nothing to sign. Its "needs me" and "waiting on" come from GitHub's
 * reviews instead (`review`): a review requested from me or my team, or my
 * own PR stuck (a check failing, a conflict, changes requested). Mentions do
 * not count. `review.fromMe` is already relative to the source's viewer: only
 * GitHub's search can tell a team request that includes me.
 */

import type {
  Ask,
  JourneyEvent,
  Login,
  Person,
  PrView,
  Requirement,
  Signature,
  Slot,
  Stuck,
  WaitingOn,
} from "../shared/protocol";
import { STUCK_AFTER_MS } from "../shared/protocol";

export interface PrFacts extends Omit<
  PrView,
  | "requirement"
  | "signatures"
  | "unblocks"
  | "mine"
  | "needsMe"
  | "ask"
  | "fyiForMe"
  | "stuck"
  | "waitingOn"
  | "waitingSince"
> {
  readonly requirement: Omit<Requirement, "satisfied">;
  readonly signatures: ReadonlyArray<Omit<Signature, "byMe">>;
  /** Only what happened (phase `done`); the present and the future are derived. */
  readonly journey: ReadonlyArray<JourneyEvent>;
  /** Since when the current requirement waits on a human; defaults to `openedAt`. */
  readonly waitingSince?: number | null;
}

export interface ViewContext {
  readonly me: Login;
  readonly now: number;
  readonly people: ReadonlyArray<Person>;
}

export const sameLogin = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** Whether my nod fills the slot (open or stale). */
export function canFill(slot: Slot, me: Login): boolean {
  if (slot.state === "ok") return false;
  if (slot.role === "peer")
    return !sameLogin(slot.except, me) && (slot.who === null || sameLogin(slot.who, me));
  return sameLogin(slot.who, me);
}

function waitingOnSlot(slot: Slot, me: Login): WaitingOn {
  if (slot.who === null) return { kind: "anyone", except: slot.except ?? "" };
  return sameLogin(slot.who, me) ? { kind: "me" } : { kind: "person", login: slot.who };
}

const key = (w: WaitingOn) =>
  w.kind === "person"
    ? `person:${w.login.toLowerCase()}`
    : w.kind === "anyone"
      ? `anyone:${w.except}`
      : w.kind;

function dedupe(list: WaitingOn[]): WaitingOn[] {
  const seen = new Set<string>();
  return list.filter((w) => !seen.has(key(w)) && (seen.add(key(w)), true));
}

const isOpen = (f: Pick<PrFacts, "state">) => f.state === "open" || f.state === "draft";

/** Classified by this nod serve, not the repo's verifier (the inbox step). */
export const isLocal = (f: Pick<PrFacts, "classifiedBy">) => f.classifiedBy === "local";

/**
 * Who a locally classified PR waits on, from GitHub's reviews: the author's
 * side first when it is a draft, fails a check, conflicts or has changes
 * requested; then the people asked to review (me first; a team I am not in
 * is "a teammate"); with nobody asked and no approval, any teammate; then
 * running checks; approved and nothing else open, the merge.
 */
function localWaitingOn(facts: PrFacts, me: Login): WaitingOn[] {
  if (!isOpen(facts)) return [{ kind: "nothing" }];
  if (facts.state === "draft") return [{ kind: "agent" }];
  const r = facts.review;
  const mine = sameLogin(facts.prompter, me);
  const list: WaitingOn[] = [];
  if (facts.checks.state === "failing" || facts.conflict || r?.changesRequestedBy.length)
    list.push({ kind: "agent" });
  const humans: WaitingOn[] = [];
  if (r?.fromMe && !mine) humans.push({ kind: "me" });
  for (const login of r?.requested ?? [])
    if (!sameLogin(login, me)) humans.push({ kind: "person", login });
  // A team request that is not mine (a request from my team made `fromMe` already).
  const directlyMe = r?.requested.some((l) => sameLogin(l, me)) ?? false;
  if (r?.teams.length && (!r.fromMe || directlyMe))
    humans.push({ kind: "anyone", except: facts.prompter });
  if (humans.length === 0 && !r?.approvedBy.length && list.length === 0)
    humans.push({ kind: "anyone", except: facts.prompter });
  list.push(...humans);
  if (facts.checks.state === "pending") list.push({ kind: "checks" });
  if (list.length === 0) list.push({ kind: "merge" });
  return dedupe(list);
}

/** A locally classified PR needs me: a review is asked of me, or it is mine and stuck. */
function localNeedsMe(facts: PrFacts, me: Login, stuck: Stuck | null): boolean {
  if (facts.state !== "open") return false;
  if (sameLogin(facts.prompter, me)) return stuck !== null && stuck.reason !== "waiting";
  return facts.review?.fromMe ?? false;
}

const isHuman = (w: WaitingOn) => w.kind === "me" || w.kind === "person" || w.kind === "anyone";

/** The humans the PR waits on, me first. */
function humans(facts: PrFacts, me: Login): WaitingOn[] {
  if (isLocal(facts)) return localWaitingOn(facts, me).filter(isHuman);
  const open = facts.requirement.slots.filter((s) => s.state !== "ok");
  const mine = open.filter((s) => canFill(s, me)).length > 0 ? [{ kind: "me" } as const] : [];
  return dedupe([...mine, ...open.filter((s) => !canFill(s, me)).map((s) => waitingOnSlot(s, me))]);
}

function askOf(facts: PrFacts, me: Login): Ask | null {
  if (facts.state !== "open" || isLocal(facts)) return null;
  const slots = facts.requirement.slots;
  const fillable = slots.filter((s) => canFill(s, me));
  if (fillable.length === 0) return null;
  const reattest = fillable.some(
    (s) =>
      s.state === "stale" &&
      s.signature !== null &&
      sameLogin(facts.signatures[s.signature]?.by ?? null, me),
  );
  const owner = fillable.find((s) => s.role === "owner");
  const kind: Ask["kind"] = reattest
    ? "re-attest"
    : owner
      ? "owner"
      : fillable.some((s) => s.role === "peer")
        ? "peer"
        : "self";
  const label = {
    "re-attest": "Re-attest",
    owner: "Sign as owner",
    peer: "Sign as peer",
    self: "Self-attest",
  }[kind];
  const rest = dedupe(
    slots.filter((s) => s.state !== "ok" && !canFill(s, me)).map((s) => waitingOnSlot(s, me)),
  );
  return {
    kind,
    label,
    then: rest.length ? { outcome: "waits", on: rest } : { outcome: "satisfied" },
  };
}

function waitingOnOf(facts: PrFacts, me: Login): WaitingOn[] {
  if (isLocal(facts)) return localWaitingOn(facts, me);
  if (!isOpen(facts)) return [{ kind: "nothing" }];
  const list: WaitingOn[] = [];
  if (facts.state === "draft" || facts.checks.state === "failing") list.push({ kind: "agent" });
  list.push(...humans(facts, me));
  if (facts.checks.state === "pending") list.push({ kind: "checks" });
  if (list.length === 0) list.push({ kind: "merge" });
  return list;
}

/** "Waiting on you", "Jonas", "a teammate": how the journey names who it waits on. */
export function whoText(w: WaitingOn, people: ReadonlyArray<Person>): string {
  switch (w.kind) {
    case "me":
      return "you";
    case "person":
      return people.find((p) => sameLogin(p.login, w.login))?.name?.split(/\s+/)[0] || w.login;
    case "anyone":
      return "a teammate";
    case "checks":
      return "checks";
    case "agent":
      return "the agent";
    case "merge":
      return "the merge";
    case "nothing":
      return "nothing";
  }
}

function journeyOf(
  facts: PrFacts,
  waitingOn: ReadonlyArray<WaitingOn>,
  since: number | null,
  ctx: ViewContext,
): JourneyEvent[] {
  const past = facts.journey.map((e) => ({ ...e, phase: "done" as const }));
  if (!isOpen(facts)) return past;
  const step = (text: string, phase: "now" | "next", at: number | null = null): JourneyEvent => ({
    kind: "waiting",
    text,
    detail: null,
    at,
    phase,
    tone: "plain",
  });
  const [first, ...rest] = waitingOn;
  const local = isLocal(facts);
  // At the inbox step people review on GitHub and merge themselves.
  const verb = local ? ["You review", "reviews"] : ["You sign", "signs"];
  const now: JourneyEvent[] = [];
  if (first?.kind === "agent")
    now.push(
      step(
        facts.state === "draft"
          ? "Agent is writing it"
          : local && facts.conflict && facts.checks.state !== "failing"
            ? "Conflicts with the base"
            : local && facts.review?.changesRequestedBy.length && facts.checks.state !== "failing"
              ? "Changes requested"
              : "Agent is fixing it",
        "now",
        facts.lastActivity.at,
      ),
    );
  else if (first?.kind === "checks") now.push(step("Checks running", "now", facts.lastActivity.at));
  else if (first?.kind === "merge")
    now.push(step(local ? "Ready to merge" : "Agent merges", "now", facts.lastActivity.at));
  else if (first) now.push(step(`Waiting on ${whoText(first, ctx.people)}`, "now", since));
  const next: JourneyEvent[] = [];
  for (const w of first?.kind === "agent" ? waitingOn.slice(1) : rest)
    if (isHuman(w))
      next.push(
        step(
          `${w.kind === "me" ? verb[0] : `${capital(whoText(w, ctx.people))} ${verb[1]}`}`,
          "next",
        ),
      );
  if (facts.checks.state !== "passing" && facts.checks.state !== "none" && first?.kind !== "checks")
    next.push(step("Checks green", "next"));
  if (first?.kind !== "merge") next.push(step(local ? "Merged" : "Agent merges", "next"));
  return [...past, ...now, ...next];
}

/** The first reason it is stuck, in `Stuck`'s order; null when it is not (or not open). */
function stuckOf(
  facts: PrFacts,
  now: number,
  waitingHumans: ReadonlyArray<WaitingOn>,
  waitingSince: number | null,
): Stuck | null {
  if (!isOpen(facts)) return null;
  if (facts.checks.state === "failing")
    return { reason: "checks-failing", checks: facts.checks.failing };
  if (facts.conflict) return { reason: "conflict" };
  const by = facts.review?.changesRequestedBy ?? [];
  if (by.length) return { reason: "changes-requested", by };
  if (waitingSince !== null && now - waitingSince >= STUCK_AFTER_MS)
    return { reason: "waiting", since: waitingSince, on: waitingHumans };
  return null;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function toView(
  facts: PrFacts,
  ctx: ViewContext,
  unblocks: ReadonlyArray<number> = [],
): PrView {
  const { me, now } = ctx;
  const slots = facts.requirement.slots;
  const ask = askOf(facts, me);
  const waitingOn = waitingOnOf(facts, me);
  const waitingHumans = isOpen(facts) ? humans(facts, me) : [];
  const waitingSince = waitingHumans.length ? (facts.waitingSince ?? facts.openedAt) : null;
  const stuck = stuckOf(facts, now, waitingHumans, waitingSince);
  const local = isLocal(facts);
  // With no policy, GitHub's reviews stand in for the requirement: met once
  // approved, with no change requested.
  const satisfied = local
    ? (facts.review?.approvedBy.length ?? 0) > 0 && !facts.review?.changesRequestedBy.length
    : slots.every((s) => s.state === "ok");
  return {
    ...facts,
    requirement: { ...facts.requirement, satisfied },
    signatures: facts.signatures.map((s) => ({ ...s, byMe: sameLogin(s.by, me) })),
    journey: journeyOf(facts, waitingOn, waitingSince, ctx),
    unblocks,
    mine: sameLogin(facts.prompter, me),
    needsMe: local ? localNeedsMe(facts, me, stuck) : ask !== null,
    ask,
    fyiForMe: facts.fyi?.pending.some((l) => sameLogin(l, me)) ?? false,
    stuck,
    waitingOn,
    waitingSince,
  };
}

/** Every PR of a snapshot, with `unblocks` filled in from the others' `dependsOn`. */
export function toViews(all: ReadonlyArray<PrFacts>, ctx: ViewContext): PrView[] {
  const unblocks = new Map<number, number[]>();
  for (const f of all)
    for (const d of f.dependsOn) unblocks.set(d, [...(unblocks.get(d) ?? []), f.number]);
  return all.map((f) => toView(f, ctx, unblocks.get(f.number) ?? []));
}
