/**
 * Deep links on another device (ADR 0005 §7), and to this machine's app
 * (ADR 0008 §6). A link in a PR comment or a
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
 * - **This machine's app** (ADR 0008): the record may also hold the app
 *   `nod serve` serves on loopback, exactly `http://127.0.0.1:<port>`
 *   (`localAppOriginOf`), learned the same way from the app's "Open links
 *   from GitHub here" (shown when it runs on another port than the
 *   default). With nothing remembered, the hosted UI (its origin only)
 *   offers the app on the default port: a fixed loopback address the page
 *   chose, never one a link names. A page never forwards to itself.
 */

import { parseNamedHost } from "../../shared/named-host";
import { DEFAULT_SERVE_PORT } from "../../shared/protocol";
import { NEXT_WEB_URL, STABLE_WEB_URL, appUrl, isRelease } from "../../server/web-url";
import { pairsWithLoopback, type KeyValue, type PageOrigin } from "./connection";
import { formatRoute, type LinkRoute } from "./route";

/** The remembered host, in the hosted origin's localStorage. */
export const FORWARD_KEY = "nod.forward";

export interface Forward {
  /**
   * `https://<machine>.<tailnet>.ts.net:8445` (`namedOriginOf`), or this
   * machine's app, `http://127.0.0.1:<port>` (`localAppOriginOf`).
   */
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

/** `http://127.0.0.1:<port>`, a port from 1 to 65535 written plainly, and maybe a `/`. */
const LOCAL_APP_FORM = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/;

/**
 * This machine's app as a forward's target (ADR 0008 §6), or null: exactly
 * `http://127.0.0.1:<port>`. No other loopback name (`localhost` is another
 * origin, with another pairing), no `https` (the app is plain http on
 * loopback), no path.
 */
export function localAppOriginOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_APP_FORM.exec(value);
  const port = match ? Number(match[1]) : 0;
  return port >= 1 && port <= 65535 ? appUrl(port) : null;
}

/** Where a forward may go: a named host, or this machine's app. */
export function forwardOriginOf(value: string | null | undefined): string | null {
  return namedOriginOf(value) ?? localAppOriginOf(value);
}

/** Whether `origin` is this machine's app rather than a named host. */
export function isLocalApp(origin: string): boolean {
  return localAppOriginOf(origin) === origin;
}

/** How the host is shown: `<name>[:port]`, the origin without its scheme. */
export function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
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
      forwardOriginOf(value.to) === value.to &&
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

/** Remember `to` (already checked by `forwardOriginOf`); false when storage refuses. */
export function saveForward(storage: KeyValue | null, to: string, now: number): boolean {
  if (!storage || forwardOriginOf(to) !== to) return false;
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
  if (forwardOriginOf(to) !== to) return null;
  return `${to}/${route ? formatRoute(route) : ""}`;
}

/**
 * What a page shows for a deep link (or the plain unpaired page): the
 * landing of a paired page (`paired`, whatever its socket does: what is
 * paired wins), the offer to open it on the remembered host (`forward`), or
 * how to pair (`pair`). A forward to this machine's app is `local`; with
 * nothing remembered, the hosted UI offers the app on the default port,
 * `assumed` (ADR 0008 §6).
 */
export type Offer =
  | { readonly kind: "paired" }
  | { readonly kind: "pair" }
  | {
      readonly kind: "forward";
      readonly to: string;
      readonly url: string;
      readonly local?: true;
      readonly assumed?: true;
    };

/** This machine's app on the default port: what the hosted UI offers with nothing remembered. */
export const DEFAULT_LOCAL_APP = appUrl(DEFAULT_SERVE_PORT);

/** Whether `page` is the hosted UI (either channel: they share the origin). */
export function isHostedUi(page: PageOrigin | null): boolean {
  return !!page && `${page.protocol}//${page.host}` === new URL(STABLE_WEB_URL).origin;
}

export function offerFor(input: {
  readonly paired: boolean;
  readonly page: PageOrigin | null;
  readonly forward: Forward | null;
  readonly route: LinkRoute | null;
}): Offer {
  if (input.paired) return { kind: "paired" };
  if (!forwardsHere(input.page)) return { kind: "pair" };
  const here = input.page ? `${input.page.protocol}//${input.page.host}` : null;
  const to = input.forward?.to ?? (isHostedUi(input.page) ? DEFAULT_LOCAL_APP : null);
  if (!to || to === here) return { kind: "pair" };
  const url = forwardUrl(to, input.route);
  if (!url) return { kind: "pair" };
  if (!isLocalApp(to)) return { kind: "forward", to, url };
  return input.forward
    ? { kind: "forward", to, url, local: true }
    : { kind: "forward", to, url, local: true, assumed: true };
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
  const to = forwardOriginOf(given);
  if (!to) return { kind: "invalid", given };
  if (!remembered) return { kind: "new", to };
  if (remembered.to === to) return { kind: "same", to, since: remembered.since };
  return { kind: "replace", to, was: remembered.to };
}

/**
 * "Open links from GitHub here", on the named host's page: the hosted UI's
 * `#/forward?to=<this origin>`, on the channel of the `nod serve` that served
 * the page (a release: the stable root; a pre-release or a checkout: `/next`;
 * both share one origin, so one record serves both). Also on this machine's
 * app (`servedApp`: the page is the app `nod serve` serves, ADR 0008) when it
 * runs on another port than the default, which the hosted UI assumes. null on
 * every other page (the hosted UI, the dev server, plain http elsewhere).
 */
export function forwardSetupUrl(
  page: PageOrigin | null,
  version: string | null,
  servedApp = false,
): string | null {
  if (!page) return null;
  const local =
    servedApp && page.protocol === "http:" ? localAppOriginOf(`http://${page.host}`) : null;
  if (local === DEFAULT_LOCAL_APP) return null;
  if (!local && (page.protocol !== "https:" || forwardsHere(page))) return null;
  const to = local ?? namedOriginOf(`https://${page.host}`);
  if (!to) return null;
  const base = isRelease(version) && !version.includes("-") ? STABLE_WEB_URL : NEXT_WEB_URL;
  return `${base}/${formatRoute({ view: "forward", to })}`;
}
