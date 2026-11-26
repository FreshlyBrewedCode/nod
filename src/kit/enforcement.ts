/**
 * Whether the `nod` check is enforced on a branch (ADR 0006): required by
 * a ruleset or by classic branch protection. The verifier asks on every run,
 * for the PR's base branch, and concludes `neutral` instead of `failure`
 * only when the answer is a clear no: `neutral` passes a required check, so
 * any doubt counts as enforced.
 */
import { githubRequest, type GitHubOptions } from "./github.ts";
import { isRepoName } from "./nod.ts";

/** What says the check is enforced; `unknown` when it was assumed because GitHub could not tell. */
export type EnforcedBy = "ruleset" | "branch_protection" | "policy" | "unknown";

/** Whether the `nod` check is enforced, and what says so. */
export interface Enforcement {
  /**
   * The check is required (or treated as such): an unmet requirement is a
   * `failure` and the sticky comment is on. `false`: `neutral`, no sticky.
   */
  enforced: boolean;
  /** `null` when not enforced. */
  by: EnforcedBy | null;
  /** Why it was assumed (`by: "unknown"`), e.g. the lookup that failed. */
  detail?: string;
}

/** Enforced because the policy says `enforced: true`. */
export const ENFORCED_BY_POLICY: Enforcement = Object.freeze({
  enforced: true,
  by: "policy",
});

/**
 * Asks GitHub whether `branch` requires the check `check` (default `nod`):
 * an active ruleset's `required_status_checks` rule naming it
 * (`GET /repos/{o}/{r}/rules/branches/{branch}`, the repo's and the
 * organization's rulesets), or classic branch protection whose required
 * checks name it (`GET /repos/{o}/{r}/branches/{branch}`). Both are readable
 * with the workflow token's default `metadata: read`.
 *
 * Never throws: a failed lookup, or a protected branch whose required checks
 * the token cannot see, answers `{ enforced: true, by: "unknown" }`.
 * `policy.enforced` skips the lookup.
 */
export async function getEnforcement(
  options: GitHubOptions,
  branch: string,
  opts: { check?: string; policy?: { readonly enforced?: true } } = {},
): Promise<Enforcement> {
  if (opts.policy?.enforced === true) return ENFORCED_BY_POLICY;
  const check = opts.check ?? "nod";
  try {
    if (!isRepoName(options.repo)) throw new Error(`not an owner/name repo: ${options.repo}`);
    if (!branch) throw new Error("no branch");
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const rules = await githubRequest(
      options,
      "GET",
      `/repos/${options.repo}/rules/branches/${ref}`,
    );
    if (requiredByRules(rules, check)) return { enforced: true, by: "ruleset" };
    const info = await githubRequest(options, "GET", `/repos/${options.repo}/branches/${ref}`);
    const classic = requiredByProtection(info, check);
    if (classic === true) return { enforced: true, by: "branch_protection" };
    if (classic === null)
      return {
        enforced: true,
        by: "unknown",
        detail: `${branch} is protected, but its required checks could not be read`,
      };
    return { enforced: false, by: null };
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    return { enforced: true, by: "unknown", detail: `could not look it up: ${why}` };
  }
}

/** Whether a `rules/branches` answer has a `required_status_checks` rule naming `check`. */
export function requiredByRules(rules: unknown, check = "nod"): boolean {
  if (!Array.isArray(rules)) throw new Error("the branch rules are not a list");
  return rules.some((rule) => {
    const r = rule as {
      type?: unknown;
      parameters?: { required_status_checks?: Array<{ context?: unknown }> };
    } | null;
    return (
      r?.type === "required_status_checks" &&
      (r.parameters?.required_status_checks ?? []).some((c) => c?.context === check)
    );
  });
}

/**
 * Whether a `branches/{branch}` answer's classic protection requires
 * `check`: `false` when the branch is not protected or its required checks
 * leave it out, `null` when it is protected but the required checks are not
 * in the answer.
 */
export function requiredByProtection(branch: unknown, check = "nod"): boolean | null {
  const b = branch as {
    protected?: unknown;
    protection?: {
      required_status_checks?: {
        enforcement_level?: unknown;
        contexts?: unknown;
        checks?: unknown;
      } | null;
    } | null;
  } | null;
  if (b?.protected !== true) return false;
  const required = b.protection?.required_status_checks;
  if (!required) return null;
  if (required.enforcement_level === "off") return false;
  const contexts = Array.isArray(required.contexts) ? required.contexts : [];
  const checks = Array.isArray(required.checks) ? required.checks : [];
  return (
    contexts.includes(check) ||
    checks.some((c) => (c as { context?: unknown } | null)?.context === check)
  );
}
