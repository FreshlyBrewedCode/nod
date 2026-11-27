/**
 * The page's side of the service worker (ADR 0008 §7): register it on the
 * pages `nod serve` serves, and reload once when a worker of another build
 * takes over, so the shell is always the server's (a downgrade included).
 *
 * - **Where.** A production build on a page that is not the hosted UI's
 *   origin (`registersWorker`): the app on loopback and the named host's
 *   page. Not the hosted UI (it follows its channel, not a server; it keeps
 *   forwarding deep links), not the Vite dev server (`import.meta.env.DEV`).
 * - **Which build.** The build writes its id into `index.html` as
 *   `<meta name="nod-build">` and into `sw.js`; a newly active worker posts
 *   its id to the pages (`activatedMessage`), and a page of another build
 *   reloads (`shouldReload`). The page that registers the first worker is
 *   of that worker's build and does not.
 * - **When.** The browser checks `sw.js` on every load; after the socket
 *   comes back (a restarted, maybe updated `nod serve`) the page asks it to
 *   check at once (`checkForUpdate`).
 */

import { STABLE_WEB_URL } from "../../server/web-url";
import type { PageOrigin } from "./connection";
import type { ActivatedMessage } from "./sw-rules";

/** Whether this page registers the worker: a production build, not on the hosted UI. */
export function registersWorker(input: {
  readonly prod: boolean;
  readonly page: PageOrigin;
  readonly hasWorkers: boolean;
}): boolean {
  if (!input.prod || !input.hasWorkers) return false;
  const origin = URL.parse(`${input.page.protocol}//${input.page.host}`)?.origin;
  if (!origin || origin === new URL(STABLE_WEB_URL).origin) return false;
  return input.page.protocol === "http:" || input.page.protocol === "https:";
}

/** The build this page is, from `<meta name="nod-build">`; null in dev or an old build. */
export function pageBuild(doc: Pick<Document, "querySelector">): string | null {
  const content = doc.querySelector('meta[name="nod-build"]')?.getAttribute("content") ?? "";
  return /^[0-9a-f]{8,64}$/.test(content) ? content : null;
}

/** Whether a worker's message means this page is another build's and reloads. */
export function shouldReload(page: string | null, message: unknown): boolean {
  const m = message as Partial<ActivatedMessage> | null;
  if (!m || typeof m !== "object" || m.t !== "nod-sw-activated" || typeof m.build !== "string")
    return false;
  return page !== null && m.build !== page;
}

let registration: ServiceWorkerRegistration | null = null;

/** Register the worker where it belongs (`registersWorker`); call once, at start. */
export function registerServiceWorker(win: Window = window): void {
  const container = win.navigator.serviceWorker as ServiceWorkerContainer | undefined;
  if (
    !registersWorker({
      prod: import.meta.env.PROD,
      page: win.location,
      hasWorkers: !!container,
    })
  )
    return;
  const build = pageBuild(win.document);
  let reloaded = false;
  container!.addEventListener("message", (event) => {
    if (reloaded || !shouldReload(build, event.data)) return;
    reloaded = true;
    win.location.reload();
  });
  container!
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .then((r) => (registration = r))
    .catch(() => {
      // No worker (a private window, blocked storage): the app works without one.
    });
}

/** Ask the browser to look for a new worker now (after a reconnect). */
export function checkForUpdate(): void {
  registration?.update().catch(() => {});
}
