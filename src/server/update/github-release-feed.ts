/**
 * The release feed over GitHub Releases: unauthenticated REST (no token
 * leaves the machine for this), `fetch` injectable.
 *
 * - The first page (100 releases, newest first) is fetched with
 *   `If-None-Match`: a `304` costs no rate limit and keeps what was parsed
 *   before. A channel switch is answered from the same cache.
 * - A release is picked by semver, not by order. When the stable channel finds
 *   no stable release on the page (a long run of pre-releases), it follows
 *   `rel="next"` links, at most {@link MAX_PAGES} pages in all; later pages
 *   are cached until page 1 changes.
 * - A rate limit surfaces as {@link FeedRateLimited} with the time GitHub
 *   gave (`retry-after`, else `x-ratelimit-reset`); any other failure as
 *   {@link FeedError}.
 */

import {
  FeedError,
  FeedRateLimited,
  parseReleases,
  selectRelease,
  type Channel,
  type ReleaseFeed,
  type ReleaseInfo,
} from "./release-feed";

export const NOD_REPOSITORY = "FreshlyBrewedCode/nod";
export const MAX_PAGES = 3;

export interface GitHubReleaseFeedOptions {
  readonly fetch?: typeof fetch;
  /** `owner/name`; default the nod repository. */
  readonly repository?: string;
  /** The REST API root; default `https://api.github.com`. */
  readonly apiUrl?: string;
  /** Epoch ms now; for `retry-after`. */
  readonly now?: () => number;
  /** Per request (default 15 s). */
  readonly timeoutMs?: number;
}

interface Cache {
  etag: string | null;
  releases: ReleaseInfo[];
  /** The next page's URL, when the repository has more releases than we read. */
  more: string | null;
  pages: number;
}

export class GitHubReleaseFeed implements ReleaseFeed {
  private readonly doFetch: typeof fetch;
  private readonly apiUrl: string;
  private readonly now: () => number;
  private cache: Cache | null = null;
  /** Requests sent, `304`s included. */
  requests = 0;

  constructor(private readonly options: GitHubReleaseFeedOptions = {}) {
    this.doFetch = options.fetch ?? fetch;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
  }

  async latest(channel: Channel): Promise<ReleaseInfo | null> {
    await this.refreshFirstPage();
    const cache = this.cache!;
    let found = selectRelease(cache.releases, channel);
    // Only stable can be hiding behind a long run of pre-releases.
    while (channel === "stable" && !found && cache.more && cache.pages < MAX_PAGES) {
      const page = await this.get(cache.more, null);
      if (page.status !== 200) throw new FeedError(page.status, `GitHub answered ${page.status}.`);
      cache.releases.push(...parseReleases(page.json));
      cache.more = this.nextLink(page.headers);
      cache.pages++;
      found = selectRelease(cache.releases, channel);
    }
    return found;
  }

  private async refreshFirstPage(): Promise<void> {
    const repo = this.options.repository ?? NOD_REPOSITORY;
    const url = `${this.apiUrl}/repos/${repo}/releases?per_page=100`;
    const res = await this.get(url, this.cache?.etag ?? null);
    if (res.status === 304 && this.cache) return;
    if (res.status !== 200) throw new FeedError(res.status, `GitHub answered ${res.status}.`);
    this.cache = {
      etag: res.headers.get("etag"),
      releases: parseReleases(res.json),
      more: this.nextLink(res.headers),
      pages: 1,
    };
  }

  /** The `rel="next"` URL, only when it stays on the API host. */
  private nextLink(headers: Headers): string | null {
    const link = headers.get("link");
    if (!link) return null;
    for (const part of link.split(",")) {
      const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
      if (!match) continue;
      try {
        return new URL(match[1]!).origin === new URL(this.apiUrl).origin ? match[1]! : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async get(
    url: string,
    etag: string | null,
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    this.requests++;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "nod-serve",
          ...(etag ? { "if-none-match": etag } : {}),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new FeedError(
        0,
        `GitHub did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 304) return { status: 304, headers: res.headers, json: null };
    if (!res.ok) {
      const limited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") ||
        (res.status === 403 && res.headers.has("retry-after"));
      if (limited) throw new FeedRateLimited(this.resetFrom(res.headers));
      throw new FeedError(res.status, `GitHub answered ${res.status}.`);
    }
    try {
      return { status: res.status, headers: res.headers, json: await res.json() };
    } catch {
      throw new FeedError(0, "GitHub sent something that is not JSON.");
    }
  }

  private resetFrom(headers: Headers): number | null {
    const after = Number(headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return this.now() + after * 1000;
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return reset * 1000;
    return null;
  }
}
