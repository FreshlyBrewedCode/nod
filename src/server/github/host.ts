/**
 * One GitHub host of the source (ADR 0007, 4 and 5): its token's API, its
 * login, its rate limit, and its poll, **one GraphQL query for every repo of
 * the host** (a block per repo), plus one `Details` query when something new
 * needs it.
 *
 * - Up to {@link REPOS_PER_QUERY} repos share one query (GitHub's node limit).
 * - About every 60 s; every 5 s for two minutes after the user acts, so a
 *   nod's green check shows within seconds.
 * - A repo GitHub cannot read (gone, renamed away, no access) fails alone:
 *   its block comes back null with an error naming it, the other repos of the
 *   host read as usual, and it keeps what it showed.
 * - The budget is read on every poll; a rate limit (primary or secondary)
 *   pauses this host until GitHub says, or backs off, and shows as
 *   `sync.rateLimit`, not as an error. Other hosts poll on.
 */

import { ghLoginCommand, type GitHubHost } from "../../kit/host.ts";
import { GH_RETRY_MS, type SyncStatus } from "../../shared/protocol";
import type { Clock, Timer } from "../clock";
import { GitHubApiError, RateLimited, type GitHubApi, type GraphQLError } from "./api";
import {
  PAGE,
  detailsQuery,
  pollQuery,
  type DetailsData,
  type PageData,
  type PollData,
  type RawPr,
} from "./queries";
import { message, type DetailsAsk, type GitHubRepo } from "./repo";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const DEFAULT_POLL_MS = 60 * SECOND;
/** After the user acts: poll this often… */
export const FAST_POLL_MS = 5 * SECOND;
/** …for this long. */
export const FAST_FOR_MS = 2 * MINUTE;
/**
 * The most repos in one poll query: each repo's block asks for up to ~20,000
 * nodes (50 PRs with their files, checks, comments and timeline) and GitHub
 * refuses a query of more than 500,000. A host with more repos takes one
 * more query per this many.
 */
export const REPOS_PER_QUERY = 10;
/** The longest wait between two tries after errors. */
const MAX_BACKOFF_MS = 15 * MINUTE;

export interface HostOptions {
  readonly clock: Clock;
  readonly host: GitHubHost;
  /**
   * The host's API now; null: `gh` is not logged in to this host (or not
   * found). It then reads nothing, says so, and asks again every
   * `GH_RETRY_MS`: a login made meanwhile is picked up without a restart.
   */
  readonly api: () => GitHubApi | null;
  /** The source's repos on this host, in the list's order, now. */
  readonly repos: () => ReadonlyArray<GitHubRepo>;
  /** Before each poll: the source looks at its config file. */
  readonly beforePoll?: () => void;
  /** A poll ended (well or not): the source rebuilds and pushes. */
  readonly polled: () => void;
  readonly pollMs?: number;
  readonly fastMs?: number;
  readonly fastForMs?: number;
  readonly log: (line: string) => void;
  /** One line per poll: queries, REST calls, GraphQL cost, time (`NOD_DEBUG=1`). */
  readonly debug?: boolean;
}

export class HostPoller {
  readonly host: GitHubHost;
  /** The host's account, from the last poll. */
  viewer: { login: string; name: string | null } | null = null;
  sync: SyncStatus = { at: null, error: null };
  private readonly pollMs: number;
  private readonly fastMs: number;
  private readonly fastForMs: number;
  private timer: Timer | null = null;
  private polling: Promise<void> | null = null;
  private again = false;
  private fastUntil = -Infinity;
  private failures = 0;
  private started = false;
  private stopped = false;
  private markReady!: () => void;
  /** Resolves once the first poll ended, well or not. */
  readonly ready: Promise<void>;

  constructor(private readonly options: HostOptions) {
    this.host = options.host;
    const api = options.api();
    if (api && api.host.name !== options.host.name)
      throw new Error(`the API is bound to ${api.host.name}, not ${options.host.name}`);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.fastMs = options.fastMs ?? FAST_POLL_MS;
    this.fastForMs = options.fastForMs ?? FAST_FOR_MS;
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    if (!api) {
      this.sync = { at: null, error: this.noLogin() };
      this.markReady();
    }
  }

  /** The API now: a login made since the last look counts (`HostOptions.api`). */
  get api(): GitHubApi | null {
    const api = this.options.api();
    if (api && api.host.name !== this.host.name)
      throw new Error(`the API is bound to ${api.host.name}, not ${this.host.name}`);
    return api;
  }

  private noLogin(): string {
    return `\`gh\` is not logged in to ${this.host.name}. Run \`${ghLoginCommand(this.host.name)}\`; nod serve checks again by itself.`;
  }

  /** Start polling: the first read now. Again after a stop: nothing. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.api) this.options.log(`nod serve: ${this.sync.error ?? this.noLogin()}`);
    void this.tick();
  }

  get running(): boolean {
    return this.started && !this.stopped;
  }

  /** Read now (after the poll that is running, if one is). */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.polling) await this.polling;
    await this.tick();
  }

  /** Poll fast for a while: the user just acted. */
  poke(): void {
    if (!this.api || this.stopped) return;
    this.fastUntil = this.options.clock.now() + this.fastForMs;
    if (this.sync.rateLimit) return;
    if (this.polling) this.again = true;
    else this.schedule(Math.min(this.fastMs, 2 * SECOND));
  }

  stop(): void {
    this.stopped = true;
    this.timer?.clear();
    this.timer = null;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer?.clear();
    this.timer = this.options.clock.after(Math.max(0, delay), () => void this.tick());
  }

  private tick(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.timer?.clear();
    this.timer = null;
    const clock = this.options.clock;
    const api = this.api;
    if (!api) {
      // Not logged in (yet): nothing to read; look for a login again later.
      const error = this.noLogin();
      const changed = this.sync.error !== error;
      this.sync = { at: this.sync.at, error };
      if (changed) this.options.polled();
      this.markReady();
      this.schedule(GH_RETRY_MS);
      return Promise.resolve();
    }
    const run = (async () => {
      let delay: number;
      const started = { at: Date.now(), ...api.calls };
      try {
        this.options.beforePoll?.();
        const repos = this.options.repos();
        await this.read(repos);
        if (this.options.debug) {
          const { graphql, rest, cost } = api.calls;
          const open = repos.reduce((n, r) => n + r.openCount, 0);
          this.options.log(
            `nod serve: poll ${this.host.name}: ${graphql - started.graphql} GraphQL (cost ${cost - started.cost}, ${api.budget?.remaining ?? "?"} left), ${rest - started.rest} REST, ${Date.now() - started.at} ms, ${repos.length} ${repos.length === 1 ? "repo" : "repos"}, ${open} open`,
          );
        }
        this.failures = 0;
        this.sync = { at: clock.now(), error: null };
        delay = clock.now() < this.fastUntil ? this.fastMs : this.pollMs;
        const budget = api.budget;
        // Leave room for the user's own `gh` work: stop well before the budget is gone.
        if (budget && budget.remaining < Math.max(50, budget.cost * 10)) {
          this.sync = { ...this.sync, rateLimit: { until: budget.resetAt } };
          delay = Math.max(budget.resetAt - clock.now(), 30 * SECOND);
        }
      } catch (error) {
        this.failures++;
        const backoff = Math.min(MAX_BACKOFF_MS, 30 * SECOND * 2 ** (this.failures - 1));
        if (error instanceof RateLimited) {
          this.sync = { ...this.sync, error: null, rateLimit: { until: error.until } };
          delay = error.until !== null ? Math.max(error.until - clock.now(), 5 * SECOND) : backoff;
        } else {
          const text = message(error);
          // The terminal hears of each new problem once; the snapshot always says it.
          if (text !== this.sync.error)
            this.options.log(
              `nod serve: reading GitHub on ${this.host.name} failed: ${error instanceof GitHubApiError ? text : error instanceof Error ? error.stack : text}`,
            );
          this.sync = { at: this.sync.at, error: text };
          delay = backoff;
        }
      } finally {
        this.polling = null;
      }
      this.options.polled();
      this.markReady();
      if (this.again) {
        this.again = false;
        if (!this.sync.rateLimit && !this.sync.error) delay = Math.min(delay, this.fastMs);
      }
      this.schedule(delay);
    })();
    this.polling = run;
    return run;
  }

  /** One poll: every repo's PR list in one query, then whatever details are new. */
  private async read(repos: ReadonlyArray<GitHubRepo>): Promise<void> {
    const api = this.api!;
    if (!repos.length) return;
    for (let from = 0; from < repos.length; from += REPOS_PER_QUERY)
      await this.readList(repos.slice(from, from + REPOS_PER_QUERY));

    for (let round = 0; round < 3; round++) {
      // At most as many repos as a poll query holds; the others in the next round.
      const wanted = repos
        .map((repo) => ({ repo, ask: repo.detailsWanted() }))
        .filter((w): w is { repo: GitHubRepo; ask: DetailsAsk } => w.ask !== null)
        .slice(0, REPOS_PER_QUERY);
      if (!wanted.length) break;
      const details = detailsQuery({
        repos: wanted.map(({ repo, ask }) => ({ ...repo.parts(), ...ask })),
        checkRuns: wanted.flatMap(({ ask }) => ask.checkRuns.map((r) => r.id)),
      });
      // In part: a repo whose block fails finds nothing this round, the others go on.
      const { data: d } = await api.graphqlPartial<DetailsData>(details.query, details.variables);
      const texts = new Map(
        (d.texts ?? [])
          .filter((t): t is NonNullable<typeof t> => !!t && typeof t.databaseId === "number")
          .map((t) => [t.databaseId!, t.text ?? null] as const),
      );
      for (const [j, { repo, ask }] of wanted.entries())
        repo.details(ask, d[`d${j}`] ?? null, texts);
    }

    for (const repo of repos) await repo.commit();
  }

  /** The poll query for up to {@link REPOS_PER_QUERY} repos, and each repo's further pages. */
  private async readList(repos: ReadonlyArray<GitHubRepo>): Promise<void> {
    const api = this.api!;
    const { query, variables } = pollQuery(repos.map((r) => r.parts()));
    const { data, errors, status } = await api.graphqlPartial<PollData>(query, variables);
    const general = errors.filter((e) => blockOf(e) === null);
    if (general.length || !data.viewer)
      throw new GitHubApiError(
        status,
        general.map((e) => e.message ?? "GraphQL error").join("; ") || "no viewer",
      );
    this.viewer = data.viewer;

    for (const [i, repo] of repos.entries()) {
      const raw = data[`r${i}`];
      if (!raw) {
        const why = errors.find((e) => blockOf(e)?.block === `r${i}`);
        repo.failed(
          why?.type === "NOT_FOUND" || !why
            ? `${repo.name()} was not found on ${this.host.name}, or this gh account cannot read it.`
            : (why.message ?? "GraphQL error"),
        );
        continue;
      }
      const open = raw.open.nodes.filter((n): n is RawPr => n !== null);
      let page = raw.open.pageInfo;
      try {
        for (let n = 1; n < 10 && page.hasNextPage && page.endCursor; n++) {
          const next: PageData = await api.graphql<PageData>(PAGE, {
            ...repo.parts(),
            after: page.endCursor,
          });
          if (!next.repository) break;
          open.push(...next.repository.open.nodes.filter((p): p is RawPr => p !== null));
          page = next.repository.open.pageInfo;
        }
      } catch (error) {
        if (error instanceof RateLimited) throw error;
        repo.failed(message(error));
        continue;
      }
      const requested = (data[`q${i}`]?.nodes ?? [])
        .map((n) => n?.number)
        .filter((n): n is number => typeof n === "number");
      repo.takePoll({ repo: raw, open, requested });
    }
  }
}

/** The repo block an error is about (`r1`, `q1`, `d1`); null: about the whole query. */
function blockOf(error: GraphQLError): { block: string } | null {
  const first = error.path?.[0];
  return typeof first === "string" && /^[rqd]\d+$/.test(first) ? { block: first } : null;
}
