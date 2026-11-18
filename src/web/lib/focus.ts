/**
 * Keyboard focus across the visible rows: PR rows (`pr:482`) and cluster
 * rows (`cluster:background`), in screen order, the rows of an expanded
 * cluster included. Focus is a key, not an index, so it survives snapshots.
 */

export type FocusKey = string;

export const prKey = (n: number): FocusKey => `pr:${n}`;
export const clusterKey = (id: string): FocusKey => `cluster:${id}`;

/** The PR number of a PR row's key, else null. */
export function prOfKey(key: FocusKey | null): number | null {
  const m = key?.match(/^pr:(\d+)$/);
  return m ? Number(m[1]) : null;
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
