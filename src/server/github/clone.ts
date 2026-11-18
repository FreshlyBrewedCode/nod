/**
 * The local clone `nod serve` runs in, and the patch-ids it computes there
 * (ADR 0001 rule 6: the signer computes the patch-id locally, never from the
 * API's diff).
 *
 * The clone is only a store of git objects for us: the PR's base tip and
 * head are fetched into it by id (`refs/nod/base`, the kit's
 * `fetchPullRequestObjects`), nothing is checked out, and the working tree
 * and the user's branches are never touched.
 */

import { resolve } from "node:path";

import { fetchPullRequestObjects, gitEnv, patchId } from "../../kit/patch-id.ts";

export class CloneError extends Error {
  override name = "CloneError";
}

export interface Clone {
  /** The work tree's root. */
  readonly dir: string;
  /** `owner/name`, as the remote spells it. */
  readonly repo: string;
}

/** `owner/name` of a GitHub remote URL (https, ssh, git), else null. */
export function githubRepoOf(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:|git:\/\/github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

function gitSync(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

/**
 * The clone in `dir` and the repo it is a clone of: `repo` when given (one
 * of its remotes must point at it), else its `origin`. Throws `CloneError`
 * with a sentence for the user otherwise.
 */
export function resolveClone(dir: string, repo: string | null): Clone {
  const abs = resolve(dir);
  const top = gitSync(abs, ["rev-parse", "--show-toplevel"]);
  if (!top.ok)
    throw new CloneError(
      `${abs} is not a git clone. Run nod serve inside a clone of the repository, or pass --dir <clone>.`,
    );
  const remotes = gitSync(top.out, ["remote", "-v"])
    .out.split("\n")
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 2)
    .map(([name, url]) => ({ name: name!, repo: githubRepoOf(url!) }));
  if (repo) {
    const hit = remotes.find((r) => r.repo && r.repo.toLowerCase() === repo.toLowerCase());
    if (!hit)
      throw new CloneError(
        `${top.out} is not a clone of ${repo} (no remote points at it). nod serve computes patch-ids in a clone of the repository: pass --dir <a clone of ${repo}>.`,
      );
    return { dir: top.out, repo: hit.repo! };
  }
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin)
    throw new CloneError(`${top.out} has no remote named origin; pass --repo <owner/name>.`);
  if (!origin.repo)
    throw new CloneError(
      `origin of ${top.out} is not a GitHub repository; nod reads pull requests from github.com.`,
    );
  return { dir: top.out, repo: origin.repo };
}

/** Computes a PR's patch-id. The seam the tests replace. */
export interface PatchIds {
  /** Fetches the base branch (as it is now) and the head into the clone, then diffs. */
  compute(input: { readonly base: string; readonly headSha: string }): Promise<string>;
}

/**
 * Patch-ids from the clone: the base branch and the head fetched from
 * GitHub (https, with the token in an extra header, never in a URL), one at
 * a time, as the kit's single `refs/nod/base` asks.
 */
export function clonePatchIds(
  clone: Clone,
  token: () => string | null,
  /** Where to fetch from (tests: a local bare repo). */
  remote = `https://github.com/${clone.repo}.git`,
): PatchIds {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    compute({ base, headSha }) {
      const job = queue.then(async () => {
        const t = token();
        const baseTip = await fetchPullRequestObjects({
          repoDir: clone.dir,
          base,
          headSha,
          remote,
          ...(t ? { token: t } : {}),
        });
        return patchId({ repoDir: clone.dir, baseTip, head: headSha });
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}
