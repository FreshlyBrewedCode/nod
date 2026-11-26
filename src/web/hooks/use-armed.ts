/**
 * Whether a guarded button takes a tap yet (`lib/guard.ts`): false until the
 * page has been visible for `ARM_MS` in one go since this hook mounted, and
 * again whenever the page is hidden (or comes back from the back-forward
 * cache). The clock is injectable for tests and checks.
 */

import { useEffect, useState } from "react";

import { untilArmed, visibleSince, type VisibleSince } from "@/lib/guard";

export interface ArmClock {
  now(): number;
  visible(): boolean;
}

const PAGE_CLOCK: ArmClock = {
  now: () => performance.now(),
  visible: () => document.visibilityState === "visible",
};

export function useArmed(clock: ArmClock = PAGE_CLOCK): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let since: VisibleSince = visibleSince(null, clock.visible(), clock.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const wait = untilArmed(since, clock.now());
      setArmed(wait === 0);
      if (wait) timer = setTimeout(update, wait);
    };
    const onVisibility = () => {
      since = visibleSince(since, clock.visible(), clock.now());
      update();
    };
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      since = null;
      onVisibility();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onShow);
    update();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShow);
    };
  }, [clock]);
  return armed;
}
