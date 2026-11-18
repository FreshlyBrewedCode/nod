/**
 * From what a source knows about a PR to what the user sees: the view model
 * of `protocol.ts`, made relative to `me`.
 *
 * A source (the fake one now, the GitHub one later) produces `PrFacts`: the
 * PR, the verifier's policy result and the nods, the same for every viewer.
 * `toViews` adds what depends on who is looking and when: `mine`, `needsMe`
 * and the ask, `fyiForMe`, `stuck`, `waitingOn`, the journey's present and
 * future steps, and `unblocks` across the snapshot.
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

/** The humans the PR waits on, me first. */
function humans(facts: PrFacts, me: Login): WaitingOn[] {
  const open = facts.requirement.slots.filter((s) => s.state !== "ok");
  const mine = open.filter((s) => canFill(s, me)).length > 0 ? [{ kind: "me" } as const] : [];
  return dedupe([...mine, ...open.filter((s) => !canFill(s, me)).map((s) => waitingOnSlot(s, me))]);
}

function askOf(facts: PrFacts, me: Login): Ask | null {
  if (facts.state !== "open") return null;
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
  const now: JourneyEvent[] = [];
  if (first?.kind === "agent")
    now.push(
      step(
        facts.state === "draft" ? "Agent is writing it" : "Agent is fixing it",
        "now",
        facts.lastActivity.at,
      ),
    );
  else if (first?.kind === "checks") now.push(step("Checks running", "now", facts.lastActivity.at));
  else if (first?.kind === "merge") now.push(step("Agent merges", "now", facts.lastActivity.at));
  else if (first) now.push(step(`Waiting on ${whoText(first, ctx.people)}`, "now", since));
  const next: JourneyEvent[] = [];
  for (const w of first?.kind === "agent" ? waitingOn.slice(1) : rest)
    if (w.kind === "me" || w.kind === "person" || w.kind === "anyone")
      next.push(
        step(
          `${w.kind === "me" ? "You sign" : `${capital(whoText(w, ctx.people))} signs`}`,
          "next",
        ),
      );
  if (facts.checks.state !== "passing" && facts.checks.state !== "none" && first?.kind !== "checks")
    next.push(step("Checks green", "next"));
  if (first?.kind !== "merge") next.push(step("Agent merges", "next"));
  return [...past, ...now, ...next];
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
  let stuck: Stuck | null = null;
  if (isOpen(facts) && facts.checks.state === "failing")
    stuck = { reason: "checks-failing", checks: facts.checks.failing };
  else if (waitingSince !== null && now - waitingSince >= STUCK_AFTER_MS)
    stuck = { reason: "waiting", since: waitingSince, on: waitingHumans };
  return {
    ...facts,
    requirement: { ...facts.requirement, satisfied: slots.every((s) => s.state === "ok") },
    signatures: facts.signatures.map((s) => ({ ...s, byMe: sameLogin(s.by, me) })),
    journey: journeyOf(facts, waitingOn, waitingSince, ctx),
    unblocks,
    mine: sameLogin(facts.prompter, me),
    needsMe: ask !== null,
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
