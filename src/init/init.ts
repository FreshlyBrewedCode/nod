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

import type { InitFlags } from "./args.ts";
import { SETUP_BRANCH, SETUP_PR_TITLE, setupPrBody } from "./pr-body.ts";
import {
  GITHUB_ACTIONS_APP_ID,
  isPlanRefusal,
  nodRuleset,
  PLAN_REFUSAL,
  RULESET_NAME,
} from "./ruleset.ts";
import { must, processRunner, type Runner } from "./runner.ts";
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
  const runner = deps.runner ?? processRunner;
  const dir = resolve(deps.cwd ?? process.cwd(), flags.dir ?? ".");
  const root = await must(runner, ["git", "-C", dir, "rev-parse", "--show-toplevel"]);
  const info = await repoInfo(runner, root, flags.repo);

  const signers = await resolveSigners(runner, root, flags);
  if (signers.length === 0 && !flags.dryRun) {
    throw new Error(
      'nod needs at least one signer\'s public key: --signer "<login> ssh-ed25519 AAAA…" or --signer-key <file.pub>. Without one, nothing can ever be nodded.',
    );
  }
  const kitSpec = flags.kit ?? (await kitSpecFor(runner, deps));
  const files = renderSetup(await loadTemplates(deps.templatesDir ?? TEMPLATES_DIR), {
    kitSpec,
    signers,
  });
  const body = setupPrBody({ ...info, signers, kitSpec });

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
    if (signers.length === 0)
      log("  (it refuses to without a signer: pass --signer or --signer-key)");
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
    log(`  gh pr create --repo ${info.repo} --base ${info.defaultBranch} --head ${SETUP_BRANCH}`);
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
        info.repo,
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
  log("It merges under this repository's current rules. After the merge, a repo admin runs:");
  log(`  nod init --ruleset --repo ${info.repo}`);
  return prUrl;
}

/**
 * `nod init --ruleset`: creates or updates the ruleset `nod` on the default
 * branch and enables auto-merge. Refuses while the verifier is not on the
 * default branch yet (requiring `nod` then blocks every merge).
 */
async function applyRuleset(
  flags: InitFlags,
  deps: InitDeps,
  log: (l: string) => void,
): Promise<number> {
  const runner = deps.runner ?? processRunner;
  const dir = resolve(deps.cwd ?? process.cwd(), flags.dir ?? ".");
  const info = await repoInfo(runner, existsSync(dir) ? dir : undefined, flags.repo);
  const { repo, defaultBranch } = info;

  const verifier = await runner.run([
    "gh",
    "api",
    `repos/${repo}/contents/.nod/verify.ts?ref=${encodeURIComponent(defaultBranch)}`,
    "--silent",
  ]);
  if (verifier.status !== 0 && !flags.force) {
    log(
      `nod init --ruleset: ${repo} has no .nod/verify.ts on ${defaultBranch} yet. Merge the setup PR first: requiring nod before the verifier runs would block every merge. (--force applies it anyway.)`,
    );
    return 1;
  }

  const appId = await runner.run(["gh", "api", "apps/github-actions", "--jq", ".id"]);
  const integrationId = Number(appId.stdout.trim()) || GITHUB_ACTIONS_APP_ID;
  const existing = await must(runner, [
    "gh",
    "api",
    `repos/${repo}/rulesets`,
    "--jq",
    `[.[] | select(.name == "${RULESET_NAME}") | .id] | first // ""`,
  ]).catch((e: Error) => {
    if (isPlanRefusal(e.message)) return "refused";
    throw e;
  });
  if (existing === "refused") {
    log(`nod init --ruleset: ${PLAN_REFUSAL}`);
    return 1;
  }
  const payload = JSON.stringify(nodRuleset(integrationId));
  const write = existing
    ? ["gh", "api", "-X", "PUT", `repos/${repo}/rulesets/${existing}`, "--input", "-"]
    : ["gh", "api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"];
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

  const merge = await runner.run([
    "gh",
    "api",
    "-X",
    "PATCH",
    `repos/${repo}`,
    "-F",
    "allow_auto_merge=true",
    "--jq",
    ".allow_auto_merge",
  ]);
  if (merge.status === 0 && merge.stdout.trim() === "true") log("auto-merge is enabled.");
  else
    log(
      "could not enable auto-merge (GitHub kept it off; on private repositories it needs a paid plan). Enable it under Settings → General → Pull Requests.",
    );

  const protection = await runner.run([
    "gh",
    "api",
    `repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection`,
    "--jq",
    ".required_pull_request_reviews.required_approving_review_count // 0",
  ]);
  if (protection.status === 0 && Number(protection.stdout.trim()) > 0) {
    log(
      `note: classic branch protection on ${defaultBranch} still requires ${protection.stdout.trim()} approval(s). Lower it to 0, or auto-merge keeps waiting for them.`,
    );
  }
  return 0;
}

async function repoInfo(
  runner: Runner,
  cwd: string | undefined,
  repo: string | null,
): Promise<RepoInfo> {
  const out = await must(
    runner,
    [
      "gh",
      "repo",
      "view",
      ...(repo ? [repo] : []),
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

async function resolveSigners(runner: Runner, cwd: string, flags: InitFlags): Promise<Signer[]> {
  const signers = flags.signers.map((s) => parseSigner(s));
  if (flags.signerKeys.length) {
    const login = await must(runner, ["gh", "api", "user", "--jq", ".login"], { cwd });
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
