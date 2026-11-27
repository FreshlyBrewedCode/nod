/**
 * The release feed seam: what `nod serve` asks to learn which version a
 * channel wants. The GitHub implementation lives in `github-release-feed.ts`,
 * a fake with believable release notes in `fake-release-feed.ts`.
 *
 * - **stable**: the newest release that is not a pre-release (`X.Y.Z`, npm
 *   dist-tag `latest`).
 * - **next**: the newest release of any kind (`X.Y.Z-next.N` included, npm
 *   dist-tag `next`), so a stable release newer than the last pre-release is
 *   what `next` wants, too.
 *
 * Everything here is plain JSON, because it will go over the wire later.
 */

import { compareSemver, normalizeVersion, parseSemver } from "./semver";

export type Channel = "stable" | "next";

export const CHANNELS: readonly Channel[] = ["stable", "next"];

export function isChannel(value: unknown): value is Channel {
  return value === "stable" || value === "next";
}

/** One release, as the settings page shows it. */
export interface ReleaseInfo {
  /** Semver without a leading `v`: `0.2.0-next.6`. */
  readonly version: string;
  /** ISO 8601. */
  readonly publishedAt: string;
  /** The release notes as semantic-release wrote them (markdown; the UI renders a limited subset). */
  readonly notes: string;
  /** The release's page on GitHub. */
  readonly url: string;
  readonly prerelease: boolean;
}

/** Looks up the release a channel wants. Rejects with {@link FeedError} or {@link FeedRateLimited}. */
export interface ReleaseFeed {
  /** The newest release of the channel, or null when the repository has none (yet). */
  latest(channel: Channel): Promise<ReleaseInfo | null>;
}

/** The feed could not answer. `status` 0: no answer at all (network, timeout, bad JSON). */
export class FeedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

/** GitHub asked us to come back later (`retry-after`, `x-ratelimit-reset`). */
export class FeedRateLimited extends FeedError {
  constructor(
    /** Epoch ms; null when GitHub did not say. */
    readonly until: number | null,
    message = "GitHub is rate-limiting the update check.",
  ) {
    super(429, message);
    this.name = "FeedRateLimited";
  }
}

/** The newest release `channel` wants, by semver (not by publication order). */
export function selectRelease(
  releases: readonly ReleaseInfo[],
  channel: Channel,
): ReleaseInfo | null {
  let best: ReleaseInfo | null = null;
  for (const release of releases) {
    if (channel === "stable" && release.prerelease) continue;
    if (!best || compareSemver(release.version, best.version) > 0) best = release;
  }
  return best;
}

/** Release notes get cut here; GitHub allows 125 000 characters and the settings page needs none of that. */
export const MAX_NOTES = 20_000;

/**
 * Releases from GitHub's `GET /repos/{owner}/{repo}/releases` answer. Drafts
 * and entries whose tag is not semver are dropped; anything else odd (a null
 * body, a missing date) is tolerated.
 */
export function parseReleases(json: unknown): ReleaseInfo[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseInfo[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.draft === true || typeof r.tag_name !== "string") continue;
    const version = normalizeVersion(r.tag_name);
    if (!version) continue;
    const parsed = parseSemver(version)!;
    const date = [r.published_at, r.created_at].find((d): d is string => typeof d === "string");
    out.push({
      version,
      publishedAt: date ?? new Date(0).toISOString(),
      notes: typeof r.body === "string" ? r.body.slice(0, MAX_NOTES) : "",
      url: typeof r.html_url === "string" ? r.html_url : "",
      // The version decides, not the flag: `X.Y.Z-next.N` is a next build either way.
      prerelease: r.prerelease === true || parsed.pre.length > 0,
    });
  }
  return out;
}
