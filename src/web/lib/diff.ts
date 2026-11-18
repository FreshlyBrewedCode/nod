/**
 * The diff indicator of r3: `+312 −88` and a quiet 38 px bar whose length is
 * the size on a log scale up to 1,000 lines, split into added and removed.
 * The counts already leave out lockfiles and generated files (`DiffStats`).
 */

/** At this many changed lines the bar is full. */
export const DIFF_BAR_FULL_AT = 1000;

export interface DiffBar {
  /** Share of the bar's track, 0–100, for the added part. */
  readonly added: number;
  /** Share of the bar's track, 0–100, for the removed part. */
  readonly removed: number;
}

/**
 * The bar's two parts in percent of its track. Length = log10(lines + 1) /
 * log10(1,001), capped at 100 %; it is split by the added/removed ratio.
 */
export function diffBar(added: number, removed: number): DiffBar {
  const a = Math.max(0, added);
  const r = Math.max(0, removed);
  const total = a + r;
  if (total === 0) return { added: 0, removed: 0 };
  const length = Math.min(100, (Math.log10(total + 1) / Math.log10(DIFF_BAR_FULL_AT + 1)) * 100);
  const addedPart = (length * a) / total;
  return { added: addedPart, removed: length - addedPart };
}

const count = (n: number) => n.toLocaleString("en-US");

/** `+312` and `−88` (a real minus sign), thousands grouped. */
export function diffNumbers(added: number, removed: number): { added: string; removed: string } {
  return { added: `+${count(added)}`, removed: `−${count(removed)}` };
}
