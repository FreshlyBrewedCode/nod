/**
 * Reload on save (ADR 0009, #57): watches the inbox folder and calls back,
 * debounced, after a change to anything in it but `node_modules/` (a `bun
 * install` there touches thousands of files and changes no code of mine).
 * A folder that does not exist yet is waited for: its parent is watched
 * until it appears (`nod inbox init` while `nod serve` runs).
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

export function watchFolder(
  dir: string,
  onChange: () => void,
  options: { readonly debounceMs?: number } = {},
): () => void {
  const debounceMs = options.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let parent: FSWatcher | null = null;
  let stopped = false;

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, debounceMs);
  };

  const close = (w: FSWatcher | null) => {
    try {
      w?.close();
    } catch {
      // closed already
    }
  };

  const arm = () => {
    if (stopped) return;
    if (existsSync(dir)) {
      close(parent);
      parent = null;
      try {
        watcher = watch(dir, { recursive: true }, (_event, file) => {
          const name = typeof file === "string" ? file : "";
          if (name.split(/[\\/]/).includes("node_modules")) return;
          fire();
        });
        watcher.on("error", () => {
          // The folder went away: wait for it again.
          close(watcher);
          watcher = null;
          fire();
          setTimeout(arm, debounceMs);
        });
      } catch {
        watcher = null;
      }
      return;
    }
    // Not there yet: watch the parent for it (only when the parent exists).
    const up = dirname(dir);
    if (!existsSync(up)) return;
    try {
      parent = watch(up, (_event, file) => {
        if (typeof file === "string" && file !== basename(dir)) return;
        if (existsSync(dir)) {
          fire();
          arm();
        }
      });
    } catch {
      parent = null;
    }
  };

  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    close(watcher);
    close(parent);
  };
}
