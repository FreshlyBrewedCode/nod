/**
 * An element's content width in px, kept up to date (`ResizeObserver`): for
 * the insight charts, which are drawn in real pixels so their text never
 * stretches. 0 until the element is laid out.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
