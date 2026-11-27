/**
 * What this browser remembers, besides the pairing (`connection.ts`): the
 * panel, the PRs opened in the UI, the dismissed legend and offers, the last
 * visit, the board's grouping, the repo filter and the badge switch.
 * JSON in localStorage under `nod.*`; a broken or blocked storage reads as
 * nothing and never throws.
 */

import type { KeyValue } from "./connection";

export const STORAGE_KEYS = {
  panel: "nod.panel",
  opened: "nod.opened",
  legend: "nod.legend",
  lastVisit: "nod.lastVisit",
  /** The board's group-by: "wait", "state" or "repo" (`readGroup`). */
  board: "nod.board",
  /** The repo filter: a repo key, or null for all (`readRepoFilter` in `repos.ts`). */
  repoFilter: "nod.repoFilter",
  /** The offers put away with "Not now" (`offerKey` in `onboarding.ts`), per repo and step. */
  offers: "nod.offers",
  /** The app icon's badge: false when turned off (`readBadgeOn` in `badge.ts`). */
  badge: "nod.badge",
  /** My inbox's errors put away from the banner (`readDismissed` in `personal.ts`), by text. */
  inboxErrors: "nod.inboxErrors",
} as const;

export function browserStorage(): KeyValue | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readJson(storage: KeyValue | null, key: string): unknown {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

export function writeJson(storage: KeyValue | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // full or blocked: forgetting is fine
  }
}

// ---------------------------------------------------------------------------
// the board's grouping

export type GroupBy = "wait" | "state" | "repo";

/**
 * The board's remembered grouping. "repo" only while there are several repos
 * (with one the option is not offered): else, and for anything unknown,
 * "wait", the board's own.
 */
export function readGroup(value: unknown, manyRepos: boolean): GroupBy {
  if (value === "state") return "state";
  if (value === "repo" && manyRepos) return "repo";
  return "wait";
}

// ---------------------------------------------------------------------------
// "opened in the UI", for the batch dialog's "not opened" mark (concept 14)

/** `owner/repo#482` → when its details were last shown. */
export type Opened = Readonly<Record<string, number>>;

export const openedKey = (repo: string, pr: number) => `${repo}#${pr}`;

/** How many PRs are remembered; the oldest are dropped beyond it. */
export const OPENED_LIMIT = 500;

export function readOpened(value: unknown): Opened {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, at]) => typeof at === "number" && Number.isFinite(at)),
  ) as Opened;
}

export function markOpened(opened: Opened, repo: string, pr: number, at: number): Opened {
  const next = { ...opened, [openedKey(repo, pr)]: at };
  const entries = Object.entries(next);
  if (entries.length <= OPENED_LIMIT) return next;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, OPENED_LIMIT));
}

export function wasOpened(opened: Opened, repo: string, pr: number): boolean {
  return openedKey(repo, pr) in opened;
}
