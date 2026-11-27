/**
 * The personal layer's contracts (ADR 0009): attention marks, the context
 * classifiers and analyzers get, analyzers, the inbox, and the state of an
 * insight. Everything that crosses the process boundary is plain JSON.
 *
 * Pure: imports nothing from Node.
 */
import type { ClassifierContext, Risk } from "../classifiers/types.ts";
import type { Category } from "../policy.ts";
import type { Block, Insight } from "./blocks.ts";

/** How a personal classifier moves a PR: up a tier, down a tier, or into Background. */
export type AttentionValue = 1 | -1 | "mute";

/**
 * What an attention classifier says about a PR: the fixed vocabulary of the
 * personal layer. It never has a risk: the personal layer cannot change the
 * repo's risk or requirement.
 */
export interface AttentionMark {
  /** Which classifier said it; filled in from the classifier's name when left out. */
  classifier?: string;
  attention?: AttentionValue;
  /** A short word the row shows quietly, e.g. `auth`. */
  tag?: string;
  /** Worth knowing about. */
  fyi?: boolean;
  /** One sentence: why. */
  detail: string;
}

/** An attention classifier: `(ctx) => AttentionMark[]`, sync or async. The kit's `Classifier` shape. */
export type AttentionClassifier = ((
  ctx: InboxContext,
) => AttentionMark[] | Promise<AttentionMark[]>) & {
  /** Shown as the marks' `classifier`; set by {@link classifier} or taken from the function's name. */
  classifierName?: string;
  /** `default` for the kit's own, `yours` otherwise. */
  origin?: Origin;
};

/** A mark with its classifier's name filled in. */
export type NamedMark = AttentionMark & { classifier: string };

/** Where a classifier or analyzer comes from: the kit's defaults, or the user's `inbox.ts`. */
export type Origin = "default" | "yours";

/** The combined personal attention for one PR. Kept apart from the repo's risk and requirement. */
export interface PersonalAttention {
  /** `mute` if any mark mutes; else the marks' sum, clamped to one tier either way. */
  attention: -1 | 0 | 1 | "mute";
  /** Every mark's tag, once each, in order. */
  tags: string[];
  fyi: boolean;
  /** Every mark, with its classifier's name. */
  marks: NamedMark[];
  /** Classifiers that threw, as `name: message`. They changed nothing. */
  errors: string[];
}

/** One of my open pull requests, for {@link InboxContext.myWork}. */
export interface MyPullRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  /** The paths it changes. */
  files: string[];
}

/** What the repo layer said about this PR, for the personal layer to read (never to change). */
export interface RepoSummary {
  /** The repo's verifier, or `nod serve`'s built-in policy at the inbox step. */
  source: "verifier" | "local";
  risk: Risk;
  category: Category;
  /** The findings' tags. */
  tags: string[];
  fyi: boolean;
  /** Whether the requirement is met. */
  satisfied: boolean;
}

/**
 * The I/O behind an {@link InboxContext}: over a git clone ({@link gitInboxIO})
 * or a test double ({@link fakeInboxIO}). In nod's own blobless clones, reading
 * contents may fetch them from the host; see ADR 0009 decision 6.
 */
export interface InboxIO {
  /** Revisions for `git`: the base tip and the head, as the clone names them. */
  readonly revs: { readonly base: string; readonly head: string };
  /** A file at the base tip, or `null`. Trusted: the PR cannot change it. */
  readBaseFile(path: string): Promise<string | null>;
  /** A file at the PR head, or `null`. The PR's author wrote it: show it, never trust it. */
  readHeadFile(path: string): Promise<string | null>;
  /** The unified diff from the merge base to the head, optionally for some paths only. */
  diff(paths?: readonly string[]): Promise<string>;
  /** Read-only git in the clone (see {@link GIT_READ_ONLY}); returns stdout. */
  git(args: readonly string[]): Promise<string>;
}

/** Everything a personal classifier or analyzer gets: a repo classifier's context and more. */
export interface InboxContext extends ClassifierContext, InboxIO {
  /** My GitHub login. */
  me: string;
  /** My open pull requests (this one included, if it is mine) and their files. */
  myWork: readonly MyPullRequest[];
  /** The repo layer's result for this PR, or `null` when there is none yet. */
  repoSummary: RepoSummary | null;
}

/** What an analyzer's `run` may return: an insight, a block, blocks, or nothing (hidden). */
export type AnalyzerOutput = Insight | Block | readonly Block[] | null | undefined;

/** An analyzer, as {@link defineAnalyzer} returns it. */
export interface Analyzer {
  /** Stable and unique: `[a-z0-9][a-z0-9-]*`, up to 40 characters. The cache key. */
  id: string;
  /** Shown above the insight. */
  title: string;
  /** `poll`: after a poll, for PRs whose head changed (cheap). `open`: when the panel opens (expensive). */
  when: "poll" | "open";
  /** `default` for the kit's own, `yours` otherwise. */
  origin: Origin;
  /** Return `false` to skip a PR. Default: every PR. */
  appliesTo?(ctx: InboxContext): boolean;
  /**
   * What, besides the analyzer and the patch-id, the result depends on, e.g.
   * my open PRs' files. Added to {@link insightCacheKey}.
   */
  cacheKey?(ctx: InboxContext): string;
  run(ctx: InboxContext): AnalyzerOutput | Promise<AnalyzerOutput>;
}

/** Classifiers and analyzers, for all repos or for some. */
export interface InboxParts {
  classifiers: readonly AttentionClassifier[];
  analyzers: readonly Analyzer[];
}

/** An inbox, as {@link defineInbox} returns it. */
export interface Inbox extends InboxParts {
  /** Extra parts for some repos, keyed by `owner/name` or a glob such as `acme/*`. */
  repos: Readonly<Record<string, Partial<InboxParts>>>;
}

/** An analyzer's result for one PR, as the runner keeps it and the wire carries it. Plain JSON. */
export type InsightState = {
  id: string;
  title: string;
  origin: Origin;
  when: "poll" | "open";
} & (
  | { status: "ready"; insight: Insight; ms?: number }
  /** The analyzer had nothing to say: the panel hides it. */
  | { status: "empty"; ms?: number }
  | { status: "running" }
  | { status: "failed"; error: string; ms?: number }
);
