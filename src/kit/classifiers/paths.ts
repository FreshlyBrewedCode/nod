import { matchGlob } from "./glob.ts";
import type { Classifier, Finding, Risk } from "./types.ts";

/** What a path pattern means. */
export interface PathRule {
  tag: string;
  risk?: Risk;
}

/**
 * Tags files by path: `paths({ "core/**": { tag: "core", risk: 3 } })`.
 * Each pattern that matches at least one changed file gives one finding.
 * Patterns use {@link matchGlob} and match the whole path from the root.
 */
export function paths(rules: Readonly<Record<string, PathRule>>): Classifier {
  return ({ files }) => {
    const findings: Finding[] = [];
    for (const [glob, rule] of Object.entries(rules)) {
      const hits = files.filter((f) => matchGlob(glob, f.path)).map((f) => f.path);
      if (hits.length === 0) continue;
      findings.push({
        classifier: "paths",
        tag: rule.tag,
        ...(rule.risk === undefined ? {} : { risk: rule.risk }),
        detail: `${count(hits.length, "file")} under ${glob}: ${preview(hits)}`,
      });
    }
    return findings;
  };
}

/** `1 file`, `3 files`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The first few items, then `… and N more`. */
export function preview(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}
