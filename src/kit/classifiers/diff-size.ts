import type { ChangedFile } from "../patch-id.ts";
import { DEPENDENCY_LOCKFILES } from "./dependencies.ts";
import { matchAny } from "./glob.ts";
import { count } from "./paths.ts";
import type { Classifier, Risk } from "./types.ts";

/**
 * Files that do not count toward a PR's size: lockfiles and generated
 * output. The UI's diff indicator ignores the same list.
 */
export const DIFF_SIZE_IGNORE: readonly string[] = [
  ...DEPENDENCY_LOCKFILES,
  // generated output
  "**/*.min.{js,css}",
  "**/*.map",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
  "**/dist/**",
];

/** Line totals of a PR, without ignored files. */
export interface DiffStat {
  added: number;
  removed: number;
  /** Files that counted. */
  files: number;
  /** Files left out by the ignore list. */
  ignored: number;
}

/** Sums the lines of the files not matched by `ignore` (default {@link DIFF_SIZE_IGNORE}). */
export function diffStat(
  files: readonly ChangedFile[],
  ignore: readonly string[] = DIFF_SIZE_IGNORE,
): DiffStat {
  const stat: DiffStat = { added: 0, removed: 0, files: 0, ignored: 0 };
  for (const f of files) {
    if (matchAny(ignore, f.path)) {
      stat.ignored++;
      continue;
    }
    stat.files++;
    stat.added += f.added;
    stat.removed += f.removed;
  }
  return stat;
}

/** Options for {@link diffSize}. */
export interface DiffSizeOptions {
  /**
   * The risk a PR gets from its changed lines (added plus removed): the
   * smallest number of lines for each risk. Default `{ 1: 50, 2: 400, 3: 1000 }`.
   */
  thresholds?: Partial<Record<Risk, number>>;
  /** Globs that do not count (default {@link DIFF_SIZE_IGNORE}). */
  ignore?: readonly string[];
}

const SIZE_TAGS: Record<Risk, string> = { 0: "size:s", 1: "size:m", 2: "size:l", 3: "size:xl" };

/**
 * Rates the PR by its size, ignoring lockfiles and generated files. Always
 * gives exactly one finding, tagged `size:s`, `size:m`, `size:l` or `size:xl`.
 */
export function diffSize(options: DiffSizeOptions = {}): Classifier {
  const thresholds = options.thresholds ?? { 1: 50, 2: 400, 3: 1000 };
  const ignore = options.ignore ?? DIFF_SIZE_IGNORE;
  return ({ files }) => {
    const stat = diffStat(files, ignore);
    const lines = stat.added + stat.removed;
    let risk: Risk = 0;
    for (const r of [1, 2, 3] as const) {
      const min = thresholds[r];
      if (min !== undefined && lines >= min) risk = r;
    }
    const ignored = stat.ignored
      ? `, ${count(stat.ignored, "lockfile or generated file")} ignored`
      : "";
    return [
      {
        classifier: "diffSize",
        tag: SIZE_TAGS[risk],
        risk,
        detail: `+${stat.added} −${stat.removed} in ${count(stat.files, "file")}${ignored}`,
      },
    ];
  };
}
