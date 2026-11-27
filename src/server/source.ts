/**
 * What `nod serve` reads from and writes to: GitHub, behind one seam.
 *
 * - `FakeSource` (`fake-source.ts`, `nod serve --fake`): the mockup's data
 *   set in memory; signing and acking change it so the UI can be exercised.
 *   One repo, or three with `--scenario repos`.
 * - The GitHub source (`github-source.ts`): polls GraphQL with the `gh`
 *   token about every 60 s and reads the verifier's check summary; patch-ids
 *   come from the clone it runs in. One repo, as a list of one (#48 reads
 *   many).
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
  RepoChoice,
  RepoKey,
  RepoName,
  SetupStatus,
  Snapshot,
} from "../shared/protocol";

/** A repo the source reads: the wire's `RepoInfo` without what the session adds. */
export interface SourceRepo {
  readonly key: RepoKey;
  /** `owner/name`, as in the nod payload. */
  readonly name: RepoName;
  readonly github: GitHubInfo;
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

/** What changed, for the session's pushes. */
export type SourceChange = "prs" | "setup" | "enrolment";

export class SourceError extends Error {
  constructor(
    readonly code:
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
  /** Onboarding step 1: repos the account can pick (while `repos()` is empty). */
  listRepos(): Promise<ReadonlyArray<RepoChoice>>;
  /** The repos it reads, in order; empty before the first is picked (the fake's `fresh`). */
  repos(): ReadonlyArray<SourceRepo>;
  /** Pick the first repo. Throws `SourceError` `not-found` / `forbidden`. */
  pickRepo(repo: RepoName): Promise<void>;
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
