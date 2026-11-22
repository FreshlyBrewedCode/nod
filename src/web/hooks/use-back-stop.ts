/**
 * Makes the browser's back gesture close a full-screen page or sheet on a
 * phone. While `active`, one history entry is on the stack for it
 * (`lib/back-stack.ts` has the why and the pure rules); back pops it and
 * `onDismiss` is called, the owner then sets `active` false. When the owner
 * closes it itself (a button), the entry is popped with `history.back()`, so
 * the stack is what it was before. `blocked` keeps it open through a back
 * (a sign request is in flight): the entry is pushed again.
 *
 * Opening one overlay right after closing another waits for the pop to
 * settle (`afterBack`), as a `history.back()` is asynchronous.
 */

import { useEffect, useRef } from "react";

import { isDeadForward, layerOf, layerState, onPop } from "@/lib/back-stack";

/** Overlays that hold an entry now, and pops we asked for that have not arrived. */
let open = 0;
let popping = 0;
let waiting: Array<() => void> = [];

function settled() {
  if (popping > 0) return;
  const run = waiting;
  waiting = [];
  for (const fn of run) fn();
}

/** Runs `fn` now, or once the `history.back()` in flight has landed. */
export function afterBack(fn: () => void) {
  if (popping === 0) fn();
  else waiting.push(fn);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (popping > 0) popping--;
    // A forward into an overlay that is gone: its state cannot come back, so go back again.
    if (popping === 0 && isDeadForward(open, layerOf(window.history.state))) {
      popping++;
      window.history.back();
      return;
    }
    settled();
  });
}

export function useBackStop(active: boolean, onDismiss: () => void, blocked = false) {
  const latest = useRef({ onDismiss, blocked });
  useEffect(() => {
    latest.current = { onDismiss, blocked };
  });

  useEffect(() => {
    if (!active) return;
    let mine = 0;
    let cancelled = false;
    const push = () => {
      if (cancelled) return;
      mine = layerOf(window.history.state) + 1;
      window.history.pushState(layerState(mine), "");
      open++;
    };
    afterBack(push);
    const onPopState = () => {
      if (!mine) return;
      const now = layerOf(window.history.state);
      const action = onPop(mine, now, latest.current.blocked);
      if (action === "restore") window.history.pushState(layerState(mine), "");
      else if (action === "close") {
        // The entry went with the back: nothing left to pop on cleanup.
        mine = 0;
        open--;
        latest.current.onDismiss();
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
      if (!mine) return;
      open--;
      // Closed by the owner: take our entry off the stack if it is still the top.
      if (layerOf(window.history.state) === mine) {
        popping++;
        window.history.back();
      }
    };
  }, [active]);
}
