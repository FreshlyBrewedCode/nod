/**
 * The host this browser forwards deep links to (`lib/forward.ts`), on the
 * pages that forward (the hosted UI, loopback pages); always null elsewhere.
 * Another tab remembering or forgetting it is heard through `storage`.
 */

import { useCallback, useEffect, useState } from "react";

import {
  FORWARD_KEY,
  forgetForward,
  forwardsHere,
  loadForward,
  saveForward,
  type Forward,
} from "@/lib/forward";
import { browserStorage } from "@/lib/storage";

export interface ForwardState {
  /** Whether this page forwards at all. */
  readonly here: boolean;
  readonly forward: Forward | null;
  /** Remember `to` (checked again); false when the storage refuses. */
  remember(to: string): boolean;
  forget(): void;
}

const read = () => (forwardsHere(window.location) ? loadForward(browserStorage()) : null);

export function useForward(): ForwardState {
  const here = forwardsHere(window.location);
  const [forward, setForward] = useState<Forward | null>(read);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === FORWARD_KEY || event.key === null) setForward(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const remember = useCallback((to: string) => {
    if (!forwardsHere(window.location) || !saveForward(browserStorage(), to, Date.now()))
      return false;
    setForward(read());
    return true;
  }, []);
  const forget = useCallback(() => {
    forgetForward(browserStorage());
    setForward(null);
  }, []);

  return { here, forward, remember, forget };
}
