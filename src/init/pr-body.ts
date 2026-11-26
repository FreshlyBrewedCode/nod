/**
 * The setup PR's title and description: what each file is, why this PR
 * merges under the old rule, that the check never blocks until a repo
 * admin requires it (ADR 0006), that step, and the honest limits of Actions
 * mode (ADR 0003).
 */
import { GITHUB_COM, githubHost } from "../kit/host.ts";
import { RULESET_NAME } from "./ruleset.ts";
import type { Signer } from "./setup-files.ts";

/** Title of the setup PR (a conventional commit, as it is squash-merged). */
export const SETUP_PR_TITLE = "chore: set up nod (.nod/ and the verifier workflow)";

/** Branch the setup is committed on. */
export const SETUP_BRANCH = "nod/setup";

/** The command a repo admin runs after the setup PR merged; `--host` off github.com. */
export function rulesetCommand(host: string, repo: string): string {
  return `nod init --ruleset --repo ${repo}${host === GITHUB_COM ? "" : ` --host ${host}`}`;
}

/**
 * What a runner on an Enterprise host needs for the kit pin, in one
 * sentence; null on github.com. A git pin comes from github.com, a version
 * range from the npm registry.
 */
export function kitAccessNote(host: string, kitSpec: string): string | null {
  if (host === GITHUB_COM) return null;
  const where = /^(github:|git\+|https?:)/.test(kitSpec)
    ? "github.com (it is a git dependency)"
    : "the npm registry, registry.npmjs.org (it is a version range), or an npm mirror your runners use";
  return `This repository is on ${host}: the verifier's runner installs the kit pin from ${where}, so the runners need outbound access there, or \`nod init --kit\` must point at a copy they can reach.`;
}

export interface SetupPrContext {
  /** `owner/name`. */
  repo: string;
  /** The GitHub host (`github.com`, `acme.ghe.com`, …); default github.com. */
  host?: string;
  defaultBranch: string;
  signers: readonly Signer[];
  /** The kit dependency written to `.nod/package.json`. */
  kitSpec: string;
  isPrivate: boolean;
}

/** The setup PR's body, in Markdown. */
export function setupPrBody(ctx: SetupPrContext): string {
  const { repo, defaultBranch, signers, kitSpec, isPrivate } = ctx;
  const host = ctx.host ?? GITHUB_COM;
  const kitNote = kitAccessNote(host, kitSpec);
  const actionsNote =
    githubHost(host).kind !== "server"
      ? null
      : "On GitHub Enterprise Server the workflow's actions (`actions/checkout`, `oven-sh/setup-bun`) come from github.com: they need GitHub Connect's access to GitHub.com actions, or copies synced to this server.";
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  const who = signers.length
    ? signers.map((s) => code(s.login)).join(", ")
    : "nobody yet (add a key before merging, or nothing can ever be nodded)";

  const lines = [
    "This PR sets up **nod** in this repository: a check named `nod` that turns green once the right humans have looked at a PR, with a plain GitHub approval or a signed nod comment, so that agents can merge their own PRs with auto-merge. The logic lives here, in `.nod/`, readable top to bottom. The npm package only provides helpers.",
    "",
    `**Nothing is blocked yet.** Until a repo admin makes \`nod\` required on \`${defaultBranch}\` (the step below), the check never blocks a merge: a PR that still needs someone shows a grey, neutral \`nod\` check that says who, and the verifier posts no comment. Everyone keeps merging the way they do today.`,
    "",
    "## What each file is",
    "",
    "| File | What it is |",
    "|---|---|",
    "| `.nod/policy.ts` | What a PR needs before it may merge: classifiers (paths, diff size, dependencies, the PR brief, your own) and rules that map them to nobody, the author (self), someone else (peer) or a named person. A GitHub approval counts unless a rule asks for a signed nod only. Yours to change. |",
    "| `.nod/classifiers/module-tier.ts` | An **example** custom classifier (module tiers from `modules/<name>/module.json`, `core/` is high risk). Delete or adapt it. |",
    "| `.nod/verify.ts` | The whole verifier, top to bottom: fetches the PR as git objects, classifies it, verifies every nod with `ssh-keygen`, reads the approvals, sets the `nod` check (neutral until it is required), updates the `nod:*` labels and, once the check is required, one sticky comment. |",
    `| \`.nod/allowed_signers\` | Who can nod: public SSH keys, principal = GitHub login. Enrolled here: ${who}. |`,
    `| \`.nod/package.json\`, \`.nod/bun.lock\` | Pin the helper kit (\`${kitSpec.replace(/`/g, "'")}\`). Dependabot can bump it. |`,
    "| `.nod/.gitignore` | Keeps `.nod/node_modules` out of git. |",
    "| `.github/workflows/nod.yml` | Runs `.nod/verify.ts` on every PR event and PR comment. It checks out the default branch only, never code from the PR, and its job is deliberately not named `nod`. |",
    "",
    ...(kitNote ? [kitNote, ""] : []),
    ...(actionsNote ? [actionsNote, ""] : []),
    "## This PR merges under the current rules",
    "",
    "The verifier does not exist until this PR is merged, so this PR cannot be gated by it. Review it like any other change and merge it the way this repository merges today. Once the check is required, every change to `.nod/` or `.github/workflows/` needs a peer's signed nod (an approval is not enough), this setup included.",
    "",
    "## When you want it to block: one step for a repo admin",
    "",
    `Make \`nod\` the gate of \`${defaultBranch}\` and turn on auto-merge, whenever the team is ready (it needs this PR merged first). Either run`,
    "",
    "```sh",
    rulesetCommand(host, repo),
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
    "The verifier sees the required check on its next run of each PR. `nod init --ruleset` re-runs it for the open PRs whose `nod` check is still neutral (a neutral check would pass the new requirement); by hand, push to them or re-run their `verify` job.",
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
