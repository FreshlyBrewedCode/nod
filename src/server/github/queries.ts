/**
 * The GraphQL `nod serve` sends, and the shapes it gets back.
 *
 * One poll is one `Poll` query **per host** (ADR 0007, 5): a block per repo
 * (`r0`, `r1`, …) and, next to each, GitHub's search for the repo's open PRs
 * that request a review from me, teams included (`q0`, …,
 * `review-requested:@me`). A repo past 50 open PRs reads the rest with a
 * `Page` query of its own. Then, only when something new needs it, one
 * `Details` query per host, again a block per repo (`d0`, …): merged or
 * closed PRs not cached yet, epic titles, `.nod/allowed_signers` at the
 * head of an open enrolment PR; and the `text` of `nod` check runs not seen
 * yet (the verifier's summary, cached by check run id).
 */

/** Everything a row, the panel and the journey need about one PR. */
export const PR_FIELDS = `
  number title body url state isDraft merged mergedAt closedAt createdAt updatedAt
  author { login ... on User { name } }
  labels(first: 20) { nodes { name } }
  baseRefName headRefName headRefOid
  baseRef { target { oid } }
  additions deletions changedFiles
  autoMergeRequest { enabledAt }
  mergeable
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } } }
  latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state submittedAt author { login } commit { oid } } }
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

/** What a poll reads of one repo, beside its open PRs. */
const REPO_FIELDS = `
    nameWithOwner viewerPermission autoMergeAllowed pushedAt
    defaultBranchRef { name target { oid } }
    policy: object(expression: "HEAD:.nod/policy.ts") { id }
    verifier: object(expression: "HEAD:.nod/verify.ts") { id }
    workflow: object(expression: "HEAD:.github/workflows/nod.yml") { id }
    signers: object(expression: "HEAD:.nod/allowed_signers") { ... on Blob { oid text } }
    closed: pullRequests(states: [MERGED, CLOSED], first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number updatedAt closedAt }
    }`;

const OPEN = (after: string) => `
    open: pullRequests(states: OPEN, first: 50, after: ${after}, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }`;

/** A repo of a host's poll: `owner/name`. */
export interface PollRepo {
  readonly owner: string;
  readonly name: string;
}

/**
 * The poll of one host: the viewer, the budget, and per repo `r<i>` (the
 * repo and its first 50 open PRs) and `q<i>` (the review requests for me).
 * Names travel as variables (`$o<i>`, `$n<i>`, `$q<i>`), never spliced in.
 */
export function pollQuery(repos: ReadonlyArray<PollRepo>): {
  query: string;
  variables: Record<string, string>;
} {
  const vars: string[] = [];
  const blocks: string[] = [];
  const variables: Record<string, string> = {};
  repos.forEach((r, i) => {
    vars.push(`$o${i}: String!`, `$n${i}: String!`, `$q${i}: String!`);
    variables[`o${i}`] = r.owner;
    variables[`n${i}`] = r.name;
    variables[`q${i}`] = requestedQuery(r.owner, r.name);
    blocks.push(
      `q${i}: search(query: $q${i}, type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } }`,
      `r${i}: repository(owner: $o${i}, name: $n${i}) {${REPO_FIELDS}${OPEN("null")}\n  }`,
    );
  });
  const params = vars.length ? `(${vars.join(", ")})` : "";
  return {
    query: `query Poll${params} {
  rateLimit { cost remaining limit resetAt }
  viewer { login name }
  ${blocks.join("\n  ")}
}`,
    variables,
  };
}

/** One repo's next page of open PRs, past the first 50. */
export const PAGE = `
query Page($owner: String!, $name: String!, $after: String!) {
  rateLimit { cost remaining limit resetAt }
  repository(owner: $owner, name: $name) {${OPEN("$after")}
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
    pullRequest(number: $number) { number state isDraft merged author { login } baseRefName headRefOid baseRef { target { oid } } }
  }
}`;

/** What one repo of a `Details` query asks for. */
export interface DetailsRepo extends PollRepo {
  readonly prs: ReadonlyArray<number>;
  readonly issues: ReadonlyArray<number>;
  readonly blobs: ReadonlyArray<{ readonly key: string; readonly expression: string }>;
}

/** The second query of a host's poll, built for what is missing: `d<i>` per repo, `texts`. */
export function detailsQuery(input: {
  readonly repos: ReadonlyArray<DetailsRepo>;
  readonly checkRuns: ReadonlyArray<string>;
}): { query: string; variables: Record<string, string> } {
  const parts: string[] = [];
  const vars: string[] = [];
  const variables: Record<string, string> = {};
  input.repos.forEach((r, i) => {
    const repo: string[] = [];
    for (const n of r.prs)
      repo.push(`pr${int(n)}: pullRequest(number: ${int(n)}) { ${PR_FIELDS} }`);
    for (const n of r.issues)
      repo.push(
        `issue${int(n)}: issueOrPullRequest(number: ${int(n)}) { ... on Issue { title } ... on PullRequest { title } }`,
      );
    for (const b of r.blobs)
      repo.push(
        `${b.key}: object(expression: ${JSON.stringify(b.expression)}) { ... on Blob { text } }`,
      );
    vars.push(`$o${i}: String!`, `$n${i}: String!`);
    variables[`o${i}`] = r.owner;
    variables[`n${i}`] = r.name;
    parts.push(`d${i}: repository(owner: $o${i}, name: $n${i}) { id ${repo.join("\n")} }`);
  });
  if (input.checkRuns.length)
    parts.push(
      `texts: nodes(ids: ${JSON.stringify(input.checkRuns)}) { ... on CheckRun { id databaseId text } }`,
    );
  const params = vars.length ? `(${vars.join(", ")})` : "";
  return {
    query: `query Details${params} {
  rateLimit { cost remaining limit resetAt }
  ${parts.join("\n")}
}`,
    variables,
  };
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
  /** For my inbox's `mute({ labels })` (ADR 0009). Optional: older fixtures. */
  readonly labels?: { readonly nodes: ReadonlyArray<{ readonly name: string } | null> } | null;
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
      /** The commit it reviewed. Optional: older fixtures. */
      readonly commit?: { readonly oid: string } | null;
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

/** One repo of a poll (`r<i>`). */
export interface RawRepo {
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
  readonly open: OpenPage;
}

export interface OpenPage {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: ReadonlyArray<RawPr | null>;
}

/** A host's poll: `viewer`, then `r<i>` (null: not found or not readable) and `q<i>` per repo. */
export interface PollData {
  readonly rateLimit: { cost: number; remaining: number; limit: number; resetAt: string } | null;
  readonly viewer: { readonly login: string; readonly name: string | null };
  readonly [block: `r${number}`]: RawRepo | null | undefined;
  /** Open PRs that request a review from the viewer (`requestedQuery`). */
  readonly [search: `q${number}`]:
    | { readonly nodes: ReadonlyArray<{ readonly number?: number } | null> }
    | null
    | undefined;
}

export interface PageData {
  readonly repository: { readonly open: OpenPage } | null;
}

/** One repo of a `Details` query (`d<i>`): `pr<n>`, `issue<n>`, `signers<k>`. */
export type DetailsRepoData = Record<
  string,
  (RawPr & { title: string }) | { readonly title?: string; readonly text?: string | null } | null
>;

export interface DetailsData {
  readonly [block: `d${number}`]: DetailsRepoData | null | undefined;
  readonly texts?: ReadonlyArray<{
    readonly id?: string;
    readonly databaseId?: number;
    readonly text?: string | null;
  } | null>;
}
