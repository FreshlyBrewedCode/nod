/** The current route, from the URL fragment (`lib/route.ts`), and a way to change it. */

import { useCallback, useEffect, useState } from "react";

import { formatRoute, parseRoute, type Route } from "@/lib/route";

export function useRoute(): [Route, (next: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = formatRoute(next);
    if (options.replace) {
      window.history.replaceState(null, "", hash);
      setRoute(parseRoute(hash));
    } else if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  return [route, go];
}
