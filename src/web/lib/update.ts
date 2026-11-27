/**
 * The app's update, in the web app's words (ADR 0008 §9): the indicator at
 * the top level, what Settings → Server says, and "updated to x" after a
 * restart. Pure: the state comes from `nod serve` (`AppState`), the time and
 * the storage are arguments.
 *
 * "Updated to x" needs a memory across the restart: the new `nod serve`
 * does not know an install happened, and the service worker reloads the page
 * once for the new shell. So while a restart is under way the page notes
 * `{ from, to }` in this tab's sessionStorage (`noteUpdating`), and the next
 * state that runs `to` reads as updated (`updatedOf`) until it is put away.
 */

import type { AppState, ServiceView, UpdateChannel } from "../../shared/protocol";
import { duration } from "./time";

/** The pill in the top bar: obvious but calm. */
export interface Indicator {
  readonly label: string;
  /** For a phone's top bar. */
  readonly short: string;
  readonly tone: "need" | "ok" | "bad" | "quiet";
  /** A dot before the label: something to do. */
  readonly dot: boolean;
  /** What a hover or a screen reader says. */
  readonly title: string;
}

/** A finished update, remembered across the restart. */
export interface Updated {
  readonly from: string | null;
  readonly to: string;
}

/** The indicator for the state, or null when there is nothing to say. */
export function indicatorOf(app: AppState | null, updated: Updated | null): Indicator | null {
  if (!app) return null;
  const { update } = app;
  const { installation, after, latest, kind } = update;
  if (installation.status === "installing")
    return {
      label: `Updating to ${installation.version}…`,
      short: "Updating…",
      tone: "quiet",
      dot: false,
      title: `nod is installing ${installation.version}`,
    };
  if (after?.state === "restarting")
    return {
      label: "Restarting…",
      short: "Restarting…",
      tone: "quiet",
      dot: false,
      title: `${installation.version ?? "The update"} is installed; the service restarts nod`,
    };
  if (after?.state === "restart-by-hand")
    return {
      label: "Restart to finish",
      short: "Restart",
      tone: "need",
      dot: true,
      title: `${installation.version ?? "The update"} is installed; restart nod serve to run it`,
    };
  if (after?.state === "restart-failed")
    return {
      label: "Restart failed",
      short: "Restart failed",
      tone: "bad",
      dot: true,
      title: "The service did not restart nod",
    };
  if (installation.status === "failed" && kind)
    return {
      label: "Update failed",
      short: "Failed",
      tone: "bad",
      dot: true,
      title: installation.error ?? "The update did not install",
    };
  if (latest && kind === "upgrade")
    return {
      label: `Update ${latest.version}`,
      short: "Update",
      tone: "need",
      dot: true,
      title: `nod ${latest.version} is out; you run ${app.version}`,
    };
  if (latest && kind === "downgrade")
    return {
      label: `Switch to ${latest.version}`,
      short: "Switch",
      tone: "need",
      dot: true,
      title: `${app.channel} is on ${latest.version}; you run ${app.version}`,
    };
  if (updated && app.version === updated.to)
    return {
      label: `Updated to ${updated.to}`,
      short: "Updated",
      tone: "ok",
      dot: false,
      title: `nod runs ${updated.to} now`,
    };
  return null;
}

/** Whether the settings nav marks the Server section. */
export function serverNeedsLook(app: AppState | null): boolean {
  const indicator = indicatorOf(app, null);
  return indicator !== null && indicator.dot;
}

// ---------------------------------------------------------------------------
// remembered across the restart

export const UPDATING_KEY = "nod.updating";
/** How long "updated to x" waits for the new version, and then shows. */
export const UPDATED_MS = 60 * 60 * 1000;

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Noted extends Updated {
  readonly at: number;
}

function read(storage: KeyValue): Noted | null {
  try {
    const value = JSON.parse(storage.getItem(UPDATING_KEY) ?? "null") as Partial<Noted> | null;
    if (!value || typeof value.to !== "string" || typeof value.at !== "number") return null;
    return {
      from: typeof value.from === "string" ? value.from : null,
      to: value.to,
      at: value.at,
    };
  } catch {
    return null;
  }
}

/** Notes the version being installed once it is installed (a restart is next). */
export function noteUpdating(storage: KeyValue, app: AppState | null, now: number): void {
  if (!app) return;
  const { installation } = app.update;
  if (installation.status !== "installed" || !installation.version) return;
  if (read(storage)?.to === installation.version) return;
  try {
    storage.setItem(
      UPDATING_KEY,
      JSON.stringify({ from: app.version, to: installation.version, at: now } satisfies Noted),
    );
  } catch {
    // no storage: no "updated" note, nothing else lost
  }
}

/** The update that finished, when the server runs the version noted; forgets a stale note. */
export function updatedOf(storage: KeyValue, app: AppState | null, now: number): Updated | null {
  const noted = read(storage);
  if (!noted || !app) return null;
  if (now - noted.at > UPDATED_MS) {
    forgetUpdated(storage);
    return null;
  }
  if (app.version === noted.to) return { from: noted.from, to: noted.to };
  // Still the old one (restarting, or by hand later): wait. Anything else: forget.
  if (app.version !== noted.from) forgetUpdated(storage);
  return null;
}

export function forgetUpdated(storage: KeyValue): void {
  try {
    storage.removeItem(UPDATING_KEY);
  } catch {
    // nothing to forget
  }
}

// ---------------------------------------------------------------------------
// Settings → Server's words

export const CHANNEL_WORDS: Readonly<Record<UpdateChannel, { label: string; line: string }>> = {
  stable: {
    label: "Stable",
    line: "the releases, npm’s latest: tried for longer, fewer of them",
  },
  next: {
    label: "Next",
    line: "every change merged to main, npm’s next: sooner, less tried",
  },
};

const ago = (at: number, now: number) =>
  now - at < 60_000 ? "just now" : `${duration(now - at)} ago`;

/** The line under the version: where the update check stands. */
export function updateLine(app: AppState, now: number): string {
  const { update } = app;
  if (update.status === "checking") return "Checking GitHub for a release…";
  if (update.status === "error")
    return `The last check failed: ${update.error ?? "GitHub did not answer"}`;
  const checked = update.checkedAt ? `checked ${ago(update.checkedAt, now)}` : "not checked yet";
  if (app.development)
    return update.latest
      ? `The ${app.channel} channel is on ${update.latest.version} · ${checked}`
      : `A checkout checks only when asked · ${checked}`;
  if (update.kind === "upgrade" && update.latest)
    return `${update.latest.version} is out · ${checked}`;
  if (update.kind === "downgrade" && update.latest)
    return `The ${app.channel} channel is on ${update.latest.version}, older than this one · ${checked}`;
  if (update.status === "up-to-date") return `Up to date · ${checked}`;
  return checked.charAt(0).toUpperCase() + checked.slice(1);
}

/** "released 2 days ago" for a release. */
export function releasedLine(publishedAt: number, now: number): string {
  return publishedAt > 0 ? `released ${ago(publishedAt, now)}` : "";
}

/** The service in one line. */
export function serviceLine(service: ServiceView): string {
  const how = service.manager === "launchd" ? "a LaunchAgent" : "a systemd user unit";
  switch (service.state) {
    case "unknown":
      return "nod could not read the service’s state.";
    case "unsupported":
      return "Running nod in the background is built for Linux and macOS only.";
    case "not-installed":
      return "Not set up: nod runs while the terminal that started it does.";
    case "stopped":
      return `Set up as ${how}, but not running.`;
    case "running":
      return service.thisNod
        ? `Running as ${how}: this nod serve is the service.`
        : `Running as ${how}, but this nod serve is another one, started by hand.`;
  }
}
