/**
 * What `nod serve` reads from and writes to: GitHub, behind one seam.
 *
 * - `FakeSource` (`fake-source.ts`, `nod serve --fake`): the mockup's data
 *   set in memory; signing and acking change it so the UI can be exercised.
 *   One repo, or three with `--scenario repos`.
 * - The GitHub source (`github-source.ts`): the repos of the config file's
 *   list (`managed`), or the one `--dir` clone (`fixed`); one GraphQL poll
 *   per host about every 60 s with each host's `gh` token, the verifier's
 *   check summary, patch-ids in nod's own clones or the `--dir` clone.
 *
 * One source knows every repo (ADR 0007, 8): what touches a repo takes its
 * key, and `snapshot()` holds all of them. The session (`session.ts`) owns
 * the signer and the protocol, and groups a batch by repo; a source knows
 * the repos. It never sees a passphrase or a private key.
 */

import type {
  Account,
  Login,
  Enrolment,
  GitHubInfo,
  PrLink,
  PrState,
  RepoKey,
  RepoList,
  RepoName,
  RepoSuggestion,
  SetupStatus,
  Snapshot,
} from "../shared/protocol";

/** A repo the source reads: the wire's `RepoInfo` without what the session adds. */
export interface SourceRepo {
  readonly key: RepoKey;
  /** `owner/name`, as in the nod payload. */
  readonly name: RepoName;
  readonly github: GitHubInfo;
  /**
   * My login on its host (logins differ between hosts, ADR 0007, 8): a nod's
   * `reviewer`, "your own PR". null while the host is not read yet, or `gh`
   * is not logged in there; the session then falls back to `account()` on
   * that account's host.
   */
  readonly login: string | null;
}

/** What a nod entry is built from: the PR as the source sees it now. */
export interface SignTarget {
  readonly repo: RepoKey;
  readonly pr: number;
  readonly state: PrState;
  /** The GitHub author: GitHub refuses an approval of one's own PR. */
  readonly author: Login;
  readonly base: string;
  readonly headSha: string;
  readonly patchId: string | null;
}

/** One nod payload (ADR 0001), as the session built it. */
export interface NodPayload {
  readonly v: 1;
  readonly repo: RepoName;
  readonly entries: ReadonlyArray<{
    readonly pr: number;
    readonly base: string;
    readonly head_sha: string;
    readonly patch_id: string;
  }>;
  readonly verdict: "approve";
  readonly level: "review";
  readonly reviewer: string;
  readonly signed_at: string;
}

/** One repo's nod of a batch: the session signs one payload per repo (ADR 0007, 10). */
export interface PostNodInput {
  readonly repo: RepoKey;
  readonly payload: NodPayload;
  /** The exact signed line; the payload above is its parsed form. */
  readonly line: string;
  readonly signature: string;
  /** The full comment body, the same on every PR of the repo's part of the batch. */
  readonly body: string;
}

/** One repo's GitHub approvals of a batch, as the session checked them. */
export interface PostApprovalsInput {
  readonly repo: RepoKey;
  /** Each PR at the head the user looked at: the review's `commit_id`. */
  readonly entries: ReadonlyArray<{ readonly pr: number; readonly headSha: string }>;
  /** The review's text; null: none, as `gh pr review --approve`. */
  readonly body: string | null;
}

export interface PostResult {
  readonly pr: number;
  readonly ok: boolean;
  /** The comment's (or review's) URL when it was posted, else why not. */
  readonly url: string | null;
  readonly message: string | null;
}

/**
 * What changed, for the session's pushes. `repos`: the list itself (a repo
 * added or removed); emitted before the `prs` that follows it.
 */
export type SourceChange = "prs" | "setup" | "enrolment" | "repos";

export class SourceError extends Error {
  constructor(
    readonly code:
      | "bad-request"
      | "no-repo"
      | "no-key"
      | "not-found"
      | "forbidden"
      | "already-set-up"
      | "already-enrolled"
      | "github"
      | "not-implemented",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Every method that names a repo throws `SourceError` `not-found` for a key
 * it does not read (`repos()`).
 */
export interface Source {
  /** The `gh` account; null when `gh` is not logged in. */
  account(): Promise<Account | null>;
  /**
   * Whether the list may be changed (`managed`: the config file's list), or
   * is the one clone of `--dir` (`fixed`). The session refuses `add-repo` and
   * `remove-repo` on a fixed list before it asks the source.
   */
  readonly repoList: RepoList;
  /** The repos it reads, in order; a managed list may be empty (the fake's `fresh`). */
  repos(): ReadonlyArray<SourceRepo>;
  /**
   * Add a repo to the list: `input` as the person gave it, `owner/name`,
   * `host/owner/name` or a link (`parseRepoInput`). Checks that the host's
   * account can read it, then emits `repos` and `prs`. A repo the list has
   * already is returned as it is. Throws `SourceError` `bad-request` (names
   * no repo), `not-found`, `forbidden`, `github`.
   */
  addRepo(input: string): Promise<SourceRepo>;
  /** Stop reading a repo; emits `repos` and `prs`. Throws `SourceError` `not-found`. */
  removeRepo(repo: RepoKey): Promise<void>;
  /**
   * Repos where I have open PRs or review requests (one search per host),
   * the busiest first, without those of the list.
   */
  suggestRepos(): Promise<ReadonlyArray<RepoSuggestion>>;
  /** The dashboard's state for the account, every repo's PRs; null before the first read. */
  snapshot(): Snapshot | null;
  /** Read GitHub now. */
  refresh(): Promise<void>;
  /**
   * The PR as a nod entry would be built from it, read fresh (the GitHub
   * source computes the patch-id against the base as it is now); null when
   * the repo has no such PR.
   */
  signTarget(repo: RepoKey, pr: number): Promise<SignTarget | null>;
  /** Post the same nod comment on every PR of the payload, in `repo`. Never throws per PR. */
  postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>>;
  /**
   * Approve each PR on GitHub at its `headSha` (an `APPROVED` review, ADR
   * 0006), as the source's account. Never throws per PR. The row leaves
   * "needs me" with the next snapshot: the review request is answered.
   */
  postApprovals(input: PostApprovalsInput): Promise<ReadonlyArray<PostResult>>;
  /** Mark an FYI as seen. Throws `SourceError` `not-found`. */
  ackFyi(repo: RepoKey, pr: number): Promise<void>;
  /** A repo's setup: `.nod/`, the workflow, the ruleset. */
  setup(repo: RepoKey): Promise<SetupStatus>;
  /** Open a repo's setup PR, with `publicKey` as the first allowed signer when given. */
  openSetupPr(repo: RepoKey, publicKey: string | null): Promise<PrLink>;
  /** Open the PR that adds `publicKey` to a repo's `.nod/allowed_signers`. */
  openEnrolPr(repo: RepoKey, publicKey: string): Promise<PrLink>;
  /** Whether a repo trusts the key (its allowed_signers on the base branch). */
  enrolment(repo: RepoKey, publicKey: string): Enrolment;
  /** A new key appeared (onboarding): the GitHub source rebuilds what I can sign. */
  keyCreated(publicKey: string): void;
  subscribe(listener: (change: SourceChange) => void): () => void;
  stop(): void;
}
