/**
 * The inbox step's classification (ADR 0006 decision 6): a repo with no nod
 * policy still gets a sorted list, because `nod serve` runs the kit's
 * built-in classifiers and default rules itself, on what GraphQL returns
 * (the file list with its line counts, the title and the body).
 *
 * Display only: no code from the repo runs, nothing is posted, and nothing
 * is gated by it. A verifier summary on the PR always wins over it; the
 * source calls this only for a PR without one, in a repo at the `inbox` step.
 * `map.ts` turns the result into the PR's risk, tags and reasons, marked as
 * classified locally.
 */

import { declared } from "../../kit/classifiers/declared.ts";
import { dependencies } from "../../kit/classifiers/dependencies.ts";
import { diffSize } from "../../kit/classifiers/diff-size.ts";
import { paths } from "../../kit/classifiers/paths.ts";
import type { Finding } from "../../kit/classifiers/types.ts";
import type { ChangedFile } from "../../kit/patch-id.ts";
import {
  defaultRules,
  definePolicy,
  evaluatePolicy,
  type Policy,
  type PolicyResult,
} from "../../kit/policy.ts";

/**
 * The paths `nod init`'s policy template starts with (`templates/.nod/policy.ts`),
 * so the inbox and a freshly set-up repo agree on them.
 */
export const LOCAL_PATHS = {
  ".nod/**": { tag: "nod-setup", risk: 3 },
  ".github/**": { tag: "ci-config", risk: 3 },
  "docs/**": { tag: "docs", risk: 0 },
  "*.md": { tag: "docs", risk: 0 },
} as const;

/** The built-in policy the inbox step runs: the template's paths, size, dependencies, the brief. */
export const LOCAL_POLICY: Policy = definePolicy({
  classifiers: [paths(LOCAL_PATHS), diffSize(), dependencies(), declared()],
  rules: defaultRules(),
});

/** What the local run reads about a PR: GraphQL's fields, nothing from the clone. */
export interface LocalInput {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly base: string;
  readonly headSha: string;
  /** As GraphQL lists them (the first 100). */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  /** How many files the PR changes; more than `files` when the list was cut. */
  readonly totalFiles: number;
}

/**
 * Classifies one PR with {@link LOCAL_POLICY}. When GitHub listed only part
 * of the files, a risk-3 finding says so: what was not seen is not low risk.
 */
export async function classifyLocally(input: LocalInput): Promise<PolicyResult> {
  const files: ChangedFile[] = input.files.map((f) => ({
    path: f.path,
    // GraphQL's list has no status; no built-in classifier reads it.
    status: "modified",
    added: f.additions,
    removed: f.deletions,
    binary: false,
  }));
  const result = await evaluatePolicy(LOCAL_POLICY, {
    pr: {
      repo: input.repo,
      number: input.number,
      title: input.title,
      body: input.body,
      author: input.author,
      labels: [],
      base: input.base,
      head_sha: input.headSha,
    },
    files,
    // The built-ins never read a file; no repo content is read here.
    readBaseFile: async () => null,
  });
  if (input.files.length >= input.totalFiles) return result;
  const partial: Finding = {
    classifier: "nod",
    tag: "partial",
    risk: 3,
    detail: `GitHub listed ${input.files.length} of ${input.totalFiles} files; the rest were not classified`,
  };
  return { ...result, category: "decide", risk: 3, reasons: [partial, ...result.reasons] };
}
