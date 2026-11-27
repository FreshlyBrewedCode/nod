/**
 * Keyboard focus across the visible rows: PR rows (`pr:<repo>#482`) and cluster
 * rows (`cluster:background`), in screen order, the rows of an expanded
 * cluster included. Focus is a key, not an index, so it survives snapshots.
 */

import type { PrId, RepoKey } from "../../shared/protocol";
import { prId } from "../../shared/repo-key";

export type FocusKey = string;

/** A PR row's key: `pr:<PR id>`, `pr:tallyho/fieldbook#482`. */
export const prKey = (id: PrId): FocusKey => `pr:${id}`;
export const clusterKey = (id: string): FocusKey => `cluster:${id}`;

/** The PR id of a PR row's key, else null. */
export function prOfKey(key: FocusKey | null): PrId | null {
  return key?.startsWith("pr:") ? key.slice(3) : null;
}

/**
 * One step (`delta` +1 down, −1 up) from `current`, stopping at the ends.
 * Without a focus (or a focus that is gone), down starts at the top and up
 * at the bottom.
 */
export function moveFocus(
  keys: ReadonlyArray<FocusKey>,
  current: FocusKey | null,
  delta: number,
): FocusKey | null {
  if (keys.length === 0) return null;
  const i = current === null ? -1 : keys.indexOf(current);
  if (i < 0) return delta >= 0 ? keys[0]! : keys[keys.length - 1]!;
  return keys[Math.max(0, Math.min(keys.length - 1, i + delta))]!;
}

type PrIdentity = { readonly repo: RepoKey; readonly number: number };

/** The focusable rows of items in screen order: a cluster, then its PRs when it is open. */
export function itemKeys(
  items: ReadonlyArray<
    | { readonly kind: "pr"; readonly pr: PrIdentity }
    | {
        readonly kind: "cluster";
        readonly id: string;
        readonly prs: ReadonlyArray<PrIdentity>;
      }
  >,
  expanded: ReadonlySet<string>,
): FocusKey[] {
  return items.flatMap((item) =>
    item.kind === "pr"
      ? [prKey(prId(item.pr.repo, item.pr.number))]
      : [
          clusterKey(item.id),
          ...(expanded.has(item.id) ? item.prs.map((p) => prKey(prId(p.repo, p.number))) : []),
        ],
  );
}

export type BoardMove = "left" | "right" | "up" | "down";

/**
 * Focus on the board: `up`/`down` within a column (stopping at its ends),
 * `left`/`right` to the next column that has cards, at the same height or
 * its last card. Without a focus (or one that is gone) any move starts at
 * the first card of the first column with cards.
 */
export function moveBoardFocus(
  columns: ReadonlyArray<ReadonlyArray<FocusKey>>,
  current: FocusKey | null,
  move: BoardMove,
): FocusKey | null {
  const first = columns.find((c) => c.length > 0);
  if (!first) return null;
  const col = current === null ? -1 : columns.findIndex((c) => c.includes(current));
  if (col < 0) return first[0]!;
  const keys = columns[col]!;
  const row = keys.indexOf(current!);
  if (move === "up" || move === "down") {
    const next = Math.max(0, Math.min(keys.length - 1, row + (move === "down" ? 1 : -1)));
    return keys[next]!;
  }
  const step = move === "right" ? 1 : -1;
  for (let i = col + step; i >= 0 && i < columns.length; i += step) {
    const target = columns[i]!;
    if (target.length) return target[Math.min(row, target.length - 1)]!;
  }
  return current;
}

/**
 * Where focus goes when the rows change: it stays on its row; if that row
 * left (an FYI acked, a PR signed and moved lanes), it takes the row that
 * now sits where it was, else the last one.
 */
export function reconcileFocus(
  before: ReadonlyArray<FocusKey>,
  after: ReadonlyArray<FocusKey>,
  current: FocusKey | null,
): FocusKey | null {
  if (current === null || after.includes(current)) return current;
  if (after.length === 0) return null;
  const i = before.indexOf(current);
  if (i < 0) return null;
  // The first row after it that is still there, else the one before.
  for (const key of before.slice(i + 1)) if (after.includes(key)) return key;
  for (const key of before.slice(0, i).reverse()) if (after.includes(key)) return key;
  return after[Math.min(i, after.length - 1)]!;
}
