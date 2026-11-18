/**
 * Routing by the URL fragment, hand-rolled and small:
 *
 *   #/                         the list, by attention (also the empty fragment)
 *   #/chrono                   the list, chronological
 *   #/board                    the board
 *   #/pr/<owner>/<repo>/<n>    a deep link to one PR (opens the list with it focused)
 *
 * The pairing fragment (`#host=…&token=…`) is no route: the connection code
 * takes it out of the address bar before anything routes, so meanwhile it
 * reads as the list. Anything unknown is the list too.
 */

export type Route =
  | { readonly view: "list" }
  | { readonly view: "chrono" }
  | { readonly view: "board" }
  | { readonly view: "pr"; readonly repo: string; readonly number: number };

export type View = "list" | "chrono" | "board";

const LIST: Route = { view: "list" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (!path.startsWith("/")) return LIST;
  const parts = path.slice(1).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return LIST;
  if (parts.length === 1 && parts[0] === "chrono") return { view: "chrono" };
  if (parts.length === 1 && parts[0] === "board") return { view: "board" };
  if (parts.length === 4 && parts[0] === "pr" && /^[1-9]\d*$/.test(parts[3]!))
    return { view: "pr", repo: `${parts[1]}/${parts[2]}`, number: Number(parts[3]) };
  return LIST;
}

export function formatRoute(route: Route): string {
  switch (route.view) {
    case "list":
      return "#/";
    case "chrono":
      return "#/chrono";
    case "board":
      return "#/board";
    case "pr": {
      const [owner = "", repo = ""] = route.repo.split("/");
      return `#/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${route.number}`;
    }
  }
}

/** The view a route shows: a deep link opens the list. */
export function viewOf(route: Route): View {
  return route.view === "pr" ? "list" : route.view;
}
