/**
 * The real `Source`: GitHub through the user's `gh` token. A later task.
 *
 * The plan, so the seam fits it:
 * - `gh auth token` once at start (never logged), GraphQL polling about every
 *   60 s with ETag, one repo per server;
 * - per PR the verifier's machine-readable summary from the `nod` check run's
 *   output on the head SHA (the kit's `CheckSummary`), turned into `PrFacts`
 *   and then into the view model by `view.ts`;
 * - nod comments posted with the REST API, FYI acks as a reaction;
 * - setup checks read `.nod/` and the ruleset from the base branch.
 */

import type { Clock } from "./clock";
import { SourceError, type Source } from "./source";

export interface GithubSourceOptions {
  readonly clock: Clock;
  /** `owner/name`; null: onboarding picks one. */
  readonly repo: string | null;
}

export function githubSource(_options: GithubSourceOptions): Source {
  throw new SourceError(
    "not-implemented",
    "Reading GitHub is not implemented yet. Run `nod serve --fake` to try the dashboard with fake data.",
  );
}
