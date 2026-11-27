/**
 * Who gets how much room: the attention tiers of `docs/design/r3/README.md`
 * and the three ways the r3 UI lays PRs out (lanes by attention, time
 * buckets in the chronological view, "Waiting on" columns on the board).
 *
 * Pure: everything comes in through the arguments, time included (`now`).
 * The web app renders what these return; the server never calls them.
 */

import type { Login, Person, PrId, PrView, RepoKey, WaitingOn } from "./protocol";
import { idOf, sameRepo } from "./repo-key";

/** 1 prominent · 2 normal · 3 one line · 4 folded into a cluster. */
export type Tier = 1 | 2 | 3 | 4;

export type TierInput = Pick<
  PrView,
  | "needsMe"
  | "risk"
  | "mine"
  | "fyiForMe"
  | "stuck"
  | "state"
  | "ask"
  | "waitingOn"
  | "classifiedBy"
>;

/**
 * The tier rule, first match wins:
 *
 * 1. needs me, and high risk or a teammate's work → 1
 * 2. needs me (my own work, risk ≤ 2) → 2
 * 3. an FYI I have not acked → 3
 * 4. waits on my nod, but my key cannot sign yet (`waitsOnMyKey`) → 3, so it
 *    is never folded away just because nothing is signable
 * 5. still open, and (mine and stuck) or high risk → 3
 * 6. everything else → 4
 *
 * The README says "not merged" in rule 4; a closed PR counts as merged here,
 * since neither will change any more.
 *
 * At the inbox step (classified locally, no policy) the same rule applies:
 * `needsMe` is then a review requested from me or my team (a teammate's
 * work: tier 1), or my own PR stuck by a failing check, a conflict or
 * requested changes (tier 2, tier 1 at high risk).
 */
export function tier(p: TierInput): Tier {
  if (p.needsMe) return p.risk >= 3 || !p.mine ? 1 : 2;
  if (p.fyiForMe) return 3;
  if (waitsOnMyKey(p)) return 3;
  if (!isDone(p) && ((p.mine && p.stuck !== null) || p.risk >= 3)) return 3;
  return 4;
}

/**
 * An open PR with a slot my nod would fill, but no ask: with no key, a
 * pending or a not enrolled one nothing is signable (ADR 0002), and a GitHub
 * approval does not fill this slot (it is nod-only, or the PR is mine, which
 * GitHub does not let me approve), so `needsMe` is false while `waitingOn`
 * still names me. It waits on me once my key is enrolled. A locally
 * classified PR has no slots: what it waits on me for is a review on GitHub,
 * which needs no key.
 */
export function waitsOnMyKey(
  p: Pick<PrView, "state" | "ask" | "waitingOn" | "classifiedBy">,
): boolean {
  return (
    p.classifiedBy !== "local" &&
    p.state === "open" &&
    p.ask === null &&
    p.waitingOn.some((w) => w.kind === "me")
  );
}

export function isDone(p: Pick<PrView, "state">): boolean {
  return p.state === "merged" || p.state === "closed";
}

/** How long it has waited on a human, for sorting: the oldest first. */
function waitedSince(p: PrView): number {
  return p.waitingSince ?? p.openedAt;
}

/**
 * The order of "Needs you" (and of a board column): tier, then risk (high
 * first), then age (the longest wait first). The PR number breaks ties so
 * the order never jumps between snapshots.
 */
export function compareAttention(a: PrView, b: PrView): number {
  return (
    tier(a) - tier(b) ||
    b.risk - a.risk ||
    waitedSince(a) - waitedSince(b) ||
    a.number - b.number ||
    a.repo.localeCompare(b.repo)
  );
}

/** Newest activity first. */
export function compareActivity(a: PrView, b: PrView): number {
  return (
    b.lastActivity.at - a.lastActivity.at || b.number - a.number || a.repo.localeCompare(b.repo)
  );
}

// ---------------------------------------------------------------------------
// items: a PR row, or a cluster of folded PRs

export interface PrItem {
  readonly kind: "pr";
  readonly pr: PrView;
  readonly tier: Tier;
  /**
   * The form to draw it in. Its tier, except for a tier-4 PR that is not
   * folded (alone in its bucket or lane): form 4 is then a dim one-liner in
   * place.
   */
  readonly form: Tier;
}

/** "7 low-risk changes · 3 deps · 2 tier 1 · 1 docs · 1 signed by you". */
export interface ClusterItem {
  readonly kind: "cluster";
  /** Stable across snapshots: the lane, bucket or column it ends. */
  readonly id: string;
  /** Newest activity first. */
  readonly prs: ReadonlyArray<PrView>;
  /** "7 low-risk changes" */
  readonly label: string;
  /** "3 deps · 2 tier 1 · 1 docs · 1 signed by you": at most 4 kinds, then "· +2 more" */
  readonly subtitle: string;
  readonly kinds: ReadonlyArray<{ readonly kind: string; readonly count: number }>;
  readonly added: number;
  readonly removed: number;
  readonly merged: number;
  readonly open: number;
}

export type Item = PrItem | ClusterItem;

const item = (pr: PrView): PrItem => {
  const t = tier(pr);
  return { kind: "pr", pr, tier: t, form: t };
};

/** Size tags say how big, not what kind of change: the subtitle leaves them out. */
const SIZE_TAG = /^size:(s|m|l|xl)$/;

/** `size:s` … `size:xl`, the diff size classifier's tags: the diff indicator says it already. */
export function isSizeTag(tag: string): boolean {
  return SIZE_TAG.test(tag);
}

/**
 * A policy tag in words: `tier-2` and `tier 2` -> "tier 2", `protected` ->
 * "protected paths", `deps-only` -> "deps". Anything else stays as it is.
 */
export function tagWording(tag: string): string {
  const tierTag = /^tier[- ](\d+)$/.exec(tag);
  if (tierTag) return `tier ${tierTag[1]}`;
  if (tag === "protected") return "protected paths";
  if (tag === "deps-only") return "deps";
  return tag;
}

/**
 * What a folded PR counts as in the cluster's subtitle: a dependency bump,
 * docs, something I signed (and that now merges on its own), else its first
 * tag that is not a size, in words ("tier 1", "protected paths"), else "other".
 */
export function clusterKind(p: PrView): string {
  if (p.tags.some((t) => t === "deps" || t === "deps-only")) return "deps";
  if (p.tags.includes("docs")) return "docs";
  if (p.signatures.some((s) => s.byMe && s.counts)) return "signed by you";
  const tag = p.tags.find((t) => !SIZE_TAG.test(t));
  return tag === undefined ? "other" : tagWording(tag);
}

/** How many kinds the subtitle names before it says "+N more". */
export const SUBTITLE_KINDS = 4;

/**
 * The kinds a cluster names, as the words a subtitle and the board's
 * cluster card show: the `SUBTITLE_KINDS` most frequent ("3 deps", or just
 * "deps" without counts), then "+N more" for the kinds left out, never a
 * cut-off word.
 */
export function kindNames(kinds: ClusterItem["kinds"], counts: boolean): string[] {
  const names = kinds
    .slice(0, SUBTITLE_KINDS)
    .map((k) => (counts ? `${k.count} ${k.kind}` : k.kind));
  if (kinds.length > SUBTITLE_KINDS) names.push(`+${kinds.length - SUBTITLE_KINDS} more`);
  return names;
}

/** The most common kind first; ties keep the order they first appear in. */
export function clusterKinds(prs: ReadonlyArray<PrView>): ClusterItem["kinds"] {
  const counts = new Map<string, number>();
  for (const p of prs) counts.set(clusterKind(p), (counts.get(clusterKind(p)) ?? 0) + 1);
  return [...counts]
    .map(([kind, count], order) => ({ kind, count, order }))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ kind, count }) => ({ kind, count }));
}

export function cluster(id: string, prs: ReadonlyArray<PrView>): ClusterItem {
  const sorted = [...prs].sort(compareActivity);
  const kinds = clusterKinds(sorted);
  const merged = sorted.filter((p) => p.state === "merged").length;
  return {
    kind: "cluster",
    id,
    prs: sorted,
    label: `${sorted.length} low-risk change${sorted.length === 1 ? "" : "s"}`,
    subtitle: kindNames(kinds, true).join(" · "),
    kinds,
    added: sorted.reduce((n, p) => n + p.diff.added, 0),
    removed: sorted.reduce((n, p) => n + p.diff.removed, 0),
    merged,
    open: sorted.filter((p) => !isDone(p)).length,
  };
}

/** Tier-4 PRs at the end of a group: one cluster, or the one PR in place, or nothing. */
function folded(id: string, prs: ReadonlyArray<PrView>): Item[] {
  if (prs.length === 0) return [];
  if (prs.length === 1) return [{ ...item(prs[0]!), form: 4 }];
  return [cluster(id, prs)];
}

// ---------------------------------------------------------------------------
// the list, by attention

export type Lane = "needs" | "know" | "background";

/** Needs you: waits on my nod. Worth knowing: an FYI for me. Background: the rest. */
export function lane(p: Pick<PrView, "needsMe" | "fyiForMe">): Lane {
  if (p.needsMe) return "needs";
  if (p.fyiForMe) return "know";
  return "background";
}

export const LANE_TITLES: Readonly<Record<Lane, string>> = {
  needs: "Needs you",
  know: "Worth knowing",
  background: "Background",
};

export interface LaneView {
  readonly lane: Lane;
  readonly title: string;
  /** PRs in the lane, folded ones included. */
  readonly count: number;
  readonly items: ReadonlyArray<Item>;
}

/**
 * The three lanes, always all three (an empty one shows its empty state):
 * - Needs you, by `compareAttention`;
 * - Worth knowing, newest activity first;
 * - Background: the one-liners that matter (mine and stuck, high risk),
 *   riskiest first, then one cluster of everything folded.
 */
export function attentionView(prs: ReadonlyArray<PrView>): ReadonlyArray<LaneView> {
  const of = (l: Lane) => prs.filter((p) => lane(p) === l);
  const needs = of("needs").sort(compareAttention);
  const know = of("know").sort(compareActivity);
  const background = of("background");
  const lines = background
    .filter((p) => tier(p) < 4)
    .sort((a, b) => b.risk - a.risk || compareActivity(a, b));
  const view = (l: Lane, count: number, items: Item[]): LaneView => ({
    lane: l,
    title: LANE_TITLES[l],
    count,
    items,
  });
  return [
    view("needs", needs.length, needs.map(item)),
    view("know", know.length, know.map(item)),
    view("background", background.length, [
      ...lines.map(item),
      ...folded(
        "background",
        background.filter((p) => tier(p) === 4),
      ),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// the list, chronological

export type BucketId = "hour" | "today" | "yesterday" | "week" | "older";

export const BUCKET_LABELS: Readonly<Record<BucketId, string>> = {
  hour: "Last hour",
  today: "Earlier today",
  yesterday: "Yesterday",
  week: "This week",
  older: "Older",
};

export interface TimeOptions {
  readonly now: number;
  /**
   * The viewer's offset from UTC in minutes (UTC+1 → 60), for where "today"
   * starts. Defaults to the runtime's own zone at `now`.
   */
  readonly utcOffsetMinutes?: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The start of the viewer's local day that `at` falls in. */
export function startOfDay(at: number, utcOffsetMinutes: number): number {
  const offset = utcOffsetMinutes * 60 * 1000;
  return Math.floor((at + offset) / DAY) * DAY - offset;
}

/**
 * The bucket a time falls in. Buckets grow with age: the last hour, the rest
 * of today, yesterday, the 5 days before (with today and yesterday the
 * last 7 calendar days), then everything older. The future counts as the
 * last hour.
 */
export function bucketOf(at: number, options: TimeOptions): BucketId {
  const { now } = options;
  const offset = options.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset();
  const today = startOfDay(now, offset);
  if (at > now - HOUR) return "hour";
  if (at >= today) return "today";
  if (at >= today - DAY) return "yesterday";
  if (at >= today - 6 * DAY) return "week";
  return "older";
}

export interface Bucket {
  readonly id: BucketId;
  readonly label: string;
  /** PRs in the bucket, folded ones included. */
  readonly count: number;
  readonly items: ReadonlyArray<Item>;
}

/**
 * Sorted by last activity, grouped into time buckets (only those with
 * something in them). Inside a bucket the PRs that are not folded keep their
 * place in time; the bucket's tier-4 PRs become one cluster at its end, or,
 * when there is just one, a dim one-liner in its place.
 */
export function chronologicalView(
  prs: ReadonlyArray<PrView>,
  options: TimeOptions,
): ReadonlyArray<Bucket> {
  const ids = Object.keys(BUCKET_LABELS) as BucketId[];
  const sorted = [...prs].sort(compareActivity);
  return ids.flatMap((id): Bucket[] => {
    const inBucket = sorted.filter((p) => bucketOf(p.lastActivity.at, options) === id);
    if (inBucket.length === 0) return [];
    const low = inBucket.filter((p) => tier(p) === 4);
    const items: Item[] =
      low.length === 1
        ? inBucket.map(item)
        : [...inBucket.filter((p) => tier(p) < 4).map(item), ...folded(`bucket:${id}`, low)];
    return [{ id, label: BUCKET_LABELS[id], count: inBucket.length, items }];
  });
}

// ---------------------------------------------------------------------------
// the board, grouped by "Waiting on"

export type ColumnKind = "me" | "person" | "anyone" | "automation" | "done";

export interface Column {
  /** `me`, `person:<login>`, `anyone`, `automation`, `done`. */
  readonly id: string;
  readonly kind: ColumnKind;
  /** "You", the teammate's first name, "Any teammate", "Agents & CI", "Merged". */
  readonly title: string;
  /**
   * On my column only, when my key cannot sign: "key not enrolled". The column
   * then holds what waits on me once the key is enrolled, not what I can act on.
   */
  readonly note: string | null;
  readonly login: Login | null;
  /** PRs in the column, folded ones included. */
  readonly count: number;
  readonly items: ReadonlyArray<Item>;
  /** PRs (their ids) in another column that wait on this one too, later: "also #485, after you". */
  readonly also: ReadonlyArray<PrId>;
}

export interface BoardOptions {
  readonly me: Login;
  /** For the teammates' column titles; the login is used when a name is missing. */
  readonly people?: ReadonlyArray<Person>;
  /** Why my key cannot sign ("key not enrolled"); null or missing when it can. */
  readonly keyNote?: string | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The column a waiting-on entry puts a PR in. */
function columnOf(w: WaitingOn, me: Login): { id: string; kind: ColumnKind; login: Login | null } {
  switch (w.kind) {
    case "me":
      return { id: "me", kind: "me", login: me };
    case "person":
      return same(w.login, me)
        ? { id: "me", kind: "me", login: me }
        : { id: `person:${w.login.toLowerCase()}`, kind: "person", login: w.login };
    case "anyone":
      return { id: "anyone", kind: "anyone", login: null };
    case "checks":
    case "agent":
    case "merge":
      return { id: "automation", kind: "automation", login: null };
    case "nothing":
      return { id: "done", kind: "done", login: null };
  }
}

function primaryColumn(p: PrView, me: Login) {
  const first = p.waitingOn[0];
  if (first) return columnOf(first, me);
  return isDone(p) ? columnOf({ kind: "nothing" }, me) : columnOf({ kind: "agent" }, me);
}

/** A teammate's first name, or the login. */
export function shortName(login: Login, people: ReadonlyArray<Person> = []): string {
  const person = people.find((p) => same(p.login, login));
  return person?.name?.split(/\s+/)[0] || login;
}

/**
 * Columns: You (always; with a `keyNote` it holds what waits on me once my
 * key can sign, and says so), one per teammate something waits on (the busiest
 * first: their own PRs plus the ones that wait on them later, as in r3),
 * Any teammate (when some PR needs a peer I cannot be), Agents & CI
 * (always), Merged (always). In a column: cards by `compareAttention`, the
 * folded ones as one cluster at the end (merged ones newest first).
 */
export function boardView(
  prs: ReadonlyArray<PrView>,
  options: BoardOptions,
): ReadonlyArray<Column> {
  const { me, people = [], keyNote = null } = options;
  const groups = new Map<
    string,
    { kind: ColumnKind; login: Login | null; prs: PrView[]; also: PrId[] }
  >();
  const group = (c: { id: string; kind: ColumnKind; login: Login | null }) => {
    let g = groups.get(c.id);
    if (!g) groups.set(c.id, (g = { kind: c.kind, login: c.login, prs: [], also: [] }));
    return g;
  };
  for (const id of ["me", "automation", "done"] as const)
    group({ id, kind: id === "me" ? "me" : id, login: id === "me" ? me : null });

  for (const p of prs) {
    const primary = primaryColumn(p, me);
    group(primary).prs.push(p);
    for (const w of p.waitingOn.slice(1)) {
      if (w.kind !== "me" && w.kind !== "person" && w.kind !== "anyone") continue;
      const other = columnOf(w, me);
      if (other.id === primary.id) continue;
      const g = group(other);
      if (!g.also.includes(idOf(p))) g.also.push(idOf(p));
    }
  }

  const rank: Record<ColumnKind, number> = { me: 0, person: 1, anyone: 2, automation: 3, done: 4 };
  const order = (g: { kind: ColumnKind; prs: PrView[]; also: PrId[] }) =>
    rank[g.kind] * 1e6 - (g.kind === "person" ? g.prs.length + g.also.length : 0);
  const title = (kind: ColumnKind, login: Login | null) =>
    kind === "me"
      ? "You"
      : kind === "person"
        ? shortName(login!, people)
        : kind === "anyone"
          ? "Any teammate"
          : kind === "automation"
            ? "Agents & CI"
            : "Merged";

  return [...groups]
    .sort(([ia, a], [ib, b]) => order(a) - order(b) || ia.localeCompare(ib))
    .map(([id, g]): Column => ({
      id,
      kind: g.kind,
      title: title(g.kind, g.login),
      note: g.kind === "me" ? keyNote : null,
      login: g.login,
      count: g.prs.length,
      items: columnItems(id, g.prs, g.kind === "done"),
      also: g.also,
    }));
}

/** A column's cards by attention (or newest first), its folded PRs as one cluster at the end. */
function columnItems(id: string, prs: ReadonlyArray<PrView>, byActivity: boolean): Item[] {
  const cards = prs
    .filter((p) => tier(p) < 4)
    .sort(byActivity ? compareActivity : compareAttention)
    .map(item);
  return [
    ...cards,
    ...folded(
      `column:${id}`,
      prs.filter((p) => tier(p) === 4),
    ),
  ];
}

// ---------------------------------------------------------------------------
// the board, grouped by state (r2 `05`)

export type StateColumnId = "checks" | "signature" | "merging" | "done";

export const STATE_TITLES: Readonly<Record<StateColumnId, string>> = {
  checks: "Checks running",
  signature: "Needs a signature",
  merging: "Signed · merging",
  done: "Merged",
};

/**
 * Where a PR stands, as the board's State columns (r2 `05`): merged or
 * closed; a signature still missing; with the agent or CI (a failing check,
 * a draft, or running checks on a PR that needs no human); else signed, or
 * needing nobody, and merging once its checks are done.
 */
export function stateOf(
  p: Pick<PrView, "state" | "requirement" | "checks" | "needsMe">,
): StateColumnId {
  if (p.state === "merged" || p.state === "closed") return "done";
  if (p.needsMe || !p.requirement.satisfied) return "signature";
  if (p.state === "draft" || p.checks.state === "failing") return "checks";
  if (p.checks.state === "pending" && p.requirement.slots.length === 0) return "checks";
  return "merging";
}

export interface StateColumn {
  readonly id: StateColumnId;
  readonly title: string;
  readonly count: number;
  /** In "Needs a signature": how many of them wait on me. */
  readonly mine: number;
  readonly items: ReadonlyArray<Item>;
}

/**
 * The board grouped by State: Checks running → Needs a signature → Signed ·
 * merging → Merged, always all four. Inside a column the same cards and
 * cluster as the Waiting-on board.
 */
export function stateBoardView(prs: ReadonlyArray<PrView>): ReadonlyArray<StateColumn> {
  return (Object.keys(STATE_TITLES) as StateColumnId[]).map((id) => {
    const inColumn = prs.filter((p) => stateOf(p) === id);
    return {
      id,
      title: STATE_TITLES[id],
      count: inColumn.length,
      mine: inColumn.filter((p) => p.needsMe).length,
      items: columnItems(`state:${id}`, inColumn, id === "done"),
    };
  });
}

// ---------------------------------------------------------------------------
// the board, grouped by repository (ADR 0007, 1)

export interface RepoColumn {
  /** `repo:<key>`, lowercase. */
  readonly id: string;
  readonly repo: RepoKey;
  readonly count: number;
  /** How many of them need me. */
  readonly needsMe: number;
  readonly items: ReadonlyArray<Item>;
}

/**
 * The board grouped by repository: one column per repo, in the list's order
 * (`repos`, the server's: the inbox's), even an empty one. Inside a column
 * the same cards and cluster as the other groupings: cards by attention, the
 * folded ones (merged included) as one cluster at the end. A PR of a repo
 * the list does not hold (dropped meanwhile) is left out.
 */
export function repoBoardView(
  prs: ReadonlyArray<PrView>,
  repos: ReadonlyArray<RepoKey>,
): ReadonlyArray<RepoColumn> {
  return repos.map((repo) => {
    const inColumn = prs.filter((p) => sameRepo(p.repo, repo));
    const id = `repo:${repo.toLowerCase()}`;
    return {
      id,
      repo,
      count: inColumn.length,
      needsMe: inColumn.filter((p) => p.needsMe).length,
      items: columnItems(id, inColumn, false),
    };
  });
}

/**
 * The repo filter (ADR 0007, 1): the PRs of one repo, or all of them when
 * none is chosen.
 */
export function inRepo(prs: ReadonlyArray<PrView>, repo: RepoKey | null): ReadonlyArray<PrView> {
  return repo === null ? prs : prs.filter((p) => sameRepo(p.repo, repo));
}

// ---------------------------------------------------------------------------
// the list's hints and summaries

/**
 * Whether a row gets a checkbox for the batch: only tiers 1 and 2, the ones
 * that need me (r3 open question 5), and only with something to do there
 * (`ask`: a nod, or a GitHub approval without a key); my own stuck PR at the
 * inbox step has none. One-liners and folded PRs never need me.
 */
export function selectable(p: TierInput): boolean {
  return p.ask !== null && tier(p) <= 2;
}

/**
 * Since when the longest-waiting PR of "Needs you" has waited on me, for the
 * lane's hint "oldest waits 5 hours"; null when nothing needs me.
 */
export function oldestWaitingSince(prs: ReadonlyArray<PrView>): number | null {
  const waiting = prs.filter((p) => p.needsMe).map(waitedSince);
  return waiting.length ? Math.min(...waiting) : null;
}

/**
 * What merged on its own since a time, for "Since yesterday 17:42: 5 merged on
 * their own": merged PRs that carry no nod of mine, and that an enforced
 * policy let through (not classified locally, not a check that is not
 * required yet: there a person merged it).
 */
export function mergedOnTheirOwn(prs: ReadonlyArray<PrView>, since: number): number {
  return prs.filter(
    (p) =>
      p.state === "merged" &&
      // At the inbox step, and before the check is required, a person merged it.
      p.classifiedBy !== "local" &&
      p.requirement.enforced !== false &&
      p.mergedAt !== null &&
      p.mergedAt >= since &&
      !p.signatures.some((s) => s.byMe),
  ).length;
}

// ---------------------------------------------------------------------------
// counts, for summaries and the proof page

export function countByTier(prs: ReadonlyArray<PrView>): Readonly<Record<Tier, number>> {
  const counts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of prs) counts[tier(p)]++;
  return counts;
}

/**
 * The app's badge (ADR 0008 §10): my tier 1 rows, across every repo (the
 * repo filter does not narrow it), open ones only. What the icon and the
 * tab title `(n) nod` show.
 */
export function badgeCount(prs: ReadonlyArray<PrView>): number {
  return prs.filter((p) => !isDone(p) && tier(p) === 1).length;
}
