/**
 * One shared ticking clock for every relative time on screen. Components read
 * it at the resolution they need, so the list re-renders once a minute and
 * the lock chip once a second:
 *
 *   const now = useNow(MINUTE);
 *
 * `<ClockProvider now={…}>` pins it (tests, screenshots); without a provider
 * it is the real time. The viewer's UTC offset comes along for clock times.
 */

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { localOffset } from "@/lib/time";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

interface ClockSource {
  now(): number;
  subscribe(listener: () => void): () => void;
}

/** Ticks every second while someone listens. */
function ticking(): ClockSource {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    now: () => Date.now(),
    subscribe(listener) {
      listeners.add(listener);
      timer ??= setInterval(() => listeners.forEach((l) => l()), SECOND);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

function fixed(at: number): ClockSource {
  return { now: () => at, subscribe: () => () => {} };
}

const realClock = ticking();
const ClockContext = createContext<ClockSource>(realClock);

export function ClockProvider({ now, children }: { now?: number; children: ReactNode }) {
  const source = useMemo(() => (now === undefined ? realClock : fixed(now)), [now]);
  return createElement(ClockContext.Provider, { value: source }, children);
}

/** The time, floored to `resolution` ms: re-renders only when that changes. */
export function useNow(resolution = MINUTE): number {
  const source = useContext(ClockContext);
  const read = () => Math.floor(source.now() / resolution) * resolution;
  return useSyncExternalStore(source.subscribe, read, read);
}

/** The viewer's offset from UTC in minutes, for clock times and day buckets. */
export function useUtcOffset(): number {
  const now = useNow(60 * MINUTE);
  return localOffset(now);
}
