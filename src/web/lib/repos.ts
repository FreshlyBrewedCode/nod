/**
 * The repos `nod serve` reads (ADR 0007), as the web app needs them: a PR's
 * repo by its key, the repo chip's words, and my key's enrolment where one
 * answer stands for all repos (the lock chip, the board's "You" column).
 *
 * With one repo the dashboard looks as it always did: no chip, the repo's
 * name in the top bar. `chipsOf` is empty then.
 */

import { GITHUB_COM, githubHost } from "../../kit/host.ts";
import type { Enrolment, GitHubInfo, RepoInfo, RepoKey } from "../../shared/protocol";
import { chipLabels, sameRepo } from "../../shared/repo-key";

export type Repos = ReadonlyArray<RepoInfo>;

/** The repo of a key, as the server listed it. */
export function repoOf(repos: Repos, key: RepoKey | null | undefined): RepoInfo | null {
  return repos.find((r) => sameRepo(r.key, key)) ?? null;
}

/** github.com, for a key the list does not hold (a PR whose repo the server dropped). */
const GITHUB_DOT_COM: GitHubInfo = { host: GITHUB_COM, webUrl: githubHost(GITHUB_COM).webUrl };

/** The GitHub host a repo is on. */
export function githubOfRepo(repos: Repos, key: RepoKey | null | undefined): GitHubInfo {
  return repoOf(repos, key)?.github ?? GITHUB_DOT_COM;
}

/** The repo chip's words per repo, once there is more than one; empty with one. */
export function chipsOf(repos: Repos): ReadonlyMap<RepoKey, string> {
  return repos.length > 1 ? chipLabels(repos.map((r) => r.key)) : new Map();
}

/**
 * The remembered repo filter (`STORAGE_KEYS.repoFilter`): the repo it names,
 * as the list spells its key; null (all repos) for a repo the list no longer
 * has, with one repo (no filter is offered), or for anything else.
 */
export function readRepoFilter(value: unknown, repos: Repos): RepoKey | null {
  if (typeof value !== "string" || repos.length < 2) return null;
  return repoOf(repos, value)?.key ?? null;
}

/** My key's enrolment in a repo; null without a key (or a repo it does not know). */
export function enrolmentIn(repos: Repos, key: RepoKey | null | undefined): Enrolment | null {
  return repoOf(repos, key)?.enrolment ?? null;
}

const RANK: Readonly<Record<Enrolment["state"], number>> = {
  active: 0,
  pending: 1,
  "not-enrolled": 2,
};

/**
 * One enrolment for all repos, for what is the key's and not a repo's (the
 * lock chip, the board's "You" column): active when it signs somewhere,
 * else pending when it waits somewhere, else not enrolled. With one repo
 * it is that repo's. null without a key.
 */
export function bestEnrolment(repos: Repos): Enrolment | null {
  let best: Enrolment | null = null;
  for (const r of repos)
    if (r.enrolment && (!best || RANK[r.enrolment.state] < RANK[best.state])) best = r.enrolment;
  return best;
}

/** The worst enrolment among some repos: what a batch of nods across them can rely on. */
export function worstEnrolment(repos: Repos, keys: ReadonlyArray<RepoKey>): Enrolment | null {
  let worst: Enrolment | null = null;
  for (const key of keys) {
    const e = enrolmentIn(repos, key);
    if (!e) return null;
    if (!worst || RANK[e.state] > RANK[worst.state]) worst = e;
  }
  return worst;
}
