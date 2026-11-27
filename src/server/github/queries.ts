/**
 * The GraphQL `nod serve` sends, and the shapes it gets back.
 *
 * One poll is one `POLL` query (a second page only past 50 open PRs; it also
 * asks GitHub's search which open PRs request a review from me, teams
 * included, `review-requested:@me`) plus,
 * only when something new needs it, one `details` query: merged or closed
 * PRs not cached yet, the `text` of `nod` check runs not seen yet (the
 * verifier's summary, cached by check run id), epic titles, and
 * `.nod/allowed_signers` at the head of an open enrolment PR.
 */

/** Everything a row, the panel and the journey need about one PR. */
export const PR_FIELDS = `
  number title body url state isDraft merged mergedAt closedAt createdAt updatedAt
  author { login ... on User { name } }
  baseRefName headRefName headRefOid
  baseRef { target { oid } }
  additions deletions changedFiles
  autoMergeRequest { enabledAt }
  mergeable
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } } }
  latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state submittedAt author { login } } }
  files(first: 100) { totalCount nodes { path additions deletions } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state contexts(first: 60) { nodes { __typename
    ... on CheckRun { id databaseId name status conclusion startedAt completedAt title checkSuite { app { slug } workflowRun { workflow { resourcePath } } } }
    ... on StatusContext { context state createdAt } } } } } } }
  comments(last: 60) { totalCount nodes { url createdAt author { login } body } }
  reactions(first: 50, content: EYES) { nodes { createdAt user { login ... on User { name } } } }
  timelineItems(last: 60, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT]) { nodes { __typename
    ... on PullRequestCommit { commit { oid committedDate } }
    ... on HeadRefForcePushedEvent { createdAt }
    ... on BaseRefChangedEvent { createdAt currentRefName }
    ... on MergedEvent { createdAt }
    ... on ClosedEvent { createdAt }
    ... on ReopenedEvent { createdAt } } }
`;

export const POLL = `
query Poll($owner: String!, $name: String!, $after: String, $requested: String!) {
  rateLimit { cost remaining limit resetAt }
  viewer { login name }
  requested: search(query: $requested, type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } }
  repository(owner: $owner, name: $name) {
    nameWithOwner viewerPermission autoMergeAllowed pushedAt
    defaultBranchRef { name target { oid } }
    policy: object(expression: "HEAD:.nod/policy.ts") { id }
    verifier: object(expression: "HEAD:.nod/verify.ts") { id }
    workflow: object(expression: "HEAD:.github/workflows/nod.yml") { id }
    signers: object(expression: "HEAD:.nod/allowed_signers") { ... on Blob { oid text } }
    closed: pullRequests(states: [MERGED, CLOSED], first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number updatedAt closedAt }
    }
    open: pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

/**
 * The search for the open PRs of `owner/name` that request a review from the
 * viewer, directly or through a team they are in (`user-review-requested`
 * would be direct requests only). Mentions are not review requests.
 */
export function requestedQuery(owner: string, name: string): string {
  return `repo:${owner}/${name} is:pr is:open review-requested:@me`;
}

/** The PR as `signTarget` re-reads it right before signing. */
export const SIGN_TARGET = `
query SignTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { number state isDraft merged baseRefName headRefOid baseRef { target { oid } } }
  }
}`;

/** The second query of a poll, built for what is missing. */
export function detailsQuery(input: {
  readonly prs: ReadonlyArray<number>;
  readonly checkRuns: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<number>;
  readonly blobs: ReadonlyArray<{ readonly key: string; readonly expression: string }>;
}): string {
  const parts: string[] = [];
  const repo: string[] = [];
  for (const n of input.prs)
    repo.push(`pr${int(n)}: pullRequest(number: ${int(n)}) { ${PR_FIELDS} }`);
  for (const n of input.issues)
    repo.push(
      `issue${int(n)}: issueOrPullRequest(number: ${int(n)}) { ... on Issue { title } ... on PullRequest { title } }`,
    );
  for (const b of input.blobs)
    repo.push(
      `${b.key}: object(expression: ${JSON.stringify(b.expression)}) { ... on Blob { text } }`,
    );
  // Always there, so the query's variables are always used.
  parts.push(`repository(owner: $owner, name: $name) { id ${repo.join("\n")} }`);
  if (input.checkRuns.length)
    parts.push(
      `texts: nodes(ids: ${JSON.stringify(input.checkRuns)}) { ... on CheckRun { id databaseId text } }`,
    );
  return `query Details($owner: String!, $name: String!) {
  rateLimit { cost remaining limit resetAt }
  ${parts.join("\n")}
}`;
}

const int = (n: number) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not a PR number: ${n}`);
  return n;
};

// ---------------------------------------------------------------------------
// what comes back

export interface RawCheckRun {
  readonly __typename: "CheckRun";
  readonly id: string;
  readonly databaseId: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly title: string | null;
  readonly checkSuite: {
    readonly app: { readonly slug: string } | null;
    readonly workflowRun: { readonly workflow: { readonly resourcePath: string } | null } | null;
  } | null;
}

export interface RawStatusContext {
  readonly __typename: "StatusContext";
  readonly context: string;
  readonly state: string;
  readonly createdAt: string;
}

export type RawContext = RawCheckRun | RawStatusContext;

export type RawTimelineItem =
  | {
      readonly __typename: "PullRequestCommit";
      readonly commit: { readonly oid: string; readonly committedDate: string };
    }
  | { readonly __typename: "HeadRefForcePushedEvent"; readonly createdAt: string }
  | {
      readonly __typename: "BaseRefChangedEvent";
      readonly createdAt: string;
      readonly currentRefName: string;
    }
  | { readonly __typename: "MergedEvent"; readonly createdAt: string }
  | { readonly __typename: "ClosedEvent"; readonly createdAt: string }
  | { readonly __typename: "ReopenedEvent"; readonly createdAt: string };

export interface RawPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly isDraft: boolean;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly author: { readonly login: string; readonly name?: string | null } | null;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRef: { readonly target: { readonly oid: string } | null } | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly autoMergeRequest: { readonly enabledAt: string | null } | null;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN` (GitHub computes it lazily). Optional: older fixtures. */
  readonly mergeable?: string;
  readonly reviewRequests?: {
    readonly nodes: ReadonlyArray<{
      readonly requestedReviewer:
        | { readonly __typename: "User"; readonly login: string }
        | { readonly __typename: "Team"; readonly combinedSlug: string }
        | { readonly __typename: string }
        | null;
    } | null>;
  };
  /** Each writer's latest approving, change-requesting or dismissed review. */
  readonly latestOpinionatedReviews?: {
    readonly nodes: ReadonlyArray<{
      readonly state: string;
      readonly submittedAt: string | null;
      readonly author: { readonly login: string } | null;
    } | null>;
  };
  readonly files: {
    readonly totalCount: number;
    readonly nodes: ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
  } | null;
  readonly commits: {
    readonly nodes: ReadonlyArray<{
      readonly commit: {
        readonly oid: string;
        readonly committedDate: string;
        readonly statusCheckRollup: {
          readonly state: string;
          readonly contexts: { readonly nodes: ReadonlyArray<RawContext | null> };
        } | null;
      };
    } | null>;
  };
  readonly comments: {
    readonly totalCount: number;
    readonly nodes: ReadonlyArray<{
      readonly url: string;
      readonly createdAt: string;
      readonly author: { readonly login: string } | null;
      readonly body: string;
    } | null>;
  };
  readonly reactions: {
    readonly nodes: ReadonlyArray<{
      readonly createdAt: string;
      readonly user: { readonly login: string; readonly name?: string | null } | null;
    } | null>;
  };
  readonly timelineItems: { readonly nodes: ReadonlyArray<RawTimelineItem | null> };
}

export interface PollData {
  readonly rateLimit: { cost: number; remaining: number; limit: number; resetAt: string } | null;
  readonly viewer: { readonly login: string; readonly name: string | null };
  /** Open PRs that request a review from the viewer (`requestedQuery`). Optional: older fixtures. */
  readonly requested?: {
    readonly nodes: ReadonlyArray<{ readonly number?: number } | null>;
  } | null;
  readonly repository: {
    readonly nameWithOwner: string;
    readonly viewerPermission: string | null;
    readonly autoMergeAllowed: boolean;
    readonly pushedAt: string | null;
    readonly defaultBranchRef: {
      readonly name: string;
      readonly target: { readonly oid: string } | null;
    } | null;
    readonly policy: { readonly id: string } | null;
    readonly verifier: { readonly id: string } | null;
    readonly workflow: { readonly id: string } | null;
    readonly signers: { readonly oid: string; readonly text: string | null } | null;
    readonly closed?: {
      readonly nodes: ReadonlyArray<{
        readonly number: number;
        readonly updatedAt: string;
        readonly closedAt: string | null;
      } | null>;
    };
    readonly open: {
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      readonly nodes: ReadonlyArray<RawPr | null>;
    };
  } | null;
}

export interface DetailsData {
  readonly repository?: Record<
    string,
    (RawPr & { title: string }) | { readonly title?: string; readonly text?: string | null } | null
  > | null;
  readonly texts?: ReadonlyArray<{
    readonly id?: string;
    readonly databaseId?: number;
    readonly text?: string | null;
  } | null>;
}
