/**
 * Routing by the URL fragment, hand-rolled and small:
 *
 *   #/                                 the list, by attention (also the empty fragment)
 *   #/chrono                           the list, chronological
 *   #/board                            the board
 *   #/setup                            onboarding's checks, reopened from the avatar menu
 *   #/pr/<owner>/<repo>/<n>            a deep link to one PR: its landing
 *   #/batch/<owner>/<repo>/<n>,<n>,…   a deep link to a batch: the landing and the
 *                                      batch dialog's review step
 *   #/pr/<host>/<owner>/<repo>/<n>     the same for a repo on another host than
 *   #/batch/<host>/<owner>/<repo>/…    github.com (`acme.ghe.com`, a GHES host)
 *
 * A deep link without a host is a github.com link (all links before hosts
 * existed were), and the kit's `prDeepLink`/`batchDeepLink` name every other
 * host. So a link for one host never lands on a repo of the same name on
 * another: the landing compares host and repo with the server's.
 *
 * Deep links are stable URLs that do nothing by themselves: a link never
 * approves, it only opens a view (concept decision 7).
 *
 * The pairing fragment. `nod serve` prints `#host=…&token=…`; it may also be
 * combined with a route, `#/pr/<owner>/<repo>/<n>?host=…&token=…` (`&` works
 * as the separator too). `fragmentOf` splits the two; the connection code
 * takes the pairing out of the address bar before anything routes, and
 * `parseRoute` ignores whatever follows the route's path. Anything unknown
 * is the list.
 */

import { GITHUB_COM, hostName } from "../../kit/host.ts";

export type Route =
  | { readonly view: "list" }
  | { readonly view: "chrono" }
  | { readonly view: "board" }
  | { readonly view: "setup" }
  | {
      readonly view: "pr";
      /** The GitHub host, lowercase: `github.com` for a link without one. */
      readonly host: string;
      readonly repo: string;
      readonly number: number;
    }
  | {
      readonly view: "batch";
      readonly host: string;
      readonly repo: string;
      readonly numbers: ReadonlyArray<number>;
    };

export type View = "list" | "chrono" | "board";

/** A deep link: what a link from a PR comment opens. */
export type LinkRoute = Extract<Route, { view: "pr" | "batch" }>;

/** The most PRs a batch link lists (the server's limit for one nod). */
export const MAX_LINK_PRS = 100;

const LIST: Route = { view: "list" };
const NUMBER = /^[1-9]\d{0,8}$/;
const NAME = /^[\w.-]+$/;

/**
 * A fragment's two parts: the route's path (`/pr/a/b/1`, or "" when the
 * fragment is only parameters) and the parameters after it.
 */
export function fragmentOf(hash: string): { path: string; params: string } {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith("/")) return { path: "", params: raw };
  const cut = raw.search(/[?&]/);
  return cut < 0
    ? { path: raw, params: "" }
    : { path: raw.slice(0, cut), params: raw.slice(cut + 1) };
}

export function parseRoute(hash: string): Route {
  const { path } = fragmentOf(hash);
  if (!path) return LIST;
  let parts: string[];
  try {
    parts = path.slice(1).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return LIST;
  }
  if (parts.length === 0) return LIST;
  if (parts.length === 1 && parts[0] === "chrono") return { view: "chrono" };
  if (parts.length === 1 && parts[0] === "board") return { view: "board" };
  if (parts.length === 1 && parts[0] === "setup") return { view: "setup" };
  const [kind, ...rest] = parts;
  let host: string | null = GITHUB_COM;
  if (rest.length === 4) host = hostName(rest.shift()!);
  if (!host || rest.length !== 3 || !NAME.test(rest[0]!) || !NAME.test(rest[1]!)) return LIST;
  const repo = `${rest[0]}/${rest[1]}`;
  if (kind === "pr" && NUMBER.test(rest[2]!))
    return { view: "pr", host, repo, number: Number(rest[2]) };
  if (kind === "batch") {
    const items = rest[2]!.split(",").filter(Boolean);
    if (!items.length || items.length > MAX_LINK_PRS || !items.every((n) => NUMBER.test(n)))
      return LIST;
    return { view: "batch", host, repo, numbers: [...new Set(items.map(Number))] };
  }
  return LIST;
}

const repoPath = (host: string, repo: string) => {
  const [owner = "", name = ""] = repo.split("/");
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return host === GITHUB_COM ? path : `${encodeURIComponent(host)}/${path}`;
};

export function formatRoute(route: Route): string {
  switch (route.view) {
    case "list":
      return "#/";
    case "chrono":
      return "#/chrono";
    case "board":
      return "#/board";
    case "setup":
      return "#/setup";
    case "pr":
      return `#/pr/${repoPath(route.host, route.repo)}/${route.number}`;
    case "batch":
      return `#/batch/${repoPath(route.host, route.repo)}/${route.numbers.join(",")}`;
  }
}

export function isLinkRoute(route: Route): route is LinkRoute {
  return route.view === "pr" || route.view === "batch";
}

/** The PRs a deep link names. */
export function linkNumbers(route: LinkRoute): ReadonlyArray<number> {
  return route.view === "pr" ? [route.number] : route.numbers;
}

/** The list view behind a route: a deep link and the setup sit over the list. */
export function viewOf(route: Route): View {
  return route.view === "chrono" || route.view === "board" ? route.view : "list";
}
