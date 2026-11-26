/**
 * Deep links on another device (ADR 0005 §7). A link in a PR comment or a
 * GitHub notification opens the hosted UI, which a phone cannot pair: the
 * phone's nod is the page `nod serve --allow-host` serves on its named host,
 * an origin the hosted page can neither read nor open a socket to. So the
 * hosted page remembers where this browser's nod is, and hands a link over
 * by a top-level navigation, one tap per link.
 *
 * - **Learning the host.** Only from `#/forward?to=https://<name[:port]>`,
 *   which the named host's page opens from "Open links from GitHub here"
 *   (`forwardSetupUrl`), and only after the user confirms a full page that
 *   names the host (`confirmOf`). Anyone can craft that link, so the page
 *   cannot tell a real request from a planted one: the confirmation is the
 *   guard, and its default is not to remember. The host passes the rule
 *   `--allow-host` passes (`src/shared/named-host.ts`), written exactly as
 *   an origin: https, a DNS name with a domain, an optional port, nothing
 *   else.
 * - **Forwarding.** A deep link on a page that is not paired and remembers a
 *   host offers "Open on <host>" (`offerFor`); the address is rebuilt from
 *   the parsed route (`forwardUrl`), never from the raw fragment, so it
 *   carries no token and cannot leave the host. A paired page never
 *   forwards.
 * - **Where.** Only the pages that pair with loopback forward: the hosted UI
 *   and pages on this machine (`pairsWithLoopback`). The named host's own
 *   page ignores `#/forward`.
 */

import { parseNamedHost } from "../../shared/named-host";
import { NEXT_WEB_URL, STABLE_WEB_URL, isRelease } from "../../server/web-url";
import { pairsWithLoopback, type KeyValue, type PageOrigin } from "./connection";
import { formatRoute, type LinkRoute } from "./route";

/** The remembered host, in the hosted origin's localStorage. */
export const FORWARD_KEY = "nod.forward";

export interface Forward {
  /** `https://<machine>.<tailnet>.ts.net:8445`, as `namedOriginOf` returns it. */
  readonly to: string;
  /** When the user confirmed it. */
  readonly since: number;
}

/** `https://`, an authority without userinfo, path, query or fragment, and maybe a `/`. */
const ORIGIN_FORM = /^https:\/\/([^/?#@\\\s%]+)\/?$/i;

/**
 * The origin a forward may go to, or null. `value` must be written as an
 * origin, `https://<name[:port]>` (a trailing `/` is fine), and the name
 * must pass `--allow-host`'s rule: a DNS name with a domain, never an IP
 * literal (nor a name a browser reads as one), never loopback, a port from
 * 1 to 65535. Also refused: internationalized labels (`xn--`), since the
 * confirmation shows the name as it is written and a tailnet name is
 * ASCII. Case and a port 443 are normalized away.
 */
export function namedOriginOf(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const match = ORIGIN_FORM.exec(value);
  if (!match) return null;
  let origin: string;
  let hostname: string;
  try {
    ({ origin, hostname } = parseNamedHost(match[1]!));
  } catch {
    return null;
  }
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) return null;
  // The browser must read it as the same origin, or the page would show one
  // host and forward to another.
  return URL.parse(origin)?.origin === origin ? origin : null;
}

/** How the host is shown: `<name>[:port]`, the origin without `https://`. */
export function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

/**
 * How the host is laid out: one entry per place a line may break (after a
 * dot, before the port), each a list of pieces; a `glued` piece is a run of
 * hyphens with the character after it, which must not break (a browser
 * would break after a hyphen, inside a label). Joined, it is `host`.
 */
export function hostParts(host: string): { text: string; glued: boolean }[][] {
  return host.split(/(?<=\.)|(?=:)/).map((label) =>
    label
      .split(/(-+.)/)
      .filter((text) => text !== "")
      .map((text) => ({ text, glued: text.startsWith("-") })),
  );
}

/** Whether this page forwards deep links: the hosted UI, and pages on this machine. */
export function forwardsHere(page: PageOrigin | null): boolean {
  return pairsWithLoopback(page);
}

/** The remembered host; one that no longer passes the rule is dropped. */
export function loadForward(storage: KeyValue | null): Forward | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(FORWARD_KEY) ?? "null") as Partial<Forward> | null;
    if (!value) return null;
    if (
      typeof value.to === "string" &&
      namedOriginOf(value.to) === value.to &&
      typeof value.since === "number" &&
      Number.isFinite(value.since)
    )
      return { to: value.to, since: value.since };
    storage.removeItem(FORWARD_KEY);
  } catch {
    // a broken or blocked entry is no host
  }
  return null;
}

/** Remember `to` (already checked by `namedOriginOf`); false when storage refuses. */
export function saveForward(storage: KeyValue | null, to: string, now: number): boolean {
  if (!storage || namedOriginOf(to) !== to) return false;
  try {
    storage.setItem(FORWARD_KEY, JSON.stringify({ to, since: now } satisfies Forward));
    return true;
  } catch {
    return false;
  }
}

export function forgetForward(storage: KeyValue | null): void {
  try {
    storage?.removeItem(FORWARD_KEY);
  } catch {
    // blocked storage remembers nothing anyway
  }
}

/**
 * Where a forward goes: the named host's page, on the route rebuilt from the
 * parsed link (`formatRoute`), or its list for no route. Never a token, never
 * the raw fragment. null when `to` is not a host a forward may go to.
 */
export function forwardUrl(to: string, route: LinkRoute | null): string | null {
  if (namedOriginOf(to) !== to) return null;
  return `${to}/${route ? formatRoute(route) : ""}`;
}

/**
 * What a page shows for a deep link (or the plain unpaired page): the
 * landing of a paired page (`paired`, whatever its socket does: what is
 * paired wins), the offer to open it on the remembered host (`forward`), or
 * how to pair (`pair`).
 */
export type Offer =
  | { readonly kind: "paired" }
  | { readonly kind: "pair" }
  | {
      readonly kind: "forward";
      readonly to: string;
      readonly url: string;
    };

export function offerFor(input: {
  readonly paired: boolean;
  readonly page: PageOrigin | null;
  readonly forward: Forward | null;
  readonly route: LinkRoute | null;
}): Offer {
  if (input.paired) return { kind: "paired" };
  if (!input.forward || !forwardsHere(input.page)) return { kind: "pair" };
  const url = forwardUrl(input.forward.to, input.route);
  return url ? { kind: "forward", to: input.forward.to, url } : { kind: "pair" };
}

/**
 * The confirmation `#/forward?to=…` shows: a host that cannot be forwarded
 * to (`invalid`, nothing to remember), one to remember (`new`), one that
 * replaces another (`replace`), or the one remembered already (`same`).
 * `not-here`: this page does not forward (the named host's own page).
 */
export type Confirm =
  | { readonly kind: "not-here" }
  | { readonly kind: "invalid"; readonly given: string | null }
  | { readonly kind: "new"; readonly to: string }
  | { readonly kind: "replace"; readonly to: string; readonly was: string }
  | { readonly kind: "same"; readonly to: string; readonly since: number };

export function confirmOf(
  given: string | null,
  remembered: Forward | null,
  page: PageOrigin | null,
): Confirm {
  if (!forwardsHere(page)) return { kind: "not-here" };
  const to = namedOriginOf(given);
  if (!to) return { kind: "invalid", given };
  if (!remembered) return { kind: "new", to };
  if (remembered.to === to) return { kind: "same", to, since: remembered.since };
  return { kind: "replace", to, was: remembered.to };
}

/**
 * "Open links from GitHub here", on the named host's page: the hosted UI's
 * `#/forward?to=<this origin>`, on the channel of the `nod serve` that served
 * the page (a release: the stable root; a pre-release or a checkout: `/next`;
 * both share one origin, so one record serves both). null on every page that
 * is not a named host's (the hosted UI, loopback, plain http).
 */
export function forwardSetupUrl(page: PageOrigin | null, version: string | null): string | null {
  if (!page || page.protocol !== "https:" || forwardsHere(page)) return null;
  const to = namedOriginOf(`https://${page.host}`);
  if (!to) return null;
  const base = isRelease(version) && !version.includes("-") ? STABLE_WEB_URL : NEXT_WEB_URL;
  return `${base}/${formatRoute({ view: "forward", to })}`;
}
