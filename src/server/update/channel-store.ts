/**
 * Where the chosen update channel lives. A tiny interface, so the config file
 * of epic C (`$XDG_CONFIG_HOME/nod/config.json`) can plug in its own store;
 * until then {@link memoryChannelStore} and {@link jsonFileChannelStore} do.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
 * `{ "channel": "next" }` in a JSON file; other keys of the file are kept
 * as they are (the file is shared with the rest of nod's config). A missing,
 * unreadable or odd file reads as "no choice".
 */
export function jsonFileChannelStore(path: string): ChannelStore {
  let fallback: Channel | null = null;
  const read = (): Record<string, unknown> => {
    try {
      const json: unknown = JSON.parse(readFileSync(path, "utf8"));
      return json && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    get() {
      const value = read().channel;
      return isChannel(value) ? value : fallback;
    },
    set(channel) {
      fallback = channel;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ ...read(), channel }, null, 2)}\n`);
        renameSync(tmp, path);
        fallback = null;
      } catch {
        // keep the choice in memory for this run
      }
    },
  };
}
