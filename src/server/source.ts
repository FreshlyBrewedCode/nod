/**
 * What `nod serve` reads from and writes to: GitHub, behind one seam.
 *
 * - `FakeSource` (`fake-source.ts`, `nod serve --fake`): the mockup's data
 *   set in memory; signing and acking change it so the UI can be exercised.
 * - The GitHub source (`github-source.ts`): polls GraphQL with the `gh`
 *   token about every 60 s and reads the verifier's check summary; patch-ids
 *   come from the clone it runs in.
 *
 * The session (`session.ts`) owns the signer and the protocol; a source only
 * knows the repo. It never sees a passphrase or a private key.
 */

import type {
  Account,
  Login,
  Enrolment,
  GitHubInfo,
  PrLink,
  PrState,
  RepoChoice,
  RepoName,
  SetupStatus,
  Snapshot,
} from "../shared/protocol";

/** What a nod entry is built from: the PR as the source sees it now. */
export interface SignTarget {
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

export interface PostNodInput {
  readonly payload: NodPayload;
  /** The exact signed line; the payload above is its parsed form. */
  readonly line: string;
  readonly signature: string;
  /** The full comment body, the same on every PR of the batch. */
  readonly body: string;
}

/** A batch of GitHub approvals, as the session checked it. */
export interface PostApprovalsInput {
  readonly repo: RepoName;
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

export interface Source {
  /** The `gh` account; null when `gh` is not logged in. */
  account(): Promise<Account | null>;
  /** Onboarding step 1: repos the account can pick. */
  listRepos(): Promise<ReadonlyArray<RepoChoice>>;
  /** The picked repo; null before onboarding step 1. */
  repo(): RepoName | null;
  /** The GitHub host the repo is on (from the clone's origin; the fake: github.com). */
  github(): GitHubInfo;
  /** Throws `SourceError` `not-found` / `forbidden`. */
  pickRepo(repo: RepoName): Promise<void>;
  /** The dashboard's state for the account, from the last read; null without a repo. */
  snapshot(): Snapshot | null;
  /** Read GitHub now. */
  refresh(): Promise<void>;
  /**
   * The PR as a nod entry would be built from it, read fresh (the GitHub
   * source computes the patch-id against the base as it is now); null when
   * not in the repo.
   */
  signTarget(pr: number): Promise<SignTarget | null>;
  /** Post the same nod comment on every PR of the payload. Never throws per PR. */
  postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>>;
  /**
   * Approve each PR on GitHub at its `headSha` (an `APPROVED` review, ADR
   * 0006), as the source's account. Never throws per PR. The row leaves
   * "needs me" with the next snapshot: the review request is answered.
   */
  postApprovals(input: PostApprovalsInput): Promise<ReadonlyArray<PostResult>>;
  /** Mark an FYI as seen. Throws `SourceError` `not-found`. */
  ackFyi(pr: number): Promise<void>;
  /** The repo's setup: `.nod/`, the workflow, the ruleset. */
  setup(): Promise<SetupStatus>;
  /** Open the setup PR, with `publicKey` as the first allowed signer when given. */
  openSetupPr(publicKey: string | null): Promise<PrLink>;
  /** Open the PR that adds `publicKey` to `.nod/allowed_signers`. */
  openEnrolPr(publicKey: string): Promise<PrLink>;
  /** Whether the repo trusts the key (allowed_signers on the base branch). */
  enrolment(publicKey: string): Enrolment;
  /** A new key appeared (onboarding): the fake adds it to an open setup PR. */
  keyCreated(publicKey: string): void;
  subscribe(listener: (change: SourceChange) => void): () => void;
  stop(): void;
}
