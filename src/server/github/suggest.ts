/**
 * Adding a repo (ADR 0007, 2): what a person may type for one, and the
 * repos nod suggests, where I have open PRs or review requests (one search
 * query per host I am logged in to).
 */

import {
  GITHUB_COM,
  ghLoginCommand,
  githubHost,
  parseRemote,
  type GitHubHost,
} from "../../kit/host.ts";
import type { GitHubInfo } from "../../shared/protocol";
import type { RepoKey } from "../../shared/repo-key";
import { SourceError } from "../source";
import { GitHubApiError, type GitHubApi } from "./api";

/**
 * A repo worth adding. Mirrors the protocol's `RepoSuggestion` (#49 adds it
 * to `src/shared/protocol.ts`); the two are to be unified into that one.
 */
export interface RepoSuggestion {
  readonly key: RepoKey;
  /** `owner/name`. */
  readonly name: string;
  readonly github: GitHubInfo;
  /** My open PRs there. */
  readonly myOpenPrs: number;
  /** Open PRs there that ask me (or a team of mine) for a review. */
  readonly reviewRequests: number;
}

const OWNER = "[A-Za-z0-9][A-Za-z0-9_-]{0,38}";
const NAME = "[A-Za-z0-9._-]{1,100}";
const OWNER_NAME = new RegExp(`^(${OWNER})/(${NAME})$`);

/**
 * The host and `owner/name` in what someone typed: `owner/name` (github.com),
 * `host/owner/name`, a web URL of the repo or of anything in it
 * (`https://acme.ghe.com/finance/ledger/pull/12`), or a git remote URL. null
 * when it is none of these. The host is validated (`githubHost`); whether
 * the repo exists is GitHub's to say.
 */
export function parseRepoInput(input: string): { host: string; name: string } | null {
  const s = input.trim().replace(/\.git$/, "");
  const valid = (host: string, owner: string, name: string) => {
    if (name === "." || name === ".." || !OWNER_NAME.test(`${owner}/${name}`)) return null;
    try {
      return { host: githubHost(host).name, name: `${owner}/${name}` };
    } catch {
      return null;
    }
  };
  const url = /^https?:\/\/([^/@]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i.exec(s);
  if (url) return valid(url[1]!, url[2]!, url[3]!.replace(/\.git$/, ""));
  if (s.includes(":")) {
    // A git remote: `git@host:owner/name`, `ssh://git@host/owner/name`.
    const remote = parseRemote(s);
    if (!remote || remote.alias) return null;
    const [owner, name] = remote.repo.split("/") as [string, string];
    return valid(remote.host, owner, name);
  }
  const parts = s.split("/");
  if (parts.length === 2) return valid(GITHUB_COM, parts[0]!, parts[1]!);
  if (parts.length === 3 && parts[0]!.includes(".")) return valid(parts[0]!, parts[1]!, parts[2]!);
  return null;
}

/**
 * GitHub's spelling of `owner/name` on `host`, which must exist and be
 * readable with this host's token. Throws `SourceError`.
 */
export async function resolveRepo(
  api: GitHubApi | null,
  host: GitHubHost,
  name: string,
): Promise<string> {
  if (!api)
    throw new SourceError(
      "forbidden",
      `\`gh\` is not logged in to ${host.name}. Run \`${ghLoginCommand(host.name)}\`, then add ${name} again.`,
    );
  try {
    const r = await api.rest<{ full_name?: string }>("GET", `/repos/${name}`);
    return r.data?.full_name ?? name;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404)
      throw new SourceError(
        "not-found",
        `${name} was not found on ${host.name}, or this gh account cannot read it.`,
      );
    if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403))
      throw new SourceError("forbidden", `${host.name} refused to show ${name}: ${error.message}`);
    throw new SourceError(
      "github",
      `Looking up ${name} on ${host.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** My open PRs and the open PRs asking me for a review, on one host. */
export const SUGGEST = `
query Suggest {
  rateLimit { cost remaining limit resetAt }
  mine: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { repository { nameWithOwner viewerPermission pushedAt } } }
  }
  asked: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { repository { nameWithOwner viewerPermission pushedAt } } }
  }
}`;

interface SuggestData {
  readonly mine?: { readonly nodes: ReadonlyArray<SearchHit | null> } | null;
  readonly asked?: { readonly nodes: ReadonlyArray<SearchHit | null> } | null;
}

interface SearchHit {
  readonly repository?: {
    readonly nameWithOwner: string;
    readonly viewerPermission?: string | null;
    readonly pushedAt?: string | null;
  } | null;
}

/** A suggestion with what the first-run picker (`list-repos`) also shows. */
export interface HostSuggestion {
  readonly suggestion: RepoSuggestion;
  readonly canWrite: boolean;
  readonly pushedAt: number | null;
}

/** The suggestions of one host, without the repos `skip` names. */
export async function suggestOnHost(
  api: GitHubApi,
  skip: (key: RepoKey) => boolean,
  key: (name: string) => RepoKey,
): Promise<HostSuggestion[]> {
  const data = await api.graphql<SuggestData>(SUGGEST);
  const by = new Map<
    string,
    {
      name: string;
      mine: number;
      asked: number;
      permission: string | null;
      pushedAt: string | null;
    }
  >();
  const count = (hits: SuggestData["mine"], field: "mine" | "asked") => {
    for (const hit of hits?.nodes ?? []) {
      const repo = hit?.repository;
      if (!repo?.nameWithOwner) continue;
      const k = repo.nameWithOwner.toLowerCase();
      const row = by.get(k) ?? {
        name: repo.nameWithOwner,
        mine: 0,
        asked: 0,
        permission: repo.viewerPermission ?? null,
        pushedAt: repo.pushedAt ?? null,
      };
      row[field]++;
      by.set(k, row);
    }
  };
  count(data.mine, "mine");
  count(data.asked, "asked");
  const github: GitHubInfo = { host: api.host.name, webUrl: api.host.webUrl };
  return [...by.values()]
    .map((r) => ({
      suggestion: {
        key: key(r.name),
        name: r.name,
        github,
        myOpenPrs: r.mine,
        reviewRequests: r.asked,
      },
      canWrite: r.permission === "ADMIN" || r.permission === "MAINTAIN" || r.permission === "WRITE",
      pushedAt: r.pushedAt ? Date.parse(r.pushedAt) || null : null,
    }))
    .filter((s) => !skip(s.suggestion.key));
}

/** Most relevant first: review requests (someone waits on me), then my own PRs, then the name. */
export function rankSuggestions<T extends { readonly suggestion: RepoSuggestion }>(
  list: ReadonlyArray<T>,
): T[] {
  return [...list].sort(
    ({ suggestion: a }, { suggestion: b }) =>
      b.reviewRequests - a.reviewRequests ||
      b.myOpenPrs - a.myOpenPrs ||
      a.key.localeCompare(b.key),
  );
}
