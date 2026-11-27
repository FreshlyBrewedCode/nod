/**
 * The web apps a host link may open. A release prints the app `nod serve`
 * serves itself (`appUrl`, ADR 0008); the hosted UI below stays for deep
 * links and for pairings made before, and `defaultWebUrl` is still the one
 * whose origin is let in when neither `--web-url` nor `NOD_WEB_URL` says
 * otherwise. The hosted UI speaks the same `protocol.ts` as the CLI of
 * its release channel, so the default follows the version `nod serve` runs
 * as: a release is stamped with its version; a checkout runs as
 * `0.0.0-development` (or none) and opens the Vite dev server.
 */

import { DEFAULT_SERVE_PORT, DEV_WEB_PORT } from "../shared/protocol";

export const STABLE_WEB_URL = "https://ui.nod.frebreco.de";
export const NEXT_WEB_URL = `${STABLE_WEB_URL}/next`;
export const DEV_WEB_URL = `http://localhost:${DEV_WEB_PORT}`;

/** The version of a checkout, before the release stamps a real one. */
export const DEV_VERSION = "0.0.0-development";

export function isRelease(version: string | null | undefined): version is string {
  return !!version && version !== DEV_VERSION && !version.startsWith("0.0.0-");
}

export function defaultWebUrl(version: string | null | undefined): string {
  if (!isRelease(version)) return DEV_WEB_URL;
  // semver: a pre-release is anything with a `-` suffix, here `X.Y.Z-next.N`.
  return version.includes("-") ? NEXT_WEB_URL : STABLE_WEB_URL;
}

/**
 * The origins allowed to open the socket: the web app's own, and the local
 * dev server under both its names (a hosted UI and a checkout can share one
 * `nod serve`).
 */
export function allowedOrigins(webUrl: string): string[] {
  const dev = [`http://localhost:${DEV_WEB_PORT}`, `http://127.0.0.1:${DEV_WEB_PORT}`];
  return [...new Set([new URL(webUrl).origin, ...dev])];
}

/**
 * The app `nod serve` serves on loopback (ADR 0008): its one origin,
 * `127.0.0.1`, never `localhost` (another origin, another storage).
 */
export function appUrl(port: number = DEFAULT_SERVE_PORT): string {
  return `http://127.0.0.1:${port}`;
}

export function serverUrl(port: number = DEFAULT_SERVE_PORT): string {
  return `ws://127.0.0.1:${port}`;
}

/**
 * The link that pairs a browser with this server:
 * `<web url>/#host=<ws url>&token=<token>`. Both ride in the fragment,
 * which browsers never send to the web host. The page keeps them in its
 * origin's storage and drops them from the address bar.
 */
export function hostLink(webUrl: string, wsUrl: string, token: string): string {
  const fragment = new URLSearchParams({ host: wsUrl, token });
  return `${webUrl.replace(/\/+$/, "")}/#${fragment}`;
}
