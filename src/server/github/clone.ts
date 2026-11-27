/**
 * The local clone `nod serve` runs in, and the patch-ids it computes there
 * (ADR 0001 rule 6: the signer computes the patch-id locally, never from the
 * API's diff).
 *
 * The clone is only a store of git objects for us: the PR's base tip and
 * head are fetched into it by id (`refs/nod/base`, the kit's
 * `fetchPullRequestObjects`), nothing is checked out, and the working tree
 * and the user's branches are never touched.
 *
 * The GitHub host comes from the clone's remote, once (`--host` overrides
 * it); every URL `nod serve` uses derives from it (`kit/host.ts`).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { run } from "../../kit/exec.ts";
import { githubHost, parseRemote, type GitHubHost } from "../../kit/host.ts";
import { gitInboxIO } from "../../kit/inbox/git-io.ts";
import type { InboxIO } from "../../kit/inbox/types.ts";
import {
  changedFiles,
  fetchPullRequestObjects,
  git,
  gitEnv,
  patchId,
  tokenGitEnv,
  type ChangedFile,
} from "../../kit/patch-id.ts";

export class CloneError extends Error {
  override name = "CloneError";
}

export interface Clone {
  /** The work tree's root. */
  readonly dir: string;
  /** `owner/name`, as the remote spells it. */
  readonly repo: string;
  /** The GitHub host, from the remote (or `--host`). */
  readonly host: GitHubHost;
  /** The remote's fetch URL, as it is: patch-id fetches go there. */
  readonly remoteUrl: string;
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
 * of its remotes must point at it), else its `origin`. The host is that
 * remote's, unless `host` overrides it (needed when the remote names an ssh
 * alias). Throws `CloneError` with a sentence for the user otherwise.
 */
export function resolveClone(dir: string, repo: string | null, host: string | null = null): Clone {
  const abs = resolve(dir);
  const top = gitSync(abs, ["rev-parse", "--show-toplevel"]);
  if (!top.ok)
    throw new CloneError(
      `${abs} is not a git clone. Run nod serve inside a clone of the repository, or pass --dir <clone>.`,
    );
  const remotes = gitSync(top.out, ["remote", "-v"])
    .out.split("\n")
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 3 && p[2] === "(fetch)")
    .map(([name, url]) => ({ name: name!, url: url!, remote: parseRemote(url!) }));
  let hit: (typeof remotes)[number];
  if (repo) {
    const found = remotes.find((r) => r.remote?.repo.toLowerCase() === repo.toLowerCase());
    if (!found)
      throw new CloneError(
        `${top.out} is not a clone of ${repo} (no remote points at it). nod serve computes patch-ids in a clone of the repository: pass --dir <a clone of ${repo}>.`,
      );
    hit = found;
  } else {
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin)
      throw new CloneError(`${top.out} has no remote named origin; pass --repo <owner/name>.`);
    hit = origin;
  }
  const remote = hit.remote;
  if (!remote)
    throw new CloneError(
      `${hit.name} of ${top.out} is not a GitHub repository; nod reads pull requests from github.com, GHE.com or GitHub Enterprise Server.`,
    );
  if (!host && remote.alias)
    throw new CloneError(
      `${hit.name} of ${top.out} points at the ssh host "${remote.host}", which looks like an alias from your ssh config, and nod cannot resolve it. Pass --host with the real host: github.com, <name>.ghe.com or your GitHub Enterprise Server.`,
    );
  let resolved: GitHubHost;
  try {
    resolved = githubHost(host ?? remote.host);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new CloneError(host ? `--host: ${why}` : `${hit.name} of ${top.out}: ${why}`);
  }
  return { dir: top.out, repo: remote.repo, host: resolved, remoteUrl: hit.url };
}

/** Computes a PR's patch-id. The seam the tests replace. */
export interface PatchIds {
  /** Fetches the base branch (as it is now) and the head into the clone, then diffs. */
  compute(input: { readonly base: string; readonly headSha: string }): Promise<string>;
  /**
   * My inbox's view of a PR whose patch-id this computed (ADR 0009): its
   * files from git and the I/O over the clone, at the base tip the patch-id
   * used. null when its objects are not fetched yet. The I/O runs here, in
   * `nod serve`, with the host's token for lazy blob fetches; the inbox
   * subprocess only asks for results.
   */
  inbox?(input: {
    readonly base: string;
    readonly headSha: string;
  }): Promise<{ readonly files: ChangedFile[]; readonly io: InboxIO } | null>;
}

/** The base tip a patch-id was computed against, by base and head; and the inbox I/O over it. */
class BaseTips {
  private readonly tips = new Map<string, string>();
  private readonly files = new Map<string, ChangedFile[]>();

  /** The SHA `refs/nod/base` points at now: it moves with the next fetch. */
  async remember(repoDir: string, base: string, headSha: string, env: Record<string, string>) {
    const sha = (
      await git(repoDir, ["rev-parse", "--verify", "refs/nod/base^{commit}"], { env })
    ).trim();
    this.tips.set(`${base}\u0000${headSha}`, sha);
    return sha;
  }

  async inbox(
    repoDir: string,
    input: { readonly base: string; readonly headSha: string },
    env: () => Record<string, string>,
  ): Promise<{ files: ChangedFile[]; io: InboxIO } | null> {
    const key = `${input.base}\u0000${input.headSha}`;
    const baseTip = this.tips.get(key);
    if (!baseTip) return null;
    let files = this.files.get(key);
    if (!files) {
      files = await changedFiles({ repoDir, baseTip, head: input.headSha, env: env() });
      this.files.set(key, files);
      if (this.files.size > 500) this.files.delete(this.files.keys().next().value!);
    }
    return { files, io: gitInboxIO({ repoDir, baseTip, head: input.headSha, env: env() }) };
  }
}

/**
 * Patch-ids from the clone: the base branch and the head fetched from the
 * remote as it is (by URL, so no remote-tracking ref moves), one at a time,
 * as the kit's single `refs/nod/base` asks. Over https the token rides in
 * an extra header scoped to the host's web URL, never in a URL, and git
 * sends it nowhere else; over ssh git uses the user's own ssh setup.
 */
export function clonePatchIds(
  clone: Clone,
  token: () => string | null,
  /** Where to fetch from (default the remote's URL; tests: a local bare repo). */
  remote = clone.remoteUrl,
): PatchIds {
  let queue: Promise<unknown> = Promise.resolve();
  const tips = new BaseTips();
  const env = (): Record<string, string> => {
    const t = token();
    return t ? tokenGitEnv(t, `${clone.host.webUrl}/`) : {};
  };
  return {
    compute({ base, headSha }) {
      const job = queue.then(async () => {
        const t = token();
        const baseTip = await fetchPullRequestObjects({
          repoDir: clone.dir,
          base,
          headSha,
          remote,
          serverUrl: `${clone.host.webUrl}/`,
          ...(t ? { token: t } : {}),
        });
        const id = await patchId({ repoDir: clone.dir, baseTip, head: headSha });
        await tips.remember(clone.dir, base, headSha, {});
        return id;
      });
      queue = job.catch(() => {});
      return job;
    },
    inbox: (input) => tips.inbox(clone.dir, input, env),
  };
}

// ---------------------------------------------------------------------------
// nod's own clones (ADR 0007, 3)

/**
 * Where nod keeps its clone of a repo: `<cache>/clones/<host>/<owner>/<repo>.git`
 * (`cache` is `$XDG_CACHE_HOME/nod`). Lowercase, as GitHub's names compare.
 */
export function ownClonePath(cache: string, host: string, name: string): string {
  const [owner, repo] = name.toLowerCase().split("/") as [string, string];
  return join(cache, "clones", host.toLowerCase(), owner, `${repo}.git`);
}

/** The https URL nod clones a repo from: on its host's web, as `gh repo clone` would. */
export function cloneUrl(host: GitHubHost, name: string): string {
  return `${host.webUrl}/${name}.git`;
}

export interface OwnCloneOptions {
  /** The repo's bare clone: {@link ownClonePath}. */
  readonly dir: string;
  readonly host: GitHubHost;
  /** `owner/name`. */
  readonly name: string;
  /** The host's token, for a private repo; read at each use, never stored in the clone. */
  readonly token: () => string | null;
  /** Where to clone and fetch from (default {@link cloneUrl}; tests: a local repo's `file://` URL). */
  readonly url?: string;
}

/**
 * A repo's clone that nod owns: blobless and bare (`git clone --bare
 * --filter=blob:none`), made on first use and then only fetched into. A
 * cache: a deleted folder is cloned again. The token rides in an extra
 * header for the host's web URL only (`tokenGitEnv`), for the clone, every
 * fetch and the blobs a diff fetches on demand; it is never written into the
 * clone's config. Calls run one at a time.
 */
export class OwnClone {
  readonly dir: string;
  readonly url: string;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OwnCloneOptions) {
    this.dir = options.dir;
    this.url = options.url ?? cloneUrl(options.host, options.name);
  }

  /** The host's token now; null without one. */
  token(): string | null {
    return this.options.token();
  }

  /** git's environment with the token for this host (none without one). */
  env(): Record<string, string> {
    const token = this.token();
    return token ? tokenGitEnv(token, `${this.options.host.webUrl}/`) : {};
  }

  /** Whether the clone is on disk. */
  exists(): boolean {
    return existsSync(join(this.dir, "HEAD")) && existsSync(join(this.dir, "objects"));
  }

  /**
   * Clones when the folder has no clone yet. The clone goes to a temporary
   * folder next to it first and is renamed into place, so a failed clone
   * leaves nothing behind that looks like one.
   */
  ensure(): Promise<void> {
    if (this.exists()) return Promise.resolve();
    this.ready ??= this.clone().finally(() => (this.ready = null));
    return this.ready;
  }

  private async clone(): Promise<void> {
    const parent = dirname(this.dir);
    await mkdir(parent, { recursive: true });
    const tmp = await mkdtemp(join(parent, ".cloning-"));
    try {
      const r = await run(
        "git",
        ["clone", "--bare", "--filter=blob:none", "--no-tags", "--quiet", "--", this.url, tmp],
        { env: gitEnv(this.env()), timeoutMs: 600_000 },
      );
      if (r.status !== 0)
        throw new CloneError(
          `cloning ${this.options.name} from ${this.options.host.name} failed: ${r.stderr.trim().slice(0, 300)}`,
        );
      // A remote-tracking branch per branch, as a normal clone has: `nod init`
      // (the setup PR, in a worktree of this clone) starts from origin/<default>.
      const c = await run(
        "git",
        ["-C", tmp, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        { env: gitEnv() },
      );
      if (c.status !== 0) throw new CloneError(`configuring the clone failed: ${c.stderr.trim()}`);
      if (this.exists()) return; // another nod got there first
      await rename(tmp, this.dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Runs `job` after the clone exists and after every earlier job. */
  serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ensure();
      return job();
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * Patch-ids in nod's own clone: cloned on the first one, then the base
 * branch and the head fetched by id, as in a clone of the user's
 * ({@link clonePatchIds}); the diff's blobs come on demand, with the token.
 */
export function ownClonePatchIds(clone: OwnClone, host: GitHubHost): PatchIds {
  const tips = new BaseTips();
  return {
    compute: ({ base, headSha }) =>
      clone.serial(async () => {
        const token = clone.token();
        // From `origin` by name, so the clone's blob filter applies to the fetch too.
        const baseTip = await fetchPullRequestObjects({
          repoDir: clone.dir,
          base,
          headSha,
          remote: "origin",
          serverUrl: `${host.webUrl}/`,
          ...(token ? { token } : {}),
        });
        const id = await patchId({ repoDir: clone.dir, baseTip, head: headSha, env: clone.env() });
        await tips.remember(clone.dir, base, headSha, {});
        return id;
      }),
    // Blobs a diff or a read needs come on demand, with the token, in this process.
    inbox: (input) => tips.inbox(clone.dir, input, () => clone.env()),
  };
}
