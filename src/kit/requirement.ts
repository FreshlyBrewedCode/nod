/**
 * What a PR needs before the `nod` check turns green, and how several
 * requirements combine: always to the strictest, so no rule can lower what
 * another rule asked for.
 *
 * - `none`: nothing; the PR may auto-merge.
 * - `self`: any enrolled human nods, typically the one who prompted the agent.
 * - `peer`: an enrolled human other than the PR author nods.
 * - `named(login)`: that person nods.
 *
 * `peer` ≥ `self` ≥ `none`. A `named` person adds to the level instead of
 * replacing it, and their nod also counts toward the level: `peer` plus
 * `named("bob")` on alice's PR is satisfied by bob alone, because bob's nod
 * is a peer nod. `named("alice")` on alice's own PR is satisfied by her self
 * nod; combined with `peer` it still needs someone else as well.
 */

/** How many eyes, ordered `none` < `self` < `peer`. */
export type RequirementLevel = "none" | "self" | "peer";

/** A requirement: a level plus specific people who must nod. */
export interface Requirement {
  readonly level: RequirementLevel;
  /** Logins that must each nod, compared case-insensitively. */
  readonly named: readonly string[];
}

/** One nod a PR still waits for. */
export type MissingNod =
  | { kind: "self"; login: string }
  | { kind: "peer" }
  | { kind: "named"; login: string };

/** No nod needed: the PR may merge on its own. */
export const none: Requirement = Object.freeze({ level: "none", named: Object.freeze([]) });
/** Any enrolled human nods; the prompter attesting their own agent's work is enough. */
export const self: Requirement = Object.freeze({ level: "self", named: Object.freeze([]) });
/** An enrolled human other than the PR author nods. */
export const peer: Requirement = Object.freeze({ level: "peer", named: Object.freeze([]) });

/** These people must each nod (in addition to whatever level other rules ask for). */
export function named(...logins: string[]): Requirement {
  return { level: "none", named: dedupe(logins) };
}

const RANK: Record<RequirementLevel, number> = { none: 0, self: 1, peer: 2 };

/** Combines requirements into the strictest: the highest level and everyone named by any of them. */
export function strictest(...requirements: readonly Requirement[]): Requirement {
  let level: RequirementLevel = "none";
  const people: string[] = [];
  for (const r of requirements) {
    if (RANK[r.level] > RANK[level]) level = r.level;
    people.push(...r.named);
  }
  return { level, named: dedupe(people) };
}

/** Whether `a` asks for at least as much as `b`. */
export function atLeast(a: Requirement, b: Requirement): boolean {
  if (RANK[a.level] < RANK[b.level]) return false;
  const have = new Set(a.named.map((n) => n.toLowerCase()));
  return b.named.every((n) => have.has(n.toLowerCase()));
}

/** Plain words for a requirement, e.g. "a peer nod and a nod from bob". */
export function describeRequirement(r: Requirement): string {
  const parts: string[] = [];
  if (r.level !== "none") parts.push(`a ${r.level} nod`);
  for (const n of r.named) parts.push(`a nod from ${n}`);
  return parts.length ? joinAnd(parts) : "no nod";
}

/** Plain words for what is still missing, e.g. "a peer nod". */
export function describeMissing(missing: readonly MissingNod[]): string {
  return joinAnd(
    missing.map((m) => (m.kind === "named" ? `a nod from ${m.login}` : `a ${m.kind} nod`)),
  );
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function dedupe(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of logins) {
    const key = l.toLowerCase();
    if (!l || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}
