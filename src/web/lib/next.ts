/**
 * "1 of 6 that need you" and `Next ›` on a phone's detail page, and "Open the
 * last one" on the signed sheet: which PR comes after which in the Needs you
 * lane. Pure; the lane's order is `attentionView`'s (the list's order).
 */

import type { Item } from "../../shared/attention";
import type { PrId } from "../../shared/protocol";
import { idOf } from "../../shared/repo-key";

/** The PRs (their ids, `<repo>#<n>`) of the Needs you lane, in the order the list shows them. */
export function needsYouOrder(items: ReadonlyArray<Item>): ReadonlyArray<PrId> {
  return items.flatMap((item) => (item.kind === "pr" ? [idOf(item.pr)] : item.prs.map(idOf)));
}

/** Where a PR stands among those that need you: "1 of 6", or null when it is not one of them. */
export function positionAmong(
  order: ReadonlyArray<PrId>,
  pr: PrId,
): { index: number; total: number } | null {
  const i = order.indexOf(pr);
  return i < 0 ? null : { index: i + 1, total: order.length };
}

/**
 * The PR `Next ›` opens: the one after this in the order, nothing after the
 * last. A PR that is not (or no longer) one of those that need you, such as
 * one just signed or an FYI, takes the first of them. Null when there is none.
 */
export function nextNeedingYou(order: ReadonlyArray<PrId>, pr: PrId): PrId | null {
  const i = order.indexOf(pr);
  if (i < 0) return order[0] ?? null;
  return order[i + 1] ?? null;
}

/**
 * The one PR left that needs me once these are signed (`signed`), else null:
 * "Open the last one" shows only when there is exactly one.
 */
export function lastOneLeft(order: ReadonlyArray<PrId>, signed: ReadonlyArray<PrId>): PrId | null {
  const left = order.filter((n) => !signed.includes(n));
  return left.length === 1 ? left[0]! : null;
}
