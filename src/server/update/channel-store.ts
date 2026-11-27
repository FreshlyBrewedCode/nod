/**
 * Where the chosen update channel lives: a tiny interface, with
 * {@link memoryChannelStore} (tests, `--fake`) and {@link jsonFileChannelStore}
 * (`$XDG_CONFIG_HOME/nod/config.json`, shared with the repo list).
 */

import { readConfigValue, updateConfig } from "../config";
import { isRelease } from "../web-url";
import { isChannel, type Channel } from "./release-feed";
import { isPrerelease } from "./semver";

export interface ChannelStore {
  /** The chosen channel, or null when none was chosen yet. */
  get(): Channel | null;
  /** Never throws; a store that cannot write keeps the choice for this run. */
  set(channel: Channel): void;
}

/** Without a choice a build follows the channel it came from: a `-next.N` build is on next, the rest on stable. */
export function defaultChannel(version: string | null | undefined): Channel {
  return isRelease(version) && isPrerelease(version) ? "next" : "stable";
}

export function memoryChannelStore(initial: Channel | null = null): ChannelStore {
  let channel = initial;
  return {
    get: () => channel,
    set: (next) => {
      channel = next;
    },
  };
}

/**
 * `{ "channel": "next" }` in nod's config file (`config.json`, owned by
 * `src/server/config.ts`, which also keeps the repo list): every write goes
 * through `updateConfig`, so the repo list and any other key survive, the
 * write is atomic and a file that is not JSON, or of a newer version, is
 * never written over. A missing, unreadable or odd file reads as "no
 * choice"; a write that fails keeps the choice in memory for this run.
 */
export function jsonFileChannelStore(path: string): ChannelStore {
  let fallback: Channel | null = null;
  return {
    get() {
      const value = readConfigValue(path, "channel");
      return isChannel(value) ? value : fallback;
    },
    set(channel) {
      fallback = channel;
      try {
        updateConfig(path, (json) => ({ ...json, channel }));
        fallback = null;
      } catch {
        // keep the choice in memory for this run
      }
    },
  };
}
