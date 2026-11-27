/**
 * The app (ADR 0008): the web app `nod serve` serves itself, on loopback
 * (`http://127.0.0.1:<port>/`) or on the named host. The pure parts:
 *
 * - whether this page is that app (`isServedApp`): its pairing is the server
 *   that served it, so the page is the server's own build;
 * - how it installs here (`installStateOf`, `installHelp`);
 * - what the page says while the socket is closed (`closedPageOf`): "nod
 *   serve isn't running" once a retry failed, with the command to start it.
 */

import { appUrl } from "../../server/web-url";
import type { PageOrigin, Pairing, Status } from "./connection";

/**
 * Whether the page is the app `nod serve` serves: paired with the very host
 * that served it (`ws://127.0.0.1:<port>` from `http://127.0.0.1:<port>`, or
 * `wss://<name>` from `https://<name>`). The hosted UI and the dev server
 * pair with another origin's server.
 */
export function isServedApp(page: PageOrigin | null, pairing: Pairing | null): boolean {
  if (!page || !pairing) return false;
  const url = URL.parse(pairing.host);
  if (!url) return false;
  const scheme = page.protocol === "https:" ? "wss:" : page.protocol === "http:" ? "ws:" : null;
  return url.protocol === scheme && url.host === page.host;
}

/** The app's address for a pairing with loopback (`ws://127.0.0.1:4519` → `http://127.0.0.1:4519`). */
export function appAddressOf(pairing: Pairing | null): string {
  const url = pairing ? URL.parse(pairing.host) : null;
  const port = url && url.protocol === "ws:" && url.port ? Number(url.port) : undefined;
  return appUrl(port);
}

// ---------------------------------------------------------------------------
// install

/**
 * - `running`: this window is the installed app (standalone);
 * - `installed`: installed from this page just now (`appinstalled`);
 * - `prompt`: the browser offers it (`beforeinstallprompt`): one button;
 * - `manual`: this is the app, the browser offers no button: how it is done here;
 * - `elsewhere`: this page is not the app (the hosted UI, the dev server):
 *   install it from the app's address.
 */
export type InstallState = "running" | "installed" | "prompt" | "manual" | "elsewhere";

export function installStateOf(input: {
  readonly standalone: boolean;
  readonly installed: boolean;
  readonly prompt: boolean;
  readonly servedApp: boolean;
}): InstallState {
  if (input.standalone) return "running";
  if (input.installed) return "installed";
  if (input.prompt) return "prompt";
  return input.servedApp ? "manual" : "elsewhere";
}

/** How this browser installs a site, from its user agent: the browser's name and the steps. */
export function installHelp(userAgent: string): { readonly browser: string; readonly how: string } {
  const ua = userAgent;
  if (/iPhone|iPad|iPod/.test(ua))
    return {
      browser: "Safari on iOS",
      how: "Tap Share, then Add to Home Screen. The home-screen app has its own storage, so it pairs once more.",
    };
  if (/Firefox\//.test(ua))
    return {
      browser: "Firefox",
      how: "Firefox does not install sites as apps. Open this address in Chrome, Edge or Safari to install it, or pin this tab.",
    };
  if (/Edg\//.test(ua))
    return {
      browser: "Edge",
      how: "Use the app icon at the right of the address bar, or the menu: Apps, then Install this site as an app.",
    };
  if (/Android/.test(ua) && /Chrome\//.test(ua))
    return {
      browser: "Chrome on Android",
      how: "Open the menu (⋮) and tap Add to Home screen, then Install.",
    };
  if (/Chrome\/|Chromium\//.test(ua))
    return {
      browser: "Chrome",
      how: "Use the install icon at the right of the address bar, or the menu (⋮): Cast, save and share, then Install page as app.",
    };
  if (/Macintosh/.test(ua) && /Safari\//.test(ua))
    return { browser: "Safari", how: "In the menu bar: File, then Add to Dock." };
  return {
    browser: "this browser",
    how: "Look for Install or Add to Home Screen in its menu. Chrome, Edge and Safari install sites as apps.",
  };
}

// ---------------------------------------------------------------------------
// nod serve isn't running

/**
 * The service hint on the "not running" page: `nod service` keeps `nod
 * serve` running in the background (#52). Not released yet, so said so.
 */
export const SERVICE_HINT = "nod service install";

/**
 * What the page says for a socket that is not open, with no dashboard to
 * keep: `connecting` (the first try), `reconnecting` (it dropped once: a
 * restart is quick), `not-running` (a retry failed too: say so, with the
 * command; the page keeps retrying and recovers by itself). null when the
 * status is not about the server being away.
 */
export type ClosedPage = "connecting" | "reconnecting" | "not-running";

export function closedPageOf(status: Status, reconnects: number): ClosedPage | null {
  if (status === "connecting") return reconnects > 1 ? "not-running" : "connecting";
  if (status === "closed") return reconnects > 1 ? "not-running" : "reconnecting";
  return null;
}

/** The command that starts the server this page talks to: with the named host on its page. */
export function startCommand(namedHost: string | null): string {
  return namedHost ? `nod serve --allow-host ${namedHost}` : "nod serve";
}
