/**
 * The one way `nod serve` talks to GitHub: GraphQL and REST over `fetch`
 * with the user's `gh` token. `fetch` is injectable, so everything built on
 * it runs against fixtures in the tests.
 *
 * - The token goes into the `authorization` header and nowhere else: never
 *   into a URL, a log line or an error message (it is scrubbed from GitHub's
 *   messages too).
 * - Rate limits surface as {@link RateLimited}, with the time GitHub said
 *   to come back (`retry-after`, `x-ratelimit-reset`) when it said one. The
 *   GraphQL budget left is kept in {@link GitHubApi.budget}.
 */

export const GITHUB_API = "https://api.github.com";

/** A failed call. `status` 0: the request never got an answer. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** GitHub asked us to slow down (primary or secondary rate limit). */
export class RateLimited extends GitHubApiError {
  constructor(
    /** When GitHub said to come back (epoch ms); null when it did not say. */
    readonly until: number | null,
    message: string,
  ) {
    super(429, message);
    this.name = "RateLimited";
  }
}

export interface GitHubApiOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly apiUrl?: string;
  /** Epoch ms now; for `retry-after`. */
  readonly now?: () => number;
  /** Per request (default 30 s). */
  readonly timeoutMs?: number;
}

export interface RestResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
}

/** What the last GraphQL answer said about the budget. */
export interface Budget {
  readonly cost: number;
  readonly remaining: number;
  readonly limit: number;
  /** Epoch ms. */
  readonly resetAt: number;
}

export class GitHubApi {
  private readonly doFetch: typeof fetch;
  private readonly apiUrl: string;
  private readonly now: () => number;
  /** The GraphQL budget after the last query that asked for `rateLimit`. */
  budget: Budget | null = null;
  /** GraphQL queries and REST calls sent, and the GraphQL points spent (`NOD_DEBUG=1`). */
  calls = { graphql: 0, rest: 0, cost: 0 };

  constructor(private readonly options: GitHubApiOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.apiUrl = (options.apiUrl ?? GITHUB_API).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
  }

  /** One GraphQL query. Throws on transport errors, rate limits and any GraphQL error. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    this.calls.graphql++;
    const res = await this.send("POST", "/graphql", { query, variables });
    const json = (await this.json(res, "/graphql")) as {
      data?: T & {
        rateLimit?: { cost: number; remaining: number; limit: number; resetAt: string };
      };
      errors?: Array<{ type?: string; message?: string }>;
    };
    const errors = json.errors ?? [];
    if (errors.some((e) => e.type === "RATE_LIMITED"))
      throw new RateLimited(this.resetFrom(res.headers), "GitHub is rate-limiting nod.");
    if (errors.length || !json.data)
      throw new GitHubApiError(
        res.status,
        this.scrub(errors.map((e) => e.message ?? "GraphQL error").join("; ") || "no data"),
      );
    const rl = json.data.rateLimit;
    if (rl) this.calls.cost += rl.cost;
    if (rl)
      this.budget = {
        cost: rl.cost,
        remaining: rl.remaining,
        limit: rl.limit,
        resetAt: Date.parse(rl.resetAt),
      };
    return json.data;
  }

  /** One REST call; `path` starts with `/`. Throws `GitHubApiError` on a non-2xx answer. */
  async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<RestResponse<T>> {
    this.calls.rest++;
    const res = await this.send(method, path, body);
    const data = (await this.json(res, path)) as T;
    return { status: res.status, data, headers: res.headers };
  }

  private async send(method: string, path: string, body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "nod-serve",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new GitHubApiError(
        0,
        `GitHub did not answer: ${this.scrub(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      message = String((JSON.parse(text) as { message?: unknown }).message ?? message);
    } catch {
      // not JSON: keep the raw text
    }
    message = this.scrub(message);
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (/rate limit/i.test(message) || res.headers.get("x-ratelimit-remaining") === "0"));
    if (limited) throw new RateLimited(this.resetFrom(res.headers), "GitHub is rate-limiting nod.");
    throw new GitHubApiError(res.status, `GitHub ${res.status} on ${method} ${path}: ${message}`);
  }

  private async json(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GitHubApiError(res.status, `GitHub sent something that is not JSON for ${path}`);
    }
  }

  private resetFrom(headers: Headers): number | null {
    const after = Number(headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return this.now() + after * 1000;
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return reset * 1000;
    return null;
  }

  private scrub(message: string): string {
    return this.options.token ? message.replaceAll(this.options.token, "***") : message;
  }
}
