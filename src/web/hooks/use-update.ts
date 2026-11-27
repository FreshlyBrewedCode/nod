/**
 * The update as the page shows it: the indicator (`lib/update.ts`) from the
 * pushed app state, and "updated to x" remembered in this tab's
 * sessionStorage across the restart and the service worker's one reload.
 */

import { useCallback, useEffect, useState } from "react";

import type { AppState } from "../../shared/protocol";
import {
  forgetUpdated,
  indicatorOf,
  noteUpdating,
  updatedOf,
  type Indicator,
  type KeyValue,
  type Updated,
} from "@/lib/update";
import { MINUTE, useNow } from "./use-clock";

/** This tab's sessionStorage, or nothing where it is not allowed. */
function tabStorage(): KeyValue | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export interface UpdateView {
  readonly indicator: Indicator | null;
  /** The update that finished, while it is news. */
  readonly updated: Updated | null;
  /** Puts "updated to x" away (Settings → Server has shown it). */
  readonly forget: () => void;
}

export function useUpdate(app: AppState | null): UpdateView {
  const now = useNow(MINUTE);
  const [, setTick] = useState(0);
  const storage = tabStorage();
  useEffect(() => {
    if (storage) noteUpdating(storage, app, Date.now());
  }, [app, storage]);
  const updated = storage ? updatedOf(storage, app, now) : null;
  const forget = useCallback(() => {
    const s = tabStorage();
    if (s) forgetUpdated(s);
    setTick((n) => n + 1);
  }, []);
  return { indicator: indicatorOf(app, updated), updated, forget };
}
