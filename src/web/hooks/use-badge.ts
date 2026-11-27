/**
 * The badge (ADR 0008 §10, `lib/badge.ts`): the count of my tier 1 rows in
 * the tab title, always, and on the app's icon unless turned off. `count`
 * is null without a snapshot, which clears both. The switch lives in
 * `nod.badge`; every user of `useBadgeOn` in this tab hears a change at
 * once, other tabs through `storage`.
 */

import { useEffect, useSyncExternalStore } from "react";

import { applyBadge, readBadgeOn, titleFor, writeBadgeOn, type BadgeApi } from "@/lib/badge";
import { STORAGE_KEYS, browserStorage } from "@/lib/storage";

const api = () => (typeof navigator === "undefined" ? null : (navigator as BadgeApi));

let on: boolean | null = null;
const listeners = new Set<() => void>();
const current = () => (on ??= readBadgeOn(browserStorage()));
const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
};
function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEYS.badge && event.key !== null) return;
  on = readBadgeOn(browserStorage());
  changed();
}
function setOn(next: boolean) {
  writeBadgeOn(browserStorage(), next);
  on = next;
  changed();
}

/** The switch, for Settings → App and the root. */
export function useBadgeOn(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, current), setOn];
}

/** Show `count` in the title and on the icon; once, at the root. */
export function useBadge(count: number | null): void {
  const [enabled] = useBadgeOn();
  useEffect(() => {
    document.title = titleFor(count);
    applyBadge(api(), count, enabled);
  }, [count, enabled]);
}
