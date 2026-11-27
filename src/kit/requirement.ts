/**
 * What a PR needs before the `nod` check turns green, and how several
 * requirements combine: always to the strictest, so no rule can lower what
 * another rule asked for.
 *
 * - `none`: nothing; the PR may auto-merge.
 * - `self`: any enrolled human nods, typically the one who prompted the agent,
 *   or anyone with write access approves on GitHub.
 * - `peer`: someone other than the PR author nods, or approves on GitHub.
 * - `named(login)`: that person nods or approves.
 *
 * A GitHub approval counts by default (ADR 0006). `peer({ approvals: false })`,
 * `self({ approvals: false })` and `named("bob", { approvals: false })` ask
 * for a nod only: a slot an approval never fills. `peer` and `self` stay plain
 * requirements as well, so `(f) => f.risk >= 3 && peer` keeps working.
 *
 * `peer` ≥ `self` ≥ `none`. A `named` person adds to the level instead of
 * replacing it, and their nod also counts toward the level: `peer` plus
 * `named("bob")` on alice's PR is satisfied by bob alone, because bob's nod
 * is a peer nod. `named("alice")` on alice's own PR is satisfied by her self
 * nod; combined with `peer` it still needs someone else as well.
 */

/** How many eyes, ordered `none` < `self` < `peer`. */
export type RequirementLevel = "none" | "self" | "peer";

/** The part of a requirement that only nods fill, never a GitHub approval. */
export interface NodsOnly {
  readonly level: RequirementLevel;
  /** Logins whose slot only their nod fills, compared case-insensitively. */
  readonly named: readonly string[];
}

/** A requirement: a level plus specific people who must nod or approve. */
export interface Requirement {
  readonly level: RequirementLevel;
  /** Logins that must each nod (or approve), compared case-insensitively. */
  readonly named: readonly string[];
  /**
   * What only nods fill. Absent: a GitHub approval may fill every slot. It is
   * part of the requirement, so `level` and `named` already include it.
   */
  readonly nodsOnly?: NodsOnly;
}

/** Options of {@link peer}, {@link self} and {@link named}. */
export interface RequirementOptions {
  /** Whether a GitHub approval fills the slot (default `true`). `false`: nods only. */
  readonly approvals?: boolean;
}

/** A level that is a requirement as it is and, called with options, makes one. */
export type LevelRequirement = Requirement & ((options?: RequirementOptions) => Requirement);

/**
 * One slot the PR still waits for. `approval` says whether a GitHub approval
 * would fill it; absent (summaries of older verifiers) means a nod only.
 */
export type MissingNod =
  | { kind: "self"; login: string; approval?: boolean }
  | { kind: "peer"; approval?: boolean }
  | { kind: "named"; login: string; approval?: boolean };

/** No nod needed: the PR may merge on its own. */
export const none: Requirement = Object.freeze({ level: "none", named: Object.freeze([]) });

function levelRequirement(level: "self" | "peer"): LevelRequirement {
  const make = (options: RequirementOptions = {}): Requirement =>
    options.approvals === false
      ? { level, named: [], nodsOnly: { level, named: [] } }
      : { level, named: [] };
  const named: readonly string[] = Object.freeze([]);
  return Object.freeze(Object.assign(make, { level, named }));
}

/**
 * Any enrolled human nods, the prompter attesting their own agent's work is
 * enough; or anyone with write access approves. `self({ approvals: false })`:
 * a nod only.
 */
export const self: LevelRequirement = levelRequirement("self");
/**
 * Someone other than the PR author nods or approves.
 * `peer({ approvals: false })`: a peer's nod only.
 */
export const peer: LevelRequirement = levelRequirement("peer");

/**
 * These people must each nod or approve (in addition to whatever level other
 * rules ask for). A last argument `{ approvals: false }` asks them for a nod.
 */
export function named(
  ...args: [...logins: string[], options: RequirementOptions] | string[]
): Requirement {
  const all: ReadonlyArray<string | RequirementOptions> = args;
  const last = all[all.length - 1];
  const options: RequirementOptions = typeof last === "object" && last !== null ? last : {};
  const logins = dedupe(all.filter((a): a is string => typeof a === "string"));
  return options.approvals === false
    ? { level: "none", named: logins, nodsOnly: { level: "none", named: logins } }
    : { level: "none", named: logins };
}

const RANK: Record<RequirementLevel, number> = { none: 0, self: 1, peer: 2 };

/**
 * Combines requirements into the strictest: the highest level and everyone
 * named by any of them, and the same for the part only nods fill.
 */
export function strictest(...requirements: readonly Requirement[]): Requirement {
  let level: RequirementLevel = "none";
  let nodLevel: RequirementLevel = "none";
  const people: string[] = [];
  const nodPeople: string[] = [];
  for (const r of requirements) {
    if (RANK[r.level] > RANK[level]) level = r.level;
    people.push(...r.named);
    if (r.nodsOnly) {
      if (RANK[r.nodsOnly.level] > RANK[nodLevel]) nodLevel = r.nodsOnly.level;
      people.push(...r.nodsOnly.named);
      nodPeople.push(...r.nodsOnly.named);
      if (RANK[r.nodsOnly.level] > RANK[level]) level = r.nodsOnly.level;
    }
  }
  const named = dedupe(people);
  if (nodLevel === "none" && nodPeople.length === 0) return { level, named };
  return { level, named, nodsOnly: { level: nodLevel, named: dedupe(nodPeople) } };
}

/** Whether `a` asks for at least as much as `b`. */
export function atLeast(a: Requirement, b: Requirement): boolean {
  if (RANK[a.level] < RANK[b.level]) return false;
  const have = new Set(a.named.map((n) => n.toLowerCase()));
  if (!b.named.every((n) => have.has(n.toLowerCase()))) return false;
  const an = nodsOnlyOf(a);
  const bn = nodsOnlyOf(b);
  if (RANK[an.level] < RANK[bn.level]) return false;
  const haveNod = new Set(an.named.map((n) => n.toLowerCase()));
  return bn.named.every((n) => haveNod.has(n.toLowerCase()));
}

/** The part of `r` only nods fill (`none` and nobody when absent). */
export function nodsOnlyOf(r: Requirement): NodsOnly {
  return r.nodsOnly ?? { level: "none", named: [] };
}

/**
 * Plain words for a requirement, e.g. "a peer approval or nod and a nod
 * from bob".
 */
export function describeRequirement(r: Requirement): string {
  const nods = nodsOnlyOf(r);
  const nodNamed = new Set(nods.named.map((n) => n.toLowerCase()));
  const parts: string[] = [];
  if (RANK[nods.level] >= RANK[r.level]) {
    if (nods.level !== "none") parts.push(slotWords(nods.level, false));
  } else {
    parts.push(slotWords(r.level as "self" | "peer", true));
    if (nods.level !== "none") parts.push(slotWords(nods.level, false));
  }
  for (const n of r.named) parts.push(namedWords(n, !nodNamed.has(n.toLowerCase())));
  return parts.length ? joinAnd(parts) : "no nod";
}

/** Plain words for what is still missing, e.g. "a peer approval or nod". */
export function describeMissing(missing: readonly MissingNod[]): string {
  return joinAnd(
    missing.map((m) =>
      m.kind === "named"
        ? namedWords(m.login, m.approval === true)
        : slotWords(m.kind, m.approval === true),
    ),
  );
}

function slotWords(level: "self" | "peer", approval: boolean): string {
  if (!approval) return `a ${level} nod`;
  return level === "peer" ? "a peer approval or nod" : "a self nod or an approval";
}

function namedWords(login: string, approval: boolean): string {
  return approval ? `an approval or nod from ${login}` : `a nod from ${login}`;
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
