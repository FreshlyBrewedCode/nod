/**
 * The browser's offer to install the app (ADR 0008 §11). Chromium fires
 * `beforeinstallprompt` once, early, often before React mounts, so
 * `listenForInstall` (called from `main.tsx`) keeps the event at module
 * level and `useInstall` reads it. `appinstalled` marks it done. Where no
 * event comes (Safari, Firefox, an installed app), `prompt` stays null and
 * Settings → App says how this browser does it.
 */

import { useSyncExternalStore } from "react";

/** The part of Chromium's `BeforeInstallPromptEvent` we use. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

interface InstallStore {
  readonly prompt: InstallPromptEvent | null;
  readonly installed: boolean;
}

let store: InstallStore = { prompt: null, installed: false };
const listeners = new Set<() => void>();
const set = (next: InstallStore) => {
  store = next;
  for (const listener of listeners) listener();
};

/** Start listening; once, at start. */
export function listenForInstall(win: Window = window): void {
  win.addEventListener("beforeinstallprompt", (event) => {
    // Ours to show, quietly: no mini-infobar.
    event.preventDefault();
    set({ ...store, prompt: event as InstallPromptEvent });
  });
  win.addEventListener("appinstalled", () => set({ prompt: null, installed: true }));
}

export interface Install {
  /** The browser offers it now: `install()` shows its dialog. */
  readonly available: boolean;
  /** Installed from this page, this session. */
  readonly installed: boolean;
  /** Show the browser's install dialog; resolves with whether it was accepted. */
  install(): Promise<boolean>;
}

async function install(): Promise<boolean> {
  const event = store.prompt;
  if (!event) return false;
  // The event can be used once.
  set({ ...store, prompt: null });
  try {
    await event.prompt();
    return (await event.userChoice).outcome === "accepted";
  } catch {
    return false;
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useInstall(): Install {
  const { prompt, installed } = useSyncExternalStore(subscribe, () => store);
  return { available: prompt !== null, installed, install };
}
