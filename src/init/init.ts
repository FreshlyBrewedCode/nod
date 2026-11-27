/**
 * `nod init`: writes the repo-owned setup into a clone, commits it on
 * `nod/setup` and opens the setup PR with `gh`; `nod init --ruleset` then
 * makes `nod` the gate of the default branch. Everything that talks to
 * git, GitHub or bun goes through the injected {@link Runner}.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { GITHUB_COM, githubHost, parseRemote, type GitHubHost } from "../kit/host.ts";
import type { InitFlags } from "./args.ts";
import { enrolledLogins } from "../kit/sshsig.ts";
import {
  NOBODY_ENROLLED,
  rulesetCommand,
  SETUP_BRANCH,
  SETUP_PR_TITLE,
  setupPrBody,
} from "./pr-body.ts";
import {
  GITHUB_ACTIONS_APP_ID,
  isPlanRefusal,
  nodRuleset,
  PLAN_REFUSAL,
  RULESET_NAME,
} from "./ruleset.ts";
import { must, onHost, processRunner, type Runner } from "./runner.ts";
import {
  defaultKitSpec,
  isRelease,
  loadTemplates,
  parseSigner,
  renderSetup,
  TEMPLATES_DIR,
  type SetupFile,
  type Signer,
} from "./setup-files.ts";

export interface InitDeps {
  runner?: Runner;
  /** The running CLI's version (`0.0.0-development` in a checkout). */
  version: string;
  /** Where this CLI's own git checkout is, to pin the kit to its commit. */
  cliDir?: string;
  templatesDir?: string;
  cwd?: string;
  log?: (line: string) => void;
}

interface RepoInfo {
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
}

const SETUP_PATHS = [".nod", ".github/workflows/nod.yml"];

/** Runs `nod init` (or `nod init --ruleset`). Returns the exit code. */
export async function runInit(flags: InitFlags, deps: InitDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    if (flags.ruleset) return await applyRuleset(flags, deps, log);
    await setupRepo(flags, deps, log);
    return 0;
  } catch (error) {
    log(`nod init: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * `nod init` without `--ruleset`: writes, commits, pushes and opens the setup
 * PR. Resolves to the PR's URL (null for `--dry-run` and `--no-pr`); throws
 * with a sentence for the user. `nod serve`'s "open setup PR" calls this in a
 * temporary worktree of the user's clone.
 */
export async function setupRepo(
  flags: InitFlags,
  deps: InitDeps,
  log: (l: string) => void = deps.log ?? ((line: string) => console.log(line)),
): Promise<string | null> {
  const plain = deps.runner ?? processRunner;
  const dir = resolve(deps.cwd ?? process.cwd(), flags.dir ?? ".");
  const root = await must(plain, ["git", "-C", dir, "rev-parse", "--show-toplevel"]);
  const host = await resolveHost(plain, root, flags.host);
  const runner = onHost(plain, host.name);
  const info = await repoInfo(runner, host, root, flags.repo);

  // No signer is fine (ADR 0006): approvals count, and signing is each person's own step.
  const signers = await resolveSigners(runner, host, root, flags);
  const kitSpec = flags.kit ?? (await kitSpecFor(runner, deps));
  const files = renderSetup(await loadTemplates(deps.templatesDir ?? TEMPLATES_DIR), {
    kitSpec,
    signers,
  });
  const body = setupPrBody({ ...info, host: host.name, signers, kitSpec });

  if (flags.dryRun) {
    await refuseExisting(runner, root, null, flags.force);
    await writeSetup(root, files);
    log(`nod init --dry-run: wrote ${files.length} files into ${root}:`);
    for (const f of files) log(`  ${f.path}`);
    log("");
    log("Without --dry-run nod init would also:");
    log(`  - create the branch ${SETUP_BRANCH} from origin/${info.defaultBranch}`);
    log("  - run `bun install` in .nod/ to write .nod/bun.lock");
    log(`  - commit, push, and open the setup PR on ${info.repo}: "${SETUP_PR_TITLE}"`);
    if (signers.length === 0) log(`  (with nobody in .nod/allowed_signers: ${NOBODY_ENROLLED})`);
    log("");
    log("The PR description would be:\n");
    log(body);
    return null;
  }

  const status = await must(runner, ["git", "-C", root, "status", "--porcelain"]);
  if (status) throw new Error(`${root} has uncommitted changes: commit or stash them first`);
  const previous = await must(runner, ["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"]);
  await must(runner, ["git", "-C", root, "fetch", "--quiet", "origin", info.defaultBranch]);
  const base = `origin/${info.defaultBranch}`;
  await refuseExisting(runner, root, base, flags.force);

  const branchExists =
    (
      await runner.run([
        "git",
        "-C",
        root,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${SETUP_BRANCH}`,
      ])
    ).status === 0;
  if (branchExists && !flags.force)
    throw new Error(`the branch ${SETUP_BRANCH} exists already: delete it, or pass --force`);
  await must(runner, [
    "git",
    "-C",
    root,
    "switch",
    "--quiet",
    "--no-track",
    "-C",
    SETUP_BRANCH,
    base,
  ]);

  await writeSetup(root, files);
  log("installing the kit in .nod/ (writes .nod/bun.lock)…");
  await must(runner, ["bun", "install", "--ignore-scripts"], { cwd: join(root, ".nod") });
  if (!existsSync(join(root, ".nod", "bun.lock")))
    throw new Error("bun install did not write .nod/bun.lock");
  await must(runner, ["git", "-C", root, "add", "--", ...SETUP_PATHS]);
  await must(runner, ["git", "-C", root, "commit", "--quiet", "-m", commitMessage(kitSpec)]);
  await rm(join(root, ".nod", "node_modules"), { recursive: true, force: true });
  log(`committed the setup on ${SETUP_BRANCH}`);

  if (!flags.pr) {
    await switchBack(runner, root, previous);
    log("--no-pr: not pushed. To open the setup PR:");
    log(`  git push -u origin ${SETUP_BRANCH}`);
    log(
      `  gh pr create --repo ${ghRepo(host, info.repo)} --base ${info.defaultBranch} --head ${SETUP_BRANCH}`,
    );
    return null;
  }

  await must(runner, [
    "git",
    "-C",
    root,
    "push",
    "--quiet",
    ...(flags.force ? ["--force-with-lease"] : []),
    "-u",
    "origin",
    SETUP_BRANCH,
  ]);
  const tmp = await mkdtemp(join(tmpdir(), "nod-init-"));
  let url: string;
  try {
    const bodyFile = join(tmp, "body.md");
    await writeFile(bodyFile, body);
    url = await must(
      runner,
      [
        "gh",
        "pr",
        "create",
        "--repo",
        ghRepo(host, info.repo),
        "--base",
        info.defaultBranch,
        "--head",
        SETUP_BRANCH,
        "--title",
        SETUP_PR_TITLE,
        "--body-file",
        bodyFile,
      ],
      { cwd: root },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  await switchBack(runner, root, previous);
  const prUrl = url.split("\n").pop() ?? url;
  log(`opened the setup PR: ${prUrl}`);
  if (signers.length === 0) log(`Nobody is in .nod/allowed_signers yet: ${NOBODY_ENROLLED}`);
  log("It merges under this repository's current rules. After the merge the nod check shows");
  log("what each PR needs but never blocks; to make it required, a repo admin runs:");
  log(`  ${rulesetCommand(host.name, info.repo)}`);
  return prUrl;
}

/**
 * `nod init --ruleset`: creates or updates the ruleset `nod` on the default
 * branch, enables auto-merge and re-runs the verifier on open PRs whose
 * `nod` check is still neutral. Refuses while the verifier is not on the
 * default branch yet (requiring `nod` then blocks every merge).
 */
async function applyRuleset(
  flags: InitFlags,
  deps: InitDeps,
  log: (l: string) => void,
): Promise<number> {
  const plain = deps.runner ?? processRunner;
  const resolved = resolve(deps.cwd ?? process.cwd(), flags.dir ?? ".");
  const dir = existsSync(resolved) ? resolved : undefined;
  const host = await resolveHost(plain, dir, flags.host);
  const runner = onHost(plain, host.name);
  const api = (...args: string[]) => ghApi(host, args);
  const info = await repoInfo(runner, host, dir, flags.repo);
  const { repo, defaultBranch } = info;

  const verifier = await runner.run(
    api(
      `repos/${repo}/contents/.nod/verify.ts?ref=${encodeURIComponent(defaultBranch)}`,
      "--silent",
    ),
  );
  if (verifier.status !== 0 && !flags.force) {
    log(
      `nod init --ruleset: ${repo} has no .nod/verify.ts on ${defaultBranch} yet. Merge the setup PR first: requiring nod before the verifier runs would block every merge. (--force applies it anyway.)`,
    );
    return 1;
  }

  // The `nod` check comes from this host's GitHub Actions app; its id differs per host.
  const app = await runner.run(api("apps/github-actions", "--jq", ".id"));
  const found = Number(app.stdout.trim());
  let integrationId: number;
  if (app.status === 0 && Number.isSafeInteger(found) && found > 0) integrationId = found;
  else if (host.kind === "github.com") integrationId = GITHUB_ACTIONS_APP_ID;
  else {
    const why = (app.stderr.trim() || app.stdout.trim() || `exit ${app.status}`).split("\n")[0];
    log(
      `nod init --ruleset: could not look up the GitHub Actions app on ${host.name} (GET /apps/github-actions: ${why}). The ruleset pins the nod check to that app, and a wrong id would block every merge, so nothing was changed.`,
    );
    return 1;
  }
  const existing = await must(
    runner,
    api(
      `repos/${repo}/rulesets`,
      "--jq",
      `[.[] | select(.name == "${RULESET_NAME}") | .id] | first // ""`,
    ),
  ).catch((e: Error) => {
    if (isPlanRefusal(e.message)) return "refused";
    throw e;
  });
  if (existing === "refused") {
    log(`nod init --ruleset: ${PLAN_REFUSAL}`);
    return 1;
  }
  const payload = JSON.stringify(nodRuleset(integrationId));
  const write = existing
    ? api("-X", "PUT", `repos/${repo}/rulesets/${existing}`, "--input", "-")
    : api("-X", "POST", `repos/${repo}/rulesets`, "--input", "-");
  const r = await runner.run(write, { input: payload });
  if (r.status !== 0) {
    const text = `${r.stdout}\n${r.stderr}`;
    log(
      isPlanRefusal(text)
        ? `nod init --ruleset: ${PLAN_REFUSAL}`
        : `nod init --ruleset: GitHub refused the ruleset: ${r.stderr.trim() || r.stdout.trim()}`,
    );
    return 1;
  }
  log(
    `${existing ? "updated" : "created"} the ruleset "${RULESET_NAME}" on ${repo}: ${defaultBranch} needs a PR with 0 approvals and a green nod check from GitHub Actions (app ${integrationId}); nobody can bypass it.`,
  );

  await warnIfNobodyEnrolled(runner, api, repo, defaultBranch, log);

  const merge = await runner.run(
    api("-X", "PATCH", `repos/${repo}`, "-F", "allow_auto_merge=true", "--jq", ".allow_auto_merge"),
  );
  if (merge.status === 0 && merge.stdout.trim() === "true") log("auto-merge is enabled.");
  else
    log(
      "could not enable auto-merge (GitHub kept it off; on private repositories it needs a paid plan). Enable it under Settings → General → Pull Requests.",
    );

  await rerunNeutralChecks(runner, api, repo, defaultBranch, log);

  const protection = await runner.run(
    api(
      `repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection`,
      "--jq",
      ".required_pull_request_reviews.required_approving_review_count // 0",
    ),
  );
  if (protection.status === 0 && Number(protection.stdout.trim()) > 0) {
    log(
      `note: classic branch protection on ${defaultBranch} still requires ${protection.stdout.trim()} approval(s). Lower it to 0, or auto-merge keeps waiting for them.`,
    );
  }
  return 0;
}

/**
 * A required check with nobody in `.nod/allowed_signers`: approvals still
 * count, but the kit's protected paths (`.nod/**`, the workflows) take nods
 * only, so nobody can change nod's own setup any more, not even to enrol
 * the first key. Says so and how to get out; changes nothing. A file that
 * cannot be read says nothing (the verifier check above covers a missing setup).
 */
async function warnIfNobodyEnrolled(
  runner: Runner,
  api: (...args: string[]) => string[],
  repo: string,
  branch: string,
  log: (l: string) => void,
): Promise<void> {
  const file = await runner.run(
    api(
      `repos/${repo}/contents/.nod/allowed_signers?ref=${encodeURIComponent(branch)}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ),
  );
  if (file.status !== 0 || enrolledLogins(file.stdout).length > 0) return;
  log(
    `warning: nobody is enrolled in .nod/allowed_signers on ${branch}. Approvals still count, but a change to .nod/** or .github/workflows/** needs a peer's signed nod, which nobody can give: with the check required, nobody can change nod's own setup, not even to enrol the first key.`,
  );
  log(
    "  To get out, a repo admin either turns the ruleset off (Settings → Rules → Rulesets) until someone has enrolled (the nod check is neutral again meanwhile), or turns it off just to merge a PR that enrols a key (nod serve opens one: Signing on its setup page) and back on.",
  );
}

/**
 * After the ruleset: an open PR whose latest `nod` check concluded `neutral`
 * (the check was not required yet, ADR 0006) would pass the new required
 * check until the verifier runs again. For each such PR into the default
 * branch, re-run the verifier's last `pull_request_target` run on its head;
 * it then sees the ruleset and concludes `success` or `failure`. The PRs it
 * cannot re-run are named, with what does it by hand.
 */
async function rerunNeutralChecks(
  runner: Runner,
  api: (...args: string[]) => string[],
  repo: string,
  branch: string,
  log: (l: string) => void,
): Promise<void> {
  const byHand = "push to them, comment on them, or re-run their verify job";
  const open = await runner.run(
    api(
      `repos/${repo}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`,
      "--paginate",
      "--jq",
      ".[] | [.number, .head.sha] | @tsv",
    ),
  );
  if (open.status !== 0) {
    log(
      `note: could not list the open PRs. A PR whose nod check is still neutral passes the new requirement until the verifier runs again: ${byHand}.`,
    );
    return;
  }
  const rerun: number[] = [];
  const missed: number[] = [];
  for (const line of open.stdout.split("\n")) {
    const [n, sha] = line.trim().split("\t");
    if (!n || !/^\d+$/.test(n) || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const check = await runner.run(
      api(
        `repos/${repo}/commits/${sha}/check-runs?check_name=nod&filter=latest`,
        "--jq",
        '.check_runs | sort_by(.completed_at // "") | last | .conclusion // ""',
      ),
    );
    if (check.status === 0 && check.stdout.trim() !== "neutral") continue;
    const run = await runner.run(
      api(
        `repos/${repo}/actions/workflows/nod.yml/runs?event=pull_request_target&head_sha=${sha}&per_page=1`,
        "--jq",
        '.workflow_runs[0].id // ""',
      ),
    );
    const id = run.stdout.trim();
    if (check.status === 0 && run.status === 0 && /^\d+$/.test(id)) {
      const again = await runner.run(api("-X", "POST", `repos/${repo}/actions/runs/${id}/rerun`));
      if (again.status === 0) {
        rerun.push(Number(n));
        continue;
      }
    }
    missed.push(Number(n));
  }
  const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");
  if (rerun.length)
    log(
      `re-ran the verifier on ${list(rerun)}: their nod check was neutral, which would pass the new requirement.`,
    );
  if (missed.length)
    log(
      `note: could not re-run the verifier on ${list(missed)}; their nod check may still be neutral and pass the new requirement until it runs again: ${byHand}.`,
    );
}

/**
 * The GitHub host `nod init` works on: `--host`, else the host of the
 * clone's origin, else github.com (no clone, or a remote that is a path).
 */
async function resolveHost(
  runner: Runner,
  dir: string | undefined,
  flag: string | null,
): Promise<GitHubHost> {
  if (flag) return githubHost(flag);
  if (dir) {
    const r = await runner.run(["git", "-C", dir, "remote", "get-url", "origin"]);
    const remote = r.status === 0 ? parseRemote(r.stdout.trim()) : null;
    if (remote?.alias)
      throw new Error(
        `origin points at the ssh host "${remote.host}", which looks like an alias from your ssh config, and nod cannot resolve it. Pass --host with the real host: github.com, <name>.ghe.com or your GitHub Enterprise Server.`,
      );
    if (remote) return githubHost(remote.host);
  }
  return githubHost(GITHUB_COM);
}

/** `gh api <args> --hostname <host>`. */
function ghApi(host: GitHubHost, args: readonly string[]): string[] {
  return ["gh", "api", ...args, "--hostname", host.name];
}

/** The repo as `gh --repo` takes it: `HOST/OWNER/REPO` off github.com. */
function ghRepo(host: GitHubHost, repo: string): string {
  return host.kind === "github.com" ? repo : `${host.name}/${repo}`;
}

async function repoInfo(
  runner: Runner,
  host: GitHubHost,
  cwd: string | undefined,
  repo: string | null,
): Promise<RepoInfo> {
  const out = await must(
    runner,
    [
      "gh",
      "repo",
      "view",
      ...(repo ? [ghRepo(host, repo)] : []),
      "--json",
      "nameWithOwner,defaultBranchRef,isPrivate",
    ],
    { cwd },
  );
  const v = JSON.parse(out) as {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    isPrivate: boolean;
  };
  if (!v.defaultBranchRef?.name) throw new Error(`${v.nameWithOwner} has no default branch yet`);
  return { repo: v.nameWithOwner, defaultBranch: v.defaultBranchRef.name, isPrivate: v.isPrivate };
}

async function resolveSigners(
  runner: Runner,
  host: GitHubHost,
  cwd: string,
  flags: InitFlags,
): Promise<Signer[]> {
  const signers = flags.signers.map((s) => parseSigner(s));
  if (flags.signerKeys.length) {
    const login = await must(runner, ghApi(host, ["user", "--jq", ".login"]), { cwd });
    for (const path of flags.signerKeys)
      signers.push(parseSigner(await readFile(resolve(cwd, path), "utf8"), login));
  }
  return signers;
}

async function kitSpecFor(runner: Runner, deps: InitDeps): Promise<string> {
  if (isRelease(deps.version)) return defaultKitSpec(deps.version, null);
  // A checkout: pin the commit this CLI runs from.
  const cliDir = deps.cliDir ?? dirname(import.meta.dir);
  const r = await runner.run(["git", "-C", cliDir, "rev-parse", "HEAD"]);
  const head = r.status === 0 ? r.stdout.trim() : null;
  const spec = defaultKitSpec(deps.version, head);
  const pushed = await runner.run(["git", "-C", cliDir, "branch", "-r", "--contains", "HEAD"]);
  if (pushed.status !== 0 || !pushed.stdout.trim()) {
    (deps.log ?? console.log)(
      `warning: the kit is pinned to ${head}, which no remote branch contains yet. Push it first, or pass --kit.`,
    );
  }
  return spec;
}

/** Refuses when `.nod/` exists in the working tree or on `base`, unless forced. */
async function refuseExisting(
  runner: Runner,
  root: string,
  base: string | null,
  force: boolean,
): Promise<void> {
  if (force) return;
  const inTree = existsSync(join(root, ".nod"));
  const onBase =
    base !== null &&
    (await runner.run(["git", "-C", root, "cat-file", "-e", `${base}:.nod`])).status === 0;
  if (inTree || onBase) {
    throw new Error(
      `.nod/ exists already${onBase ? ` on ${base}` : ""}: nod is set up here. Pass --force to replace it.`,
    );
  }
}

async function writeSetup(root: string, files: readonly SetupFile[]): Promise<void> {
  for (const f of files) {
    const full = join(root, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
  }
}

async function switchBack(runner: Runner, root: string, previous: string): Promise<void> {
  if (previous && previous !== "HEAD" && previous !== SETUP_BRANCH)
    await runner.run(["git", "-C", root, "switch", "--quiet", previous]);
}

function commitMessage(kitSpec: string): string {
  return `${SETUP_PR_TITLE}\n\nAdds the repo-owned policy, verifier and trust root under .nod/ and the\nworkflow that runs the verifier. The kit is pinned to ${kitSpec}.\n`;
}
