/**
 * Thin REST helpers for the verifier, built on `fetch`. Each takes
 * `{ token, repo, apiUrl?, fetch? }`; `fetch` can be injected for tests.
 * Errors never contain the token, and the token goes to `apiUrl`'s origin
 * only: a redirect elsewhere is refused, not followed with it.
 */
import type { PullRequestReview } from "./evaluate.ts";
import { fetchWithToken } from "./host.ts";
import { isRepoName } from "./nod.ts";
import { isStickyComment } from "./sticky.ts";

/** Connection to one repo. */
export interface GitHubOptions {
  token: string;
  /** `owner/name`. */
  repo: string;
  /**
   * Default `https://api.github.com`. On GitHub Enterprise pass `GITHUB_API_URL`
   * (`https://api.<name>.ghe.com`, `https://<host>/api/v3`) or `githubHost(…).apiUrl`.
   */
  apiUrl?: string;
  fetch?: typeof fetch;
}

/** A failed API call. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`GitHub ${status} on ${path}: ${message}`);
    this.name = "GitHubError";
  }
}

/** Sends one request and returns the parsed JSON (or `null` for an empty body). */
export async function githubRequest<T = unknown>(
  options: GitHubOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { token, apiUrl = "https://api.github.com", fetch: doFetch = fetch } = options;
  const base = apiUrl.replace(/\/+$/, "");
  const res = await fetchWithToken(
    `${base}${path}`,
    {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { token, fetch: doFetch, allowed: (url) => underBase(base, url) },
  );
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = String((JSON.parse(text) as { message?: unknown }).message ?? message);
    } catch {
      // not JSON: keep the raw text
    }
    throw new GitHubError(res.status, path, token ? message.replaceAll(token, "***") : message);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** The PR fields the verifier uses. */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  /** Base branch name. */
  base: string;
  head_sha: string;
  state: string;
  draft: boolean;
}

/** `GET /repos/{repo}/pulls/{n}`. */
export async function getPullRequest(options: GitHubOptions, number: number): Promise<PullRequest> {
  type Raw = {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    base: { ref: string };
    head: { sha: string };
    state: string;
    draft?: boolean;
  };
  const pr = await githubRequest<Raw>(options, "GET", `${repoPath(options)}/pulls/${int(number)}`);
  return {
    number: pr.number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    author: pr.user.login,
    labels: (pr.labels ?? []).map((l) => l.name),
    base: pr.base.ref,
    head_sha: pr.head.sha,
    state: pr.state,
    draft: pr.draft ?? false,
  };
}

/** An issue comment. */
export interface IssueComment {
  id: number;
  body: string;
  /** Who posted it. Never used to decide whether a nod counts. */
  author: string;
  authorType: string;
  created_at: string;
  updated_at: string;
}

/** Every comment on a PR, all pages (up to `maxPages` × 100, default 5000). */
export async function listIssueComments(
  options: GitHubOptions,
  number: number,
  maxPages = 50,
): Promise<IssueComment[]> {
  type Raw = {
    id: number;
    body?: string | null;
    user?: { login: string; type: string } | null;
    created_at: string;
    updated_at: string;
  };
  const out: IssueComment[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await githubRequest<Raw[]>(
      options,
      "GET",
      `${repoPath(options)}/issues/${int(number)}/comments?per_page=100&page=${page}`,
    );
    for (const c of items) {
      out.push({
        id: c.id,
        body: c.body ?? "",
        author: c.user?.login ?? "",
        authorType: c.user?.type ?? "",
        created_at: c.created_at,
        updated_at: c.updated_at,
      });
    }
    if (items.length < 100) break;
  }
  return out;
}

/** Every review on a PR, oldest first, all pages (up to `maxPages` × 100, default 5000). */
export async function listReviews(
  options: GitHubOptions,
  number: number,
  maxPages = 50,
): Promise<PullRequestReview[]> {
  type Raw = {
    user?: { login: string; type: string } | null;
    state: string;
    commit_id?: string | null;
    submitted_at?: string | null;
  };
  const out: PullRequestReview[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await githubRequest<Raw[]>(
      options,
      "GET",
      `${repoPath(options)}/pulls/${int(number)}/reviews?per_page=100&page=${page}`,
    );
    for (const r of items) {
      out.push({
        reviewer: r.user?.login ?? "",
        reviewerType: r.user?.type ?? "",
        state: r.state,
        commit_id: r.commit_id ?? null,
        submitted_at: r.submitted_at ?? null,
      });
    }
    if (items.length < 100) break;
  }
  return out;
}

/** A person's role on a repo, as GitHub names it. */
export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/**
 * `GET /repos/{repo}/collaborators/{login}/permission`: the person's role
 * (`role_name`, else `permission`). Throws when GitHub does not answer.
 */
export async function getRepoPermission(
  options: GitHubOptions,
  login: string,
): Promise<RepoPermission> {
  if (!login || login.length > 100) throw new Error(`not a login: ${login}`);
  const r = await githubRequest<{ permission?: string; role_name?: string }>(
    options,
    "GET",
    `${repoPath(options)}/collaborators/${encodeURIComponent(login)}/permission`,
  );
  const role = r.role_name ?? r.permission ?? "none";
  const known: readonly string[] = ["admin", "maintain", "write", "triage", "read", "none"];
  return (known.includes(role) ? role : "none") as RepoPermission;
}

/** Whether a role may approve so that it counts: `admin`, `maintain` or `write`, as on GitHub. */
export function canWrite(permission: RepoPermission): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/** Input of {@link createCheckRun}. */
export interface CheckRunInput {
  head_sha: string;
  /** Default `nod`. */
  name?: string;
  /**
   * `success`, `failure`, or `neutral` while the check is not enforced
   * (ADR 0006): `neutral` passes a required check, so it is only for a
   * branch that does not require it. `skipped` and the rest are refused.
   */
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  text?: string;
  external_id?: string;
  details_url?: string;
}

/** Creates a completed check run on the PR head SHA. Returns its id. */
export async function createCheckRun(
  options: GitHubOptions,
  input: CheckRunInput,
): Promise<number> {
  if (
    input.conclusion !== "success" &&
    input.conclusion !== "failure" &&
    input.conclusion !== "neutral"
  ) {
    throw new Error("a nod check concludes only success, failure or neutral");
  }
  const run = await githubRequest<{ id: number }>(
    options,
    "POST",
    `${repoPath(options)}/check-runs`,
    {
      name: input.name ?? "nod",
      head_sha: input.head_sha,
      status: "completed",
      conclusion: input.conclusion,
      ...(input.external_id ? { external_id: input.external_id } : {}),
      ...(input.details_url ? { details_url: input.details_url } : {}),
      output: {
        title: input.title.slice(0, 255),
        summary: input.summary.slice(0, 65_535),
        ...(input.text === undefined ? {} : { text: input.text.slice(0, 65_535) }),
      },
    },
  );
  return run.id;
}

/**
 * Creates or updates the sticky comment. The existing one is a comment that
 * starts with the sticky marker and was posted by a bot (`authorType`
 * `Bot`), or by `author` when given, so a marker planted by someone else is
 * left alone. Returns the comment id. With `create: false` an existing one
 * is updated but none is created (the check is not enforced, ADR 0006), and
 * `null` is returned when there is none.
 */
export async function upsertStickyComment(
  options: GitHubOptions,
  number: number,
  body: string,
  match: { author?: string; comments?: readonly IssueComment[]; create?: boolean } = {},
): Promise<number | null> {
  const comments = match.comments ?? (await listIssueComments(options, number));
  const mine = comments.find(
    (c) =>
      isStickyComment(c.body) &&
      (match.author
        ? c.author.toLowerCase() === match.author.toLowerCase()
        : c.authorType === "Bot"),
  );
  if (mine) {
    if (mine.body === body) return mine.id;
    await githubRequest(options, "PATCH", `${repoPath(options)}/issues/comments/${int(mine.id)}`, {
      body,
    });
    return mine.id;
  }
  if (match.create === false) return null;
  const created = await githubRequest<{ id: number }>(
    options,
    "POST",
    `${repoPath(options)}/issues/${int(number)}/comments`,
    {
      body,
    },
  );
  return created.id;
}

/**
 * Makes the PR's labels with `prefix` (default `nod:`) exactly `wanted`,
 * leaving every other label alone. Labels are display only; the gate never
 * reads them. `current` saves a request when the PR was just fetched.
 */
export async function syncLabels(
  options: GitHubOptions,
  number: number,
  wanted: readonly string[],
  opts: { prefix?: string; current?: readonly string[] } = {},
): Promise<{ added: string[]; removed: string[] }> {
  const prefix = opts.prefix ?? "nod:";
  const current = opts.current ?? (await getPullRequest(options, number)).labels;
  const added = wanted.filter((l) => !current.includes(l));
  const removed = current.filter((l) => l.startsWith(prefix) && !wanted.includes(l));
  for (const l of removed) {
    await githubRequest(
      options,
      "DELETE",
      `${repoPath(options)}/issues/${int(number)}/labels/${encodeURIComponent(l)}`,
    );
  }
  if (added.length) {
    await githubRequest(options, "POST", `${repoPath(options)}/issues/${int(number)}/labels`, {
      labels: added,
    });
  }
  return { added, removed };
}

/** Whether `url` is on `base`'s origin and under its path: where the token may go. */
function underBase(base: string, url: string): boolean {
  const b = new URL(base);
  const u = new URL(url);
  const prefix = b.pathname.replace(/\/+$/, "");
  return (
    u.protocol === b.protocol &&
    u.host === b.host &&
    !u.username &&
    !u.password &&
    (prefix === "" || u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))
  );
}

function repoPath({ repo }: GitHubOptions): string {
  if (!isRepoName(repo)) throw new Error(`not an owner/name repo: ${repo}`);
  return `/repos/${repo}`;
}

function int(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not a valid number: ${n}`);
  return n;
}
