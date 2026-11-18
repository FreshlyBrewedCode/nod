/**
 * Who gets how much room: the attention tiers of `docs/design/r3/README.md`
 * and the three ways the r3 UI lays PRs out (lanes by attention, time
 * buckets in the chronological view, "Waiting on" columns on the board).
 *
 * Pure: everything comes in through the arguments, time included (`now`).
 * The web app renders what these return; the server never calls them.
 */

import type { Login, Person, PrView, WaitingOn } from "./protocol";

/** 1 prominent · 2 normal · 3 one line · 4 folded into a cluster. */
export type Tier = 1 | 2 | 3 | 4;

export type TierInput = Pick<PrView, "needsMe" | "risk" | "mine" | "fyiForMe" | "stuck" | "state">;

/**
 * The tier rule, first match wins:
 *
 * 1. needs me, and high risk or a teammate's work → 1
 * 2. needs me (my own work, risk ≤ 2) → 2
 * 3. an FYI I have not acked → 3
 * 4. still open, and (mine and stuck) or high risk → 3
 * 5. everything else → 4
 *
 * The README says "not merged" in rule 4; a closed PR counts as merged here,
 * since neither will change any more.
 */
export function tier(p: TierInput): Tier {
  if (p.needsMe) return p.risk >= 3 || !p.mine ? 1 : 2;
  if (p.fyiForMe) return 3;
  if (!isDone(p) && ((p.mine && p.stuck !== null) || p.risk >= 3)) return 3;
  return 4;
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
    tier(a) - tier(b) || b.risk - a.risk || waitedSince(a) - waitedSince(b) || a.number - b.number
  );
}

/** Newest activity first. */
export function compareActivity(a: PrView, b: PrView): number {
  return b.lastActivity.at - a.lastActivity.at || b.number - a.number;
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
  /** "3 deps · 2 tier 1 · 1 docs · 1 signed by you" */
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

/**
 * What a folded PR counts as in the cluster's subtitle: a dependency bump,
 * docs, something I signed (and that now merges on its own), else its first
 * classifier tag ("tier 1").
 */
export function clusterKind(p: PrView): string {
  if (p.tags.includes("deps")) return "deps";
  if (p.tags.includes("docs")) return "docs";
  if (p.signatures.some((s) => s.byMe && s.counts)) return "signed by you";
  return p.tags[0] ?? "other";
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
    subtitle: kinds.map((k) => `${k.count} ${k.kind}`).join(" · "),
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
  readonly login: Login | null;
  /** PRs in the column, folded ones included. */
  readonly count: number;
  readonly items: ReadonlyArray<Item>;
  /** PRs in another column that wait on this one too, later: "also #485, after you". */
  readonly also: ReadonlyArray<number>;
}

export interface BoardOptions {
  readonly me: Login;
  /** For the teammates' column titles; the login is used when a name is missing. */
  readonly people?: ReadonlyArray<Person>;
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
 * Columns: You (always), one per teammate something waits on (the most PRs
 * first), Any teammate (when some PR needs a peer I cannot be), Agents & CI
 * (always), Merged (always). In a column: cards by `compareAttention`, the
 * folded ones as one cluster at the end (merged ones newest first).
 */
export function boardView(
  prs: ReadonlyArray<PrView>,
  options: BoardOptions,
): ReadonlyArray<Column> {
  const { me, people = [] } = options;
  const groups = new Map<
    string,
    { kind: ColumnKind; login: Login | null; prs: PrView[]; also: number[] }
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
      if (!g.also.includes(p.number)) g.also.push(p.number);
    }
  }

  const rank: Record<ColumnKind, number> = { me: 0, person: 1, anyone: 2, automation: 3, done: 4 };
  const order = (g: { kind: ColumnKind; prs: PrView[] }) =>
    rank[g.kind] * 1e6 - (g.kind === "person" ? g.prs.length : 0);
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
    .map(([id, g]): Column => {
      const done = g.kind === "done";
      const cards = g.prs
        .filter((p) => tier(p) < 4)
        .sort(done ? compareActivity : compareAttention)
        .map(item);
      return {
        id,
        kind: g.kind,
        title: title(g.kind, g.login),
        login: g.login,
        count: g.prs.length,
        items: [
          ...cards,
          ...folded(
            `column:${id}`,
            g.prs.filter((p) => tier(p) === 4),
          ),
        ],
        also: g.also,
      };
    });
}

// ---------------------------------------------------------------------------
// counts, for summaries and the proof page

export function countByTier(prs: ReadonlyArray<PrView>): Readonly<Record<Tier, number>> {
  const counts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of prs) counts[tier(p)]++;
  return counts;
}
