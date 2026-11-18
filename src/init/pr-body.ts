/**
 * The setup PR's title and description: what each file is, why this PR
 * merges under the old rule, the one step a repo admin takes after the
 * merge, and the honest limits of Actions mode (ADR 0003).
 */
import { RULESET_NAME } from "./ruleset.ts";
import type { Signer } from "./setup-files.ts";

/** Title of the setup PR (a conventional commit, as it is squash-merged). */
export const SETUP_PR_TITLE = "chore: set up nod (.nod/ and the verifier workflow)";

/** Branch the setup is committed on. */
export const SETUP_BRANCH = "nod/setup";

export interface SetupPrContext {
  /** `owner/name`. */
  repo: string;
  defaultBranch: string;
  signers: readonly Signer[];
  /** The kit dependency written to `.nod/package.json`. */
  kitSpec: string;
  isPrivate: boolean;
}

/** The setup PR's body, in Markdown. */
export function setupPrBody(ctx: SetupPrContext): string {
  const { repo, defaultBranch, signers, kitSpec, isPrivate } = ctx;
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  const who = signers.length
    ? signers.map((s) => code(s.login)).join(", ")
    : "nobody yet (add a key before merging, or nothing can ever be nodded)";

  const lines = [
    "This PR sets up **nod** in this repository: a check named `nod` that turns green once the right humans have nodded a PR with a signed comment, so that agents can merge their own PRs with auto-merge. The logic lives here, in `.nod/`, readable top to bottom. The npm package only provides helpers.",
    "",
    "## What each file is",
    "",
    "| File | What it is |",
    "|---|---|",
    "| `.nod/policy.ts` | What a PR needs before it may merge: classifiers (paths, diff size, dependencies, the PR brief, your own) and rules that map them to none, a self nod, a peer nod or a named person. Yours to change. |",
    "| `.nod/classifiers/module-tier.ts` | An **example** custom classifier (module tiers from `modules/<name>/module.json`, `core/` is high risk). Delete or adapt it. |",
    "| `.nod/verify.ts` | The whole verifier, top to bottom: fetches the PR as git objects, classifies it, verifies every nod with `ssh-keygen`, sets the `nod` check, updates one sticky comment and the `nod:*` labels. |",
    `| \`.nod/allowed_signers\` | Who can nod: public SSH keys, principal = GitHub login. Enrolled here: ${who}. |`,
    `| \`.nod/package.json\`, \`.nod/bun.lock\` | Pin the helper kit (\`${kitSpec.replace(/`/g, "'")}\`). Dependabot can bump it. |`,
    "| `.nod/.gitignore` | Keeps `.nod/node_modules` out of git. |",
    "| `.github/workflows/nod.yml` | Runs `.nod/verify.ts` on every PR event and PR comment. It checks out the default branch only, never code from the PR, and its job is deliberately not named `nod`. |",
    "",
    "## This PR merges under the current rules",
    "",
    "The verifier does not exist until this PR is merged, so this PR cannot be gated by it. Review it like any other change and merge it the way this repository merges today. From then on, every change to `.nod/` or `.github/workflows/` needs a peer's nod, this setup included.",
    "",
    "## After merging: one step for a repo admin",
    "",
    `Make \`nod\` the gate of \`${defaultBranch}\` and turn on auto-merge. Either run`,
    "",
    "```sh",
    `nod init --ruleset --repo ${repo}`,
    "```",
    "",
    "or set it up by hand:",
    "",
    `1. **Settings → Rules → Rulesets → New branch ruleset**, named \`${RULESET_NAME}\`, enforcement **Active**, target the default branch, bypass list **empty**.`,
    "2. **Require a pull request before merging** with **0** required approvals.",
    "3. **Require status checks to pass**: add `nod` and pick **GitHub Actions** as its source.",
    "4. **Block force pushes** and **restrict deletions**.",
    "5. **Settings → General → Pull Requests → Allow auto-merge.**",
    "",
    "If classic branch protection or another ruleset still requires approvals on this branch, lower that to 0, or auto-merge will keep waiting for an approval as well.",
    isPrivate
      ? "\nThis repository is **private**: rulesets on private repositories need GitHub Pro, Team or Enterprise. On GitHub Free `nod init --ruleset` will say so and change nothing."
      : "",
    "",
    "Also check **Settings → Actions → General**: GitHub announced that from 2026-12-02 a default rule may block `pull_request_target` workflows in public repositories unless they are allowed. If the `verify` job stops running on new PRs, allow `.github/workflows/nod.yml` there.",
    "",
    "## What nod does not protect against (Actions mode)",
    "",
    "- **A forged check.** In this setup the `nod` check comes from the GitHub Actions app, like every workflow's checks. Anyone who can push a workflow file to any branch can create a green `nod` check from the same app, and GitHub cannot tell the two apart. nod guards against mistakes and unattended merges, not against an agent that sets out to forge a check. A self-owned GitHub App for the check (app mode) closes this later; `.nod/verify.ts` already takes the check token from one place for it.",
    "- **An owner token.** A token with admin rights on this repository can change or delete the ruleset.",
    "- Recommended settings for agents working here:",
    "  - give them a token **without the `workflow` scope** (and, with fine-grained tokens, without the Administration and Workflows permissions), and no SSH key that can push;",
    "  - forbid `gh pr merge --admin` and changes to `.github/workflows/**` in their instructions.",
    "",
    "## One-human repositories",
    "",
    "Changes to `.nod/**` need a **peer** nod: someone enrolled other than the PR's author. If you are the only human here, nobody can give that nod, so changing the policy, the verifier or the signers then needs a repo admin to lift the ruleset for that one merge and put it back. Enrolling a second person in this PR avoids that.",
    "",
    "## How to nod",
    "",
    "Run `nod serve` and open the dashboard, or sign by hand: the comment format is in the nod repository (ADR 0001). A nod covers the PR's head commit or its patch-id, so a clean rebase keeps it and any change to the content needs a new one.",
  ];
  return `${lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n")}\n`;
}
