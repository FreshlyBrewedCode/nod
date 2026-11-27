/**
 * The service worker's decisions, pure (ADR 0008 §7): which cache is this
 * build's, which caches are stale, and how a request is answered. The
 * worker itself (`src/web/sw.ts`) only applies them. Imported by the worker
 * alone, so its bundle shares no chunk with the page's.
 *
 * - The cache is keyed by the build: `nod-shell-<build id>`, the id a hash of
 *   the build's files (the Vite plugin in `vite.config.ts`). Another
 *   `nod serve`, newer or older, serves another `sw.js`; once it activates,
 *   every other `nod-shell-*` cache goes.
 * - Only same-origin GETs are answered; never `/ws`, `/health`, or a request
 *   with `token` in its query (the token rides in the fragment, which no
 *   request carries; this is the second guard).
 * - Navigations: the network first, the cached shell when the network fails
 *   or a proxy answers 5xx (the named host's proxy with nothing behind it).
 *   `/assets/` (hashed, immutable): the cache first. The rest: the network
 *   first, the cache second.
 */

/** Every cache this worker owns starts with this. */
export const CACHE_PREFIX = "nod-shell-";

/** The cache of one build. */
export function cacheName(build: string): string {
  return `${CACHE_PREFIX}${build}`;
}

/** The caches to delete once `current` is active: every other one of ours, never anyone else's. */
export function staleCaches(names: ReadonlyArray<string>, current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}

/**
 * How a request is answered: `pass` (the worker stays out: the browser
 * fetches as if there were none), `shell` (a navigation: network, else the
 * cached shell), `cache-first`, `network-first`.
 */
export type Strategy = "pass" | "shell" | "cache-first" | "network-first";

export interface RequestFacts {
  readonly method: string;
  readonly url: string;
  /** `Request.mode`: "navigate" for a page load. */
  readonly mode: string;
}

/** Paths that are the server's, never the app's files. */
const SERVER_PATHS = new Set(["/ws", "/health"]);

export function strategyFor(request: RequestFacts, scopeOrigin: string): Strategy {
  if (request.method !== "GET") return "pass";
  const url = URL.parse(request.url);
  if (!url || url.origin !== scopeOrigin) return "pass";
  if (SERVER_PATHS.has(url.pathname)) return "pass";
  if (url.searchParams.has("token") || /token/i.test(url.search)) return "pass";
  if (request.mode === "navigate") return "shell";
  if (url.pathname.startsWith("/assets/")) return "cache-first";
  return "network-first";
}

/** Whether a navigation's answer is to be replaced by the cached shell: none, or a proxy's 5xx. */
export function shellInstead(response: { readonly status: number } | null): boolean {
  return response === null || response.status >= 500;
}

/** The path the shell is cached under. */
export const SHELL = "index.html";

/**
 * What the worker caches at install, as paths relative to its scope: the
 * shell first, then the build's files (`files`, from the build), without the
 * worker itself, source maps or duplicates.
 */
export function precacheList(files: ReadonlyArray<string>): string[] {
  const out = new Set<string>([SHELL]);
  for (const file of files) {
    const path = file.replace(/^\.?\//, "");
    if (!path || path === "sw.js" || path.endsWith(".map")) continue;
    out.add(path);
  }
  return [...out];
}

/** The message a newly active worker sends to the pages it took over. */
export interface ActivatedMessage {
  readonly t: "nod-sw-activated";
  readonly build: string;
}

export function activatedMessage(build: string): ActivatedMessage {
  return { t: "nod-sw-activated", build };
}
