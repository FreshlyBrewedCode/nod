/**
 * A release feed in memory, for tests and `nod serve --fake`: releases with
 * notes written the way semantic-release writes them (a compare-link heading,
 * `###` sections, bullet lists, issue and commit links, inline code). The
 * versions are fictional but ordered like the real ones, so a `0.2.0` user
 * sees an update on `next` and a downgrade offer when they switch to stable.
 */

import {
  FeedError,
  FeedRateLimited,
  selectRelease,
  type Channel,
  type ReleaseFeed,
  type ReleaseInfo,
} from "./release-feed";

const REPO = "https://github.com/FreshlyBrewedCode/nod";

/** Release notes as semantic-release writes them. */
function notes(
  version: string,
  previous: string,
  date: string,
  sections: Record<string, string[]>,
): string {
  const heading = version.includes("-") ? "#" : "##";
  const lines = [
    `${heading} [${version}](${REPO}/compare/v${previous}...v${version}) (${date})`,
    "",
  ];
  for (const [title, items] of Object.entries(sections)) {
    lines.push("", `### ${title}`, "");
    for (const item of items) lines.push(`* ${item}`);
  }
  return `${lines.join("\n")}\n`;
}

const sha = (n: number) => `${n.toString(16).padStart(7, "a")}`;

/** Newest first, as GitHub lists them. */
export const FAKE_RELEASES: readonly ReleaseInfo[] = [
  {
    version: "0.4.0-next.2",
    publishedAt: "2026-11-27T09:12:44Z",
    prerelease: true,
    url: `${REPO}/releases/tag/v0.4.0-next.2`,
    notes: notes("0.4.0-next.2", "0.4.0-next.1", "2026-11-27", {
      "Bug Fixes": [
        `the batch dialog keeps the passphrase field focused after a wrong passphrase ([#81](${REPO}/issues/81)) ([${sha(0x4b1c9de)}](${REPO}/commit/${sha(0x4b1c9de)}))`,
        `\`nod key test\` reports the key file it read ([${sha(0x77a20f3)}](${REPO}/commit/${sha(0x77a20f3)}))`,
      ],
    }),
  },
  {
    version: "0.4.0-next.1",
    publishedAt: "2026-11-26T17:40:03Z",
    prerelease: true,
    url: `${REPO}/releases/tag/v0.4.0-next.1`,
    notes: notes("0.4.0-next.1", "0.3.0", "2026-11-26", {
      Features: [
        `the board groups by **Waiting on** or **State**, and remembers the choice ([#74](${REPO}/issues/74)) ([${sha(0x2c8e1b5)}](${REPO}/commit/${sha(0x2c8e1b5)}))`,
        `rows show who has the next move, with a link to the PR ([#78](${REPO}/issues/78)) ([${sha(0x9d03f17)}](${REPO}/commit/${sha(0x9d03f17)}))`,
      ],
      "Performance Improvements": [
        `poll only the PRs that changed, with \`ETag\` revalidation ([${sha(0x5e6a4c8)}](${REPO}/commit/${sha(0x5e6a4c8)}))`,
      ],
    }),
  },
  {
    version: "0.3.0",
    publishedAt: "2026-11-25T08:00:19Z",
    prerelease: false,
    url: `${REPO}/releases/tag/v0.3.0`,
    notes: notes("0.3.0", "0.2.0", "2026-11-25", {
      Features: [
        `the inbox: local classification and "needs me" without a policy ([#70](${REPO}/issues/70)) ([${sha(0x645a1bb)}](${REPO}/commit/${sha(0x645a1bb)}))`,
        `GitHub approvals count, and the \`nod\` check stays neutral until enforced ([#66](${REPO}/issues/66)) ([${sha(0x79c3070)}](${REPO}/commit/${sha(0x79c3070)}))`,
      ],
      "Bug Fixes": [
        `the verifier also runs on reviews, so an approval counts at once ([${sha(0x028d81c)}](${REPO}/commit/${sha(0x028d81c)}))`,
      ],
    }),
  },
  {
    version: "0.2.0",
    publishedAt: "2026-11-20T10:30:00Z",
    prerelease: false,
    url: `${REPO}/releases/tag/v0.2.0`,
    notes: notes("0.2.0", "0.1.1", "2026-11-20", {
      Features: [
        `links from GitHub reach the phone's nod, and nod installs as a home-screen app ([#37](${REPO}/issues/37)) ([${sha(0x4356dc3)}](${REPO}/commit/${sha(0x4356dc3)}))`,
        `\`nod serve --allow-host\` serves the web app on a named host behind a TLS proxy ([#33](${REPO}/issues/33)) ([${sha(0x1a559b0)}](${REPO}/commit/${sha(0x1a559b0)}))`,
      ],
    }),
  },
  {
    version: "0.1.1",
    publishedAt: "2026-11-12T14:05:51Z",
    prerelease: false,
    url: `${REPO}/releases/tag/v0.1.1`,
    notes: notes("0.1.1", "0.1.0", "2026-11-12", {
      "Bug Fixes": [
        `\`nod init\` runs every \`gh\` call with \`--hostname\` ([${sha(0x147564c)}](${REPO}/commit/${sha(0x147564c)}))`,
      ],
    }),
  },
];

export interface FakeReleaseFeedOptions {
  readonly releases?: readonly ReleaseInfo[];
}

export class FakeReleaseFeed implements ReleaseFeed {
  releases: ReleaseInfo[];
  /** Channels asked for, in order. */
  readonly calls: Channel[] = [];
  /** When set, the next calls reject with this (until cleared). */
  failure: FeedError | null = null;

  constructor(options: FakeReleaseFeedOptions = {}) {
    this.releases = [...(options.releases ?? FAKE_RELEASES)];
  }

  async latest(channel: Channel): Promise<ReleaseInfo | null> {
    this.calls.push(channel);
    if (this.failure) throw this.failure;
    return selectRelease(this.releases, channel);
  }

  /** A new release appears (a demo of "an update arrived"). */
  publish(release: ReleaseInfo): void {
    this.releases = [release, ...this.releases];
  }

  /** The feed fails until `recover()`: a plain error, or a rate limit when `until` is given. */
  fail(until?: number): void {
    this.failure =
      until === undefined
        ? new FeedError(0, "GitHub did not answer: fake outage.")
        : new FeedRateLimited(until);
  }

  recover(): void {
    this.failure = null;
  }
}
