/**
 * Whether the window is a phone's (`lib/phone.ts`), for the places where
 * behaviour, not just layout, differs. Layout alone is CSS: use the `phone:`
 * variant. Follows the window, so rotating or resizing updates it.
 */

import { useSyncExternalStore } from "react";

import { PHONE_QUERY } from "@/lib/phone";

function subscribe(listener: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
