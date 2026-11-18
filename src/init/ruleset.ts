/**
 * The ruleset that makes `nod` the gate of the default branch, as
 * `nod init --ruleset` applies it and the setup PR describes it.
 */

/** The GitHub Actions app (`gh api /apps/github-actions`). In Actions mode the `nod` check comes from it. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** Name of the ruleset `nod init --ruleset` creates or updates. */
export const RULESET_NAME = "nod";

/**
 * The ruleset: on the default branch, changes go through a PR with zero
 * required approvals, and the check `nod` must be green, from the given app
 * (default GitHub Actions). Nobody is on the bypass list, the owner included:
 * finding 01 showed that `--admin` is then refused.
 */
export function nodRuleset(integrationId: number = GITHUB_ACTIONS_APP_ID) {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: "nod", integration_id: integrationId }],
        },
      },
    ],
  };
}

/** Whether a GitHub error says the plan does not include rulesets (private repos on Free). */
export function isPlanRefusal(text: string): boolean {
  return /upgrade to github pro|make this repository public/i.test(text);
}

/** Plain words for a plan refusal. */
export const PLAN_REFUSAL =
  "GitHub refused the ruleset: this repository's plan does not include rulesets. Private repositories need GitHub Pro, Team or Enterprise; public repositories have them on every plan. Nothing was changed.";
