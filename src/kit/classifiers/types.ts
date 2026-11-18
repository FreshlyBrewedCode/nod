/**
 * The classifier contract. A classifier is a plain function from what is
 * known about a PR to a list of findings; a team's own classifier in
 * `.nod/classifiers/` is just another such function.
 */
import type { ChangedFile } from "../patch-id.ts";

/** Risk from 0 to 3: none, low, medium, high. */
export type Risk = 0 | 1 | 2 | 3;

/** Names for the four risk values, for display. */
export const RISK_NAMES: Readonly<Record<Risk, string>> = {
  0: "none",
  1: "low",
  2: "medium",
  3: "high",
};

/** The PR fields a classifier may read. Title, body and labels are written by the author: untrusted. */
export interface PullRequestInfo {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: readonly string[];
  /** Base branch. */
  base: string;
  head_sha: string;
}

/** Everything a classifier gets. */
export interface ClassifierContext {
  pr: PullRequestInfo;
  /** Every changed file, from git (never the 3000-file files API). */
  files: readonly ChangedFile[];
  /**
   * Reads a file as it is on the **base branch tip**, or `null` if it does
   * not exist there. Content from the base is trusted: the PR cannot change
   * what this returns, e.g. it cannot lower its own module's tier.
   */
  readBaseFile(path: string): Promise<string | null>;
}

/** One fact a classifier found. */
export interface Finding {
  /** Which classifier said it, e.g. `paths`. */
  classifier: string;
  /** A short machine-readable tag rules match on, e.g. `core` or `deps-only`. */
  tag: string;
  /** The risk floor this finding sets. Omitted means it does not affect risk. */
  risk?: Risk;
  /** One human sentence, shown as a reason. */
  detail: string;
}

/** A classifier: `(ctx) => Finding[]`, sync or async. */
export type Classifier = (ctx: ClassifierContext) => Finding[] | Promise<Finding[]>;
