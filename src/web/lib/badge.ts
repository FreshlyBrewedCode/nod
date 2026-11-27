/**
 * The badge (ADR 0008 §10): the count of my tier 1 rows (`badgeCount` in
 * `src/shared/attention.ts`) on the app's icon where the browser has
 * `navigator.setAppBadge`, cleared at 0, and in the tab title, `(n) nod`,
 * always. The icon's badge can be turned off per viewer (Settings → App,
 * `nod.badge`); the title stays.
 */

import { STORAGE_KEYS, readJson, writeJson } from "./storage";
import type { KeyValue } from "./connection";

/** The tab title for `n` (null: no snapshot yet, or none any more). */
export function titleFor(n: number | null): string {
  return n ? `(${n}) nod` : "nod";
}

/** What the browser offers for the icon's badge (`navigator`, injectable). */
export interface BadgeApi {
  setAppBadge?(n?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

/** Whether this browser can badge the app's icon at all. */
export function canBadge(api: BadgeApi | null | undefined): boolean {
  return typeof api?.setAppBadge === "function";
}

/**
 * Show `n` on the icon, or clear it (0, unknown, or turned off). Never
 * throws: a browser that refuses (not installed, no permission) shows the
 * title only.
 */
export function applyBadge(api: BadgeApi | null | undefined, n: number | null, on: boolean): void {
  if (!canBadge(api)) return;
  const done = (p: Promise<void> | undefined) => void p?.catch(() => {});
  try {
    if (on && n) done(api!.setAppBadge!(n));
    else done(api!.clearAppBadge?.() ?? api!.setAppBadge!(0));
  } catch {
    // a browser that throws instead of rejecting
  }
}

/** The viewer's switch for the icon's badge; on unless turned off. */
export function readBadgeOn(storage: KeyValue | null): boolean {
  return readJson(storage, STORAGE_KEYS.badge) !== false;
}

export function writeBadgeOn(storage: KeyValue | null, on: boolean): void {
  writeJson(storage, STORAGE_KEYS.badge, on);
}
