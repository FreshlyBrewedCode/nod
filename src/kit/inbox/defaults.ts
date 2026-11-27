/**
 * The built-in defaults (ADR 0009 decision 10): what runs without an
 * `inbox.ts`, and what `...defaults().classifiers` keeps in one.
 *
 * Pure: imports nothing from Node.
 */
import { briefMismatch, overlapsMyWork } from "./classifiers.ts";
import { diffComposition } from "./composition.ts";
import { defineInbox } from "./define.ts";
import { hotspots } from "./history.ts";
import type { Inbox, InboxParts } from "./types.ts";

/**
 * The default classifiers and analyzers, fresh each call:
 *
 * - classifiers: {@link overlapsMyWork} and {@link briefMismatch};
 * - analyzers: {@link diffComposition}, {@link hotspots} (`days: 30`) and
 *   the insight of {@link overlapsMyWork}.
 *
 * `familiarity()` is not among them; add it yourself.
 *
 * ```ts
 * const base = defaults();
 * export default defineInbox({
 *   classifiers: [...base.classifiers, mute({ authors: ["renovate"] })],
 *   analyzers: base.analyzers,
 * });
 * ```
 */
export function defaults(): InboxParts {
  const overlaps = overlapsMyWork();
  return {
    classifiers: [overlaps, briefMismatch()],
    analyzers: [diffComposition(), hotspots({ days: 30 }), overlaps],
  };
}

/** The inbox that runs when there is no `inbox.ts`: {@link defaults}, for every repo. */
export function defaultInbox(): Inbox {
  return defineInbox(defaults());
}
