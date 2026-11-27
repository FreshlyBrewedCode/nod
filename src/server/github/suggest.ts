/**
 * Adding a repo (ADR 0007, 2): GitHub's spelling of the one a person named
 * (what they may type is `parseRepoInput` in `src/shared/repo-key.ts`), and
 * the repos nod suggests, where I have open PRs or review requests (one
 * search query per host I am logged in to).
 */

import { ghLoginCommand, type GitHubHost } from "../../kit/host.ts";
import type { GitHubInfo, RepoSuggestion } from "../../shared/protocol";
import type { RepoKey } from "../../shared/repo-key";
import { SourceError } from "../source";
import { GitHubApiError, type GitHubApi } from "./api";

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
    nodes { ... on PullRequest { repository { nameWithOwner } } }
  }
  asked: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { repository { nameWithOwner } } }
  }
}`;

interface SuggestData {
  readonly mine?: { readonly nodes: ReadonlyArray<SearchHit | null> } | null;
  readonly asked?: { readonly nodes: ReadonlyArray<SearchHit | null> } | null;
}

interface SearchHit {
  readonly repository?: { readonly nameWithOwner: string } | null;
}

/** The suggestions of one host, without the repos `skip` names. */
export async function suggestOnHost(
  api: GitHubApi,
  skip: (key: RepoKey) => boolean,
  key: (name: string) => RepoKey,
): Promise<RepoSuggestion[]> {
  const data = await api.graphql<SuggestData>(SUGGEST);
  const by = new Map<string, { name: string; mine: number; asked: number }>();
  const count = (hits: SuggestData["mine"], field: "mine" | "asked") => {
    for (const hit of hits?.nodes ?? []) {
      const name = hit?.repository?.nameWithOwner;
      if (!name) continue;
      const k = name.toLowerCase();
      const row = by.get(k) ?? { name, mine: 0, asked: 0 };
      row[field]++;
      by.set(k, row);
    }
  };
  count(data.mine, "mine");
  count(data.asked, "asked");
  const github: GitHubInfo = { host: api.host.name, webUrl: api.host.webUrl };
  return [...by.values()]
    .map((r) => ({
      key: key(r.name),
      name: r.name,
      github,
      myOpenPrs: r.mine,
      reviewRequests: r.asked,
    }))
    .filter((s) => !skip(s.key));
}

/** Most relevant first: review requests (someone waits on me), then my own PRs, then the name. */
export function rankSuggestions(list: ReadonlyArray<RepoSuggestion>): RepoSuggestion[] {
  return [...list].sort(
    (a, b) =>
      b.reviewRequests - a.reviewRequests ||
      b.myOpenPrs - a.myOpenPrs ||
      a.key.localeCompare(b.key),
  );
}
