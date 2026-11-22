/**
 * The visual viewport, for a sheet that must stay above the on-screen keyboard
 * (`lib/viewport.ts` has the why). Null where there is none; updates on the
 * keyboard opening and closing, on the browser's toolbar and on iOS scrolling
 * the layout behind the keyboard.
 */

import { useSyncExternalStore } from "react";

import type { ViewportBox } from "@/lib/viewport";

let cached: ViewportBox | null = null;

function read(): ViewportBox | null {
  const vv = window.visualViewport;
  if (!vv) return null;
  if (
    cached &&
    cached.height === vv.height &&
    cached.offsetTop === vv.offsetTop &&
    cached.scale === vv.scale
  )
    return cached;
  cached = { height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale };
  return cached;
}

function subscribe(listener: () => void): () => void {
  const vv = window.visualViewport;
  vv?.addEventListener("resize", listener);
  vv?.addEventListener("scroll", listener);
  return () => {
    vv?.removeEventListener("resize", listener);
    vv?.removeEventListener("scroll", listener);
  };
}

export function useVisualViewport(): ViewportBox | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
