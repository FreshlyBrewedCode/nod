/**
 * The real `Source`: one GitHub repo through the user's `gh` token.
 *
 * - **Reading.** GraphQL about every 60 s (faster for two minutes after the
 *   user acts, so a nod's green check shows within seconds): the open PRs
 *   and those merged or closed in the last 14 days, their checks, comments,
 *   👀 reactions and timeline (`github/queries.ts`). The verifier's summary
 *   is the `text` of the `nod` check run on each head, fetched once per
 *   check run id and cached. `github/map.ts` turns each PR into `PrFacts`;
 *   `view.ts` makes them relative to me.
 * - **The inbox step.** A repo without nod's setup on its default branch
 *   has no verifier: each PR without a summary is classified here, with the
 *   kit's built-in classifiers on what GraphQL returned (`github/local.ts`,
 *   display only), and "needs me" is GitHub's review requests (teams
 *   included, from the poll's search) and my own stuck PRs.
 * - **The host.** github.com, `<name>.ghe.com` or a GitHub Enterprise
 *   Server: read once from the clone's remote (`--host` overrides it), and
 *   every URL derives from it (`kit/host.ts`). The token is `gh`'s for that
 *   host and the API sends it there only.
 * - **The clone.** `nod serve` runs in a clone of the repo. Patch-ids are
 *   computed there (ADR 0001 rule 6), from objects fetched into
 *   `refs/nod/base`; the working tree and the user's branches are never
 *   touched (`github/clone.ts`).
 * - **Writing.** Nod comments (the same body on every PR of a batch), 👀 as
 *   the FYI ack, the enrolment PR (contents API) and the setup PR (`nod
 *   init` in a temporary worktree).
 * - **Limits.** The GraphQL budget is read on every poll; a rate limit
 *   (primary or secondary) pauses polling until GitHub says, or backs off,
 *   and shows as `sync.rateLimit`, not as an error.
 * - **Pushes.** A snapshot is pushed only when the user's view changed.
 *
 * No state beyond this cache: everything shared lives in GitHub.
 */

import { GITHUB_COM, ghLoginCommand, githubHost, type GitHubHost } from "../kit/host.ts";
import { decodeSummary, type CheckSummary } from "../kit/summary.ts";
import { enrolledLogins } from "../kit/sshsig.ts";
import type {
  Account,
  Enrolment,
  GitHubInfo,
  Person,
  PrLink,
  PrView,
  RepoChoice,
  RepoName,
  SetupStatus,
  Snapshot,
  SyncStatus,
  UnclassifiedPr,
} from "../shared/protocol";
import type { Clock, Timer } from "./clock";
import { GitHubApi, GitHubApiError, RateLimited } from "./github/api";
import { parseBody } from "./github/brief";
import { clonePatchIds, resolveClone, type PatchIds } from "./github/clone";
import { classifyLocally } from "./github/local";
import { mapPr, nodCheckRun, type SummaryRead } from "./github/map";
import {
  POLL,
  SIGN_TARGET,
  detailsQuery,
  requestedQuery,
  type DetailsData,
  type PollData,
  type RawPr,
} from "./github/queries";
import {
  SETUP_BRANCH,
  SIGNERS_PATH,
  enrolmentOf,
  isSetUp,
  openEnrolPr,
  requiresNodCheck,
  setupStatusOf,
} from "./github/setup";
import { openSetupPrWithInit } from "./github/setup-pr";
import { isPlanRefusal } from "../init/ruleset.ts";
import type { PolicyResult } from "../kit/policy.ts";
import { publicKeyId } from "./signer/ssh-wire";
import {
  SourceError,
  type PostNodInput,
  type PostResult,
  type SignTarget,
  type Source,
  type SourceChange,
} from "./source";
import { sameLogin, toViews, type PrFacts } from "./view";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export const DEFAULT_POLL_MS = 60 * SECOND;
/** After the user acts: poll this often… */
export const FAST_POLL_MS = 5 * SECOND;
/** …for this long. */
export const FAST_FOR_MS = 2 * MINUTE;
/** Merged and closed PRs stay in the snapshot this long. */
export const KEEP_CLOSED_MS = 14 * DAY;
/** The longest wait between two tries after errors. */
const MAX_BACKOFF_MS = 15 * MINUTE;

type RepoInfo = Omit<NonNullable<PollData["repository"]>, "open" | "closed">;

export interface GitHubSourceOptions {
  readonly clock: Clock;
  /** `owner/name`. */
  readonly repo: RepoName;
  /** The host the repo is on (default github.com); `api` must be bound to the same one. */
  readonly host?: GitHubHost;
  /** null: `gh` is not logged in; the source shows that and reads nothing. */
  readonly api: GitHubApi | null;
  /** null: no clone, so no patch-ids (nothing can be signed). */
  readonly patchIds: PatchIds | null;
  /** The clone's root, for messages. */
  readonly dir?: string | null;
  /** The local signer's public key, if there is one: for the enrolment and what I can sign. */
  readonly myKey?: () => string | null;
  readonly pollMs?: number;
  readonly fastMs?: number;
  readonly fastForMs?: number;
  readonly keepClosedMs?: number;
  /** The git identity for the enrolment commit; null: GitHub's default for the token. */
  readonly identity?: { readonly name: string; readonly email: string } | null;
  /** Opens the setup PR (`nod init`); resolves to its URL. */
  readonly openSetupPr?: (input: { login: string; publicKey: string }) => Promise<string>;
  readonly log?: (line: string) => void;
  /** Log one line per poll: queries, REST calls, GraphQL cost, time (`NOD_DEBUG=1`). */
  readonly debug?: boolean;
}

export class GitHubSource implements Source {
  private readonly clock: Clock;
  private readonly api: GitHubApi | null;
  private readonly host: GitHubHost;
  private readonly owner: string;
  private readonly name: string;
  private readonly pollMs: number;
  private readonly fastMs: number;
  private readonly fastForMs: number;
  private readonly keepClosedMs: number;
  private readonly log: (line: string) => void;

  private viewer: { login: string; name: string | null } | null = null;
  private info: RepoInfo | null = null;
  private open: RawPr[] = [];
  /** Merged or closed in the window, newest first. */
  private recent: number[] = [];
  private readonly closed = new Map<number, { updatedAt: string; raw: RawPr | null }>();
  /** The verifier's summary by check run id; null: that run's text holds none. */
  private readonly summaries = new Map<number, CheckSummary | null>();
  private readonly epicTitles = new Map<number, string>();
  /** `.nod/allowed_signers` at an open PR's head, by head SHA. */
  private readonly headSigners = new Map<string, string | null>();
  private readonly patchIds = new Map<string, string>();
  private readonly patchFailed = new Map<string, number>();
  private readonly patchRunning = new Set<string>();
  /** Open PRs whose review is requested from me, perhaps through a team (the poll's search). */
  private requestedOfMe = new Set<number>();
  /** The inbox step's own classification, by PR number; empty once the repo is set up. */
  private local = new Map<number, PolicyResult>();

  private facts: PrFacts[] = [];
  /** Open PRs without a summary: shown with no slot, waiting on the verifier. */
  private noSummary = new Set<number>();
  private unclassified: UnclassifiedPr[] = [];
  private sync: SyncStatus = { at: null, error: null };
  private requiresNod: boolean | null = null;
  private rulesRefused = false;
  private rulesAt = -Infinity;
  private rulesRead: Promise<void> | null = null;
  private setupPrLink: PrLink | null = null;
  private enrolPr: { pr: PrLink; key: string } | null = null;
  private accountCache: Account | null | undefined;

  private readonly listeners = new Set<(change: SourceChange) => void>();
  private readonly last = { prs: "", setup: "", enrolment: "" };
  private timer: Timer | null = null;
  private polling: Promise<void> | null = null;
  private again = false;
  private fastUntil = -Infinity;
  private failures = 0;
  private stopped = false;
  private markReady!: () => void;
  /** Resolves once the first poll ended, well or not. */
  readonly ready: Promise<void>;

  constructor(private readonly options: GitHubSourceOptions) {
    this.clock = options.clock;
    this.api = options.api;
    this.host = options.host ?? options.api?.host ?? githubHost(GITHUB_COM);
    if (options.api && options.api.host.name !== this.host.name)
      throw new Error(`the API is bound to ${options.api.host.name}, not ${this.host.name}`);
    [this.owner, this.name] = options.repo.split("/") as [string, string];
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.fastMs = options.fastMs ?? FAST_POLL_MS;
    this.fastForMs = options.fastForMs ?? FAST_FOR_MS;
    this.keepClosedMs = options.keepClosedMs ?? KEEP_CLOSED_MS;
    this.log = options.log ?? ((line) => console.error(line));
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    if (!this.api) {
      this.sync = {
        at: null,
        error: `\`gh\` is not logged in to ${this.host.name}. Run \`${ghLoginCommand(this.host.name)}\`, then restart nod serve.`,
      };
      this.log(`nod serve: ${this.sync.error}`);
      this.markReady();
    }
  }

  /** Start polling: the first read now. */
  start(): void {
    if (this.api) void this.tick();
  }

  // -- Source: reading ------------------------------------------------------

  async account(): Promise<Account | null> {
    if (this.accountCache !== undefined) return this.accountCache;
    if (!this.api) return null;
    try {
      const r = await this.api.rest<{ login: string; name: string | null }>("GET", "/user");
      const scopes = (r.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      this.accountCache = { login: r.data.login, name: r.data.name ?? null, scopes };
      return this.accountCache;
    } catch (error) {
      this.log(`nod serve: reading the gh account failed: ${message(error)}`);
      return null;
    }
  }

  async listRepos(): Promise<ReadonlyArray<RepoChoice>> {
    await this.ready;
    const permission = this.info?.viewerPermission ?? null;
    return [
      {
        repo: this.info?.nameWithOwner ?? this.options.repo,
        current: true,
        canWrite: permission === "ADMIN" || permission === "MAINTAIN" || permission === "WRITE",
        pushedAt: ms(this.info?.pushedAt ?? null),
      },
    ];
  }

  repo(): RepoName {
    return this.info?.nameWithOwner ?? this.options.repo;
  }

  github(): GitHubInfo {
    return { host: this.host.name, webUrl: this.host.webUrl };
  }

  async pickRepo(repo: RepoName): Promise<void> {
    if (sameLogin(repo, this.repo())) return;
    throw new SourceError(
      "forbidden",
      `nod serve reads ${this.repo()} only, the repository of ${this.options.dir ?? "its folder"}. To use ${repo}, start nod serve in a clone of it.`,
    );
  }

  snapshot(): Snapshot | null {
    if (!this.viewer) return null;
    return {
      repo: this.repo(),
      me: this.viewer.login,
      people: this.people(),
      prs: this.views(this.clock.now()),
      unclassified: this.unclassified,
      sync: this.sync,
    };
  }

  async refresh(): Promise<void> {
    if (!this.api) return;
    if (this.polling) await this.polling;
    await this.tick();
  }

  async signTarget(pr: number): Promise<SignTarget | null> {
    if (!this.api) throw new SourceError("github", "`gh` is not logged in.");
    const data = await this.api.graphql<{
      repository: {
        pullRequest: {
          number: number;
          state: string;
          isDraft: boolean;
          merged: boolean;
          baseRefName: string;
          headRefOid: string;
        } | null;
      } | null;
    }>(SIGN_TARGET, { owner: this.owner, name: this.name, number: pr });
    const p = data.repository?.pullRequest;
    if (!p) return null;
    const state =
      p.merged || p.state === "MERGED"
        ? "merged"
        : p.state === "CLOSED"
          ? "closed"
          : p.isDraft
            ? "draft"
            : "open";
    let patchId: string | null = null;
    if (state === "open" && this.options.patchIds) {
      try {
        // Fresh, against the base branch as it is now.
        patchId = await this.options.patchIds.compute({
          base: p.baseRefName,
          headSha: p.headRefOid,
        });
        this.patchIds.set(patchKey(p.baseRefName, p.headRefOid), patchId);
      } catch (error) {
        this.log(`nod serve: the patch-id of #${pr} failed: ${message(error)}`);
      }
    }
    return { pr, state, base: p.baseRefName, headSha: p.headRefOid, patchId };
  }

  // -- Source: writing ------------------------------------------------------

  async postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>> {
    const results: PostResult[] = [];
    for (const entry of input.payload.entries) {
      if (!this.api || !sameLogin(input.payload.repo, this.repo())) {
        results.push({ pr: entry.pr, ok: false, url: null, message: `Not ${this.repo()}.` });
        continue;
      }
      try {
        const r = await this.api.rest<{ html_url: string }>(
          "POST",
          `/repos/${this.repo()}/issues/${entry.pr}/comments`,
          { body: input.body },
        );
        results.push({ pr: entry.pr, ok: true, url: r.data.html_url, message: null });
      } catch (error) {
        results.push({
          pr: entry.pr,
          ok: false,
          url: null,
          message: `Posting on #${entry.pr} failed: ${message(error)}. Retrying posts the same comment.`,
        });
      }
    }
    this.poke();
    return results;
  }

  async ackFyi(pr: number): Promise<void> {
    const f = this.facts.find((x) => x.number === pr);
    if (!f?.fyi) throw new SourceError("not-found", `#${pr} has no FYI.`);
    if (!this.api || !this.viewer) throw new SourceError("github", "`gh` is not logged in.");
    const me = this.viewer;
    if (f.fyi.acked.some((l) => sameLogin(l, me.login))) return;
    await this.api
      .rest("POST", `/repos/${this.repo()}/issues/${pr}/reactions`, { content: "eyes" })
      .catch((error: unknown) => {
        throw new SourceError("github", `Acking #${pr} failed: ${message(error)}`);
      });
    // Shown at once; the next poll confirms it.
    const ack = {
      createdAt: new Date(this.clock.now()).toISOString(),
      user: { login: me.login, name: me.name },
    };
    const add = (raw: RawPr): RawPr => ({
      ...raw,
      reactions: { nodes: [...raw.reactions.nodes, ack] },
    });
    this.open = this.open.map((r) => (r.number === pr ? add(r) : r));
    const c = this.closed.get(pr);
    if (c?.raw) this.closed.set(pr, { ...c, raw: add(c.raw) });
    this.rebuild();
    this.poke();
  }

  async setup(): Promise<SetupStatus> {
    await this.ready;
    await this.readRules(60 * SECOND);
    return this.setupNow();
  }

  async openSetupPr(publicKey: string | null): Promise<PrLink> {
    const status = await this.setup();
    if (status.state === "ready")
      throw new SourceError("already-set-up", `${this.repo()} is set up already.`);
    if (status.setupPr) return status.setupPr;
    if (!publicKey)
      throw new SourceError(
        "no-key",
        "Create your signing key first: the setup PR enrols it as the first signer.",
      );
    if (!this.viewer || !this.options.openSetupPr)
      throw new SourceError("github", "`gh` is not logged in.");
    let url: string;
    try {
      url = await this.options.openSetupPr({ login: this.viewer.login, publicKey });
    } catch (error) {
      throw new SourceError("github", `Opening the setup PR failed: ${message(error)}`);
    }
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    this.setupPrLink = { number, url };
    this.emitChanges();
    this.poke();
    return this.setupPrLink;
  }

  async openEnrolPr(publicKey: string): Promise<PrLink> {
    await this.ready;
    const branch = this.info?.defaultBranchRef?.name;
    if (!this.api || !this.viewer || !branch)
      throw new SourceError("no-repo", `${this.repo()} could not be read.`);
    if (!this.info?.signers)
      throw new SourceError(
        "github",
        `${this.repo()} is not set up yet: the setup PR enrols the first key.`,
      );
    const current = this.enrolment(publicKey);
    if (current.state === "active")
      throw new SourceError("already-enrolled", "Your key is enrolled already.");
    if (current.state === "pending" && current.pr) return current.pr;
    let pr: PrLink;
    try {
      pr = await openEnrolPr(this.api, {
        repo: this.repo(),
        defaultBranch: branch,
        login: this.viewer.login,
        publicKey,
        identity: this.options.identity ?? null,
      });
    } catch (error) {
      throw new SourceError("github", `Opening the enrolment PR failed: ${message(error)}`);
    }
    this.enrolPr = { pr, key: publicKeyId(publicKey) };
    this.emitChanges();
    this.poke();
    return pr;
  }

  enrolment(publicKey: string): Enrolment {
    const candidates: Array<{ pr: PrLink; text: string }> = [];
    for (const raw of this.open) {
      const text = this.headSigners.get(raw.headRefOid);
      if (text) candidates.push({ pr: { number: raw.number, url: raw.url }, text });
    }
    const e = enrolmentOf({
      publicKey,
      me: this.viewer?.login ?? null,
      signers: this.info?.signers?.text ?? null,
      candidates,
    });
    // Opened just now, not polled yet.
    if (
      e.state === "not-enrolled" &&
      this.enrolPr?.key === publicKeyId(publicKey) &&
      !this.recent.includes(this.enrolPr.pr.number)
    )
      return { state: "pending", pr: this.enrolPr.pr };
    return e;
  }

  keyCreated(_publicKey: string): void {
    this.rebuild();
  }

  subscribe(listener: (change: SourceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.clear();
    this.timer = null;
    this.listeners.clear();
  }

  /** Poll fast for a while: the user just acted. */
  poke(): void {
    this.fastUntil = this.clock.now() + this.fastForMs;
    if (this.sync.rateLimit) return;
    if (this.polling) this.again = true;
    else this.schedule(Math.min(this.fastMs, 2 * SECOND));
  }

  // -- polling ----------------------------------------------------------------

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer?.clear();
    this.timer = this.clock.after(Math.max(0, delay), () => void this.tick());
  }

  private tick(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.timer?.clear();
    this.timer = null;
    const run = (async () => {
      let delay: number;
      const started = { at: Date.now(), ...this.api!.calls };
      try {
        await this.read();
        if (this.options.debug) {
          const { graphql, rest, cost } = this.api!.calls;
          this.log(
            `nod serve: poll: ${graphql - started.graphql} GraphQL (cost ${cost - started.cost}, ${this.api!.budget?.remaining ?? "?"} left), ${rest - started.rest} REST, ${Date.now() - started.at} ms, ${this.open.length} open`,
          );
        }
        this.failures = 0;
        this.sync = { at: this.clock.now(), error: null };
        delay = this.clock.now() < this.fastUntil ? this.fastMs : this.pollMs;
        const budget = this.api?.budget;
        // Leave room for the user's own `gh` work: stop well before the budget is gone.
        if (budget && budget.remaining < Math.max(50, budget.cost * 10)) {
          this.sync = { ...this.sync, rateLimit: { until: budget.resetAt } };
          delay = Math.max(budget.resetAt - this.clock.now(), 30 * SECOND);
        }
      } catch (error) {
        this.failures++;
        const backoff = Math.min(MAX_BACKOFF_MS, 30 * SECOND * 2 ** (this.failures - 1));
        if (error instanceof RateLimited) {
          this.sync = { ...this.sync, error: null, rateLimit: { until: error.until } };
          delay =
            error.until !== null ? Math.max(error.until - this.clock.now(), 5 * SECOND) : backoff;
        } else {
          const text = message(error);
          // The terminal hears of each new problem once; the snapshot always says it.
          if (text !== this.sync.error)
            this.log(
              `nod serve: reading GitHub failed: ${error instanceof GitHubApiError ? text : error instanceof Error ? error.stack : text}`,
            );
          this.sync = { at: this.sync.at, error: text };
          delay = backoff;
        }
      } finally {
        this.polling = null;
      }
      this.rebuild();
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

  /** One poll: the PR list, then whatever details are new. */
  private async read(): Promise<void> {
    const api = this.api!;
    const open: RawPr[] = [];
    let first: PollData | null = null;
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: PollData = await api.graphql<PollData>(POLL, {
        owner: this.owner,
        name: this.name,
        after,
        requested: requestedQuery(this.owner, this.name),
      });
      if (!data.repository)
        throw new GitHubApiError(
          404,
          `${this.repo()} was not found, or this gh account cannot read it.`,
        );
      first ??= data;
      open.push(...data.repository.open.nodes.filter((n): n is RawPr => n !== null));
      if (!data.repository.open.pageInfo.hasNextPage) break;
      after = data.repository.open.pageInfo.endCursor;
    }
    const { open: _o, closed, ...info } = first!.repository!;
    const cutoff = this.clock.now() - this.keepClosedMs;
    const recent = (closed?.nodes ?? []).filter(
      (c): c is NonNullable<typeof c> => c !== null && (ms(c.closedAt) ?? 0) >= cutoff,
    );

    for (let round = 0; round < 3; round++) {
      const prs = recent
        .filter((c) => this.closed.get(c.number)?.updatedAt !== c.updatedAt)
        .map((c) => c.number)
        .slice(0, 20);
      const raws = [
        ...open,
        ...recent.map((c) => this.closed.get(c.number)?.raw).filter((r): r is RawPr => !!r),
      ];
      const runs = raws
        .map((r) => nodCheckRun(r))
        .filter((r): r is NonNullable<typeof r> => r !== null && !this.summaries.has(r.databaseId))
        .slice(0, 50);
      const issues = [
        ...new Set(
          raws
            .map((r) => parseBody(r.body).epic)
            .filter((n): n is number => n !== null && !this.epicTitles.has(n)),
        ),
      ].slice(0, 20);
      const blobs = open
        .filter(
          (r) =>
            (r.files?.nodes ?? []).some((f) => f.path === SIGNERS_PATH) &&
            !this.headSigners.has(r.headRefOid),
        )
        .slice(0, 10)
        .map((r, i) => ({
          key: `signers${i}`,
          expression: `${r.headRefOid}:${SIGNERS_PATH}`,
          oid: r.headRefOid,
        }));
      if (!prs.length && !runs.length && !issues.length && !blobs.length) break;

      const data = await api.graphql<DetailsData>(
        detailsQuery({ prs, checkRuns: runs.map((r) => r.id), issues, blobs }),
        { owner: this.owner, name: this.name },
      );
      const repo = data.repository ?? {};
      for (const n of prs) {
        const raw = (repo[`pr${n}`] as RawPr | null | undefined) ?? null;
        this.closed.set(n, { updatedAt: recent.find((c) => c.number === n)!.updatedAt, raw });
      }
      for (const n of issues) {
        const hit = repo[`issue${n}`] as { title?: string } | null | undefined;
        this.epicTitles.set(n, hit?.title ?? `#${n}`);
      }
      for (const b of blobs) {
        const hit = repo[b.key] as { text?: string | null } | null | undefined;
        this.headSigners.set(b.oid, hit?.text ?? null);
      }
      const texts = new Map(
        (data.texts ?? [])
          .filter((t): t is NonNullable<typeof t> => !!t && typeof t.databaseId === "number")
          .map((t) => [t.databaseId!, t.text ?? null]),
      );
      for (const r of runs)
        this.summaries.set(r.databaseId, decodeSummary(texts.get(r.databaseId)));
    }

    // Forget what fell out of the window.
    const keep = new Set(recent.map((c) => c.number));
    for (const n of this.closed.keys()) if (!keep.has(n)) this.closed.delete(n);
    this.viewer = first!.viewer;
    this.info = info;
    this.open = open;
    this.recent = recent.map((c) => c.number);
    this.requestedOfMe = new Set(
      (first!.requested?.nodes ?? [])
        .map((n) => n?.number)
        .filter((n): n is number => typeof n === "number"),
    );
    this.local = await this.classifyInbox();
  }

  /**
   * The inbox step: every PR without a summary, classified by the kit's
   * built-ins on what GraphQL returned. Nothing once the repo is set up: the
   * verifier is the source then, and a PR it has not seen stays "not
   * classified yet".
   */
  private async classifyInbox(): Promise<Map<number, PolicyResult>> {
    const out = new Map<number, PolicyResult>();
    if (isSetUp(this.filesOnDefault())) return out;
    for (const raw of this.raws()) {
      if (this.summaryOf(raw).kind === "ok") continue;
      out.set(
        raw.number,
        await classifyLocally({
          repo: this.repo(),
          number: raw.number,
          title: raw.title,
          body: raw.body ?? "",
          author: raw.author?.login ?? "ghost",
          base: raw.baseRefName,
          headSha: raw.headRefOid,
          files: raw.files?.nodes ?? [],
          totalFiles: Math.max(raw.files?.totalCount ?? 0, raw.changedFiles),
        }),
      );
    }
    return out;
  }

  /** The open PRs, then the merged or closed ones of the window. */
  private raws(): RawPr[] {
    return [
      ...this.open,
      ...this.recent.map((n) => this.closed.get(n)?.raw).filter((r): r is RawPr => !!r),
    ];
  }

  /** Which of nod's files the default branch has; null before the first read. */
  private filesOnDefault() {
    const info = this.info;
    return info
      ? {
          policy: !!info.policy,
          verifier: !!info.verifier,
          workflow: !!info.workflow,
          signers: !!info.signers,
        }
      : null;
  }

  // -- building the view ------------------------------------------------------

  private summaryOf(raw: RawPr): SummaryRead {
    const run = nodCheckRun(raw);
    if (!run) return { kind: "none" };
    const summary = this.summaries.get(run.databaseId);
    if (summary === undefined) return { kind: "none" };
    // A summary for another PR or head is not this one's, whatever its check run says.
    if (
      !summary ||
      summary.pr !== raw.number ||
      summary.head_sha !== raw.headRefOid ||
      !sameLogin(summary.repo, this.repo())
    )
      return { kind: "unreadable", title: run.title };
    if (summary.base !== raw.baseRefName) return { kind: "outdated", summary };
    return { kind: "ok", summary };
  }

  private rebuild(): void {
    if (this.stopped) return;
    const me = this.viewer?.login ?? null;
    const signers = this.info?.signers?.text ?? "";
    const team = [...enrolledLogins(signers)];
    if (me && !team.some((l) => sameLogin(l, me))) team.push(me);
    const headBranches = new Map(this.open.map((r) => [r.headRefName, r.number] as const));
    const defaultBranch = this.info?.defaultBranchRef?.name ?? "main";
    const facts: PrFacts[] = [];
    const unclassified: UnclassifiedPr[] = [];
    const noSummary = new Set<number>();
    for (const raw of this.raws()) {
      const summary = this.summaryOf(raw);
      const local = summary.kind === "ok" ? null : (this.local.get(raw.number) ?? null);
      const isOpen = raw.state === "OPEN";
      const patchId = isOpen
        ? (this.patchIds.get(patchKey(raw.baseRefName, raw.headRefOid)) ?? null)
        : summary.kind === "ok"
          ? summary.summary.patch_id
          : null;
      const mapped = mapPr(raw, {
        repo: this.repo(),
        defaultBranch,
        summary,
        patchId,
        headBranches,
        epicTitles: this.epicTitles,
        team,
        me,
        local,
        reviewRequested: this.requestedOfMe.has(raw.number),
      });
      facts.push(mapped.facts);
      if (summary.kind !== "ok" && !local) noSummary.add(raw.number);
      if (isOpen && mapped.unclassified)
        unclassified.push({
          number: raw.number,
          title: raw.title,
          url: raw.url,
          reason: mapped.unclassified,
        });
    }
    this.facts = facts;
    this.unclassified = unclassified;
    this.noSummary = noSummary;
    this.computePatchIds();
    if (this.info?.defaultBranchRef && this.clock.now() - this.rulesAt > 10 * MINUTE)
      void this.readRules(10 * MINUTE).then(() => this.emitChanges());
    this.emitChanges();
  }

  private views(now: number): PrView[] {
    const me = this.viewer?.login ?? "";
    const key = this.options.myKey?.() ?? null;
    // ADR 0002: a pending key reads everything and signs nothing.
    const signable = key !== null && this.enrolment(key).state === "active";
    return toViews(this.facts, { me, now, people: this.people() }).map((v) => {
      let out = v;
      // Only an open PR is held back for the verifier; a merged or closed one is just history.
      if (this.noSummary.has(v.number) && (v.state === "open" || v.state === "draft")) {
        out = {
          ...out,
          requirement: { ...out.requirement, satisfied: false },
          ask: null,
          needsMe: false,
          waitingOn: [{ kind: "checks" }],
        };
      }
      // A locally classified PR has no ask: what it needs of me is a review on GitHub.
      if (!signable && out.ask) out = { ...out, ask: null, needsMe: false };
      return out;
    });
  }

  private people(): Person[] {
    const out = new Map<string, Person>();
    const add = (login: string | undefined | null, name: string | null | undefined) => {
      if (!login) return;
      const k = login.toLowerCase();
      const had = out.get(k);
      if (!had || (!had.name && name)) out.set(k, { login, name: name ?? null });
    };
    if (this.viewer) add(this.viewer.login, this.viewer.name);
    const raws = [...this.open, ...[...this.closed.values()].map((c) => c.raw)];
    for (const r of raws) {
      if (!r) continue;
      add(r.author?.login, r.author?.name);
      for (const x of r.reactions.nodes) add(x?.user?.login, x?.user?.name);
    }
    for (const l of enrolledLogins(this.info?.signers?.text ?? "")) add(l, null);
    return [...out.values()];
  }

  private setupNow(): SetupStatus {
    const info = this.info;
    const setupRaw = this.open.find((r) => r.headRefName === SETUP_BRANCH);
    const setupPr = setupRaw
      ? { number: setupRaw.number, url: setupRaw.url }
      : this.setupPrLink && !this.recent.includes(this.setupPrLink.number)
        ? this.setupPrLink
        : null;
    return setupStatusOf({
      repo: this.repo(),
      defaultBranch: info?.defaultBranchRef?.name ?? null,
      files: this.filesOnDefault(),
      requiresNod: this.requiresNod,
      rulesRefused: this.rulesRefused,
      autoMerge: info ? info.autoMergeAllowed : null,
      setupPr,
    });
  }

  /** Re-reads the default branch's rules when older than `maxAge`; one read at a time. */
  private readRules(maxAge: number): Promise<void> {
    const branch = this.info?.defaultBranchRef?.name;
    if (this.rulesRead) return this.rulesRead;
    if (!this.api || !branch || this.clock.now() - this.rulesAt < maxAge) return Promise.resolve();
    const api = this.api;
    this.rulesRead = (async () => {
      try {
        this.requiresNod = await requiresNodCheck(api, this.repo(), branch);
        this.rulesRefused = false;
        this.rulesAt = this.clock.now();
      } catch (error) {
        // The plan has no rulesets (a private repo on Free): say so, read again later.
        if (error instanceof GitHubApiError && isPlanRefusal(error.message)) {
          this.rulesRefused = true;
          this.rulesAt = this.clock.now();
          return;
        }
        // Unknown, not missing; tried again in a minute.
        this.rulesAt = this.clock.now() - 9 * MINUTE;
        if (!(error instanceof GitHubApiError))
          this.log(`nod serve: reading the rules failed: ${message(error)}`);
      } finally {
        this.rulesRead = null;
      }
    })();
    return this.rulesRead;
  }

  private computePatchIds() {
    const ids = this.options.patchIds;
    if (!ids) return;
    for (const raw of this.open) {
      const key = patchKey(raw.baseRefName, raw.headRefOid);
      const failed = this.patchFailed.get(key);
      if (
        this.patchIds.has(key) ||
        this.patchRunning.has(key) ||
        (failed !== undefined && this.clock.now() - failed < 5 * MINUTE)
      )
        continue;
      this.patchRunning.add(key);
      ids
        .compute({ base: raw.baseRefName, headSha: raw.headRefOid })
        .then(
          (id) => void this.patchIds.set(key, id),
          (error: unknown) => {
            this.patchFailed.set(key, this.clock.now());
            this.log(`nod serve: the patch-id of #${raw.number} failed: ${message(error)}`);
          },
        )
        .finally(() => {
          this.patchRunning.delete(key);
          this.rebuild();
        });
    }
  }

  private emitChanges() {
    if (this.stopped) return;
    const snapshot = this.snapshot();
    const { at: _at, ...sync } = this.sync;
    const prs = JSON.stringify({ prs: snapshot?.prs ?? null, u: this.unclassified, sync });
    const setup = JSON.stringify(this.setupNow());
    const key = this.options.myKey?.() ?? null;
    const enrolment = JSON.stringify(key ? this.enrolment(key) : null);
    const changed: SourceChange[] = [];
    if (prs !== this.last.prs) changed.push("prs");
    if (setup !== this.last.setup) changed.push("setup");
    if (enrolment !== this.last.enrolment) changed.push("enrolment");
    Object.assign(this.last, { prs, setup, enrolment });
    for (const change of changed) for (const listener of this.listeners) listener(change);
  }
}

const patchKey = (base: string, head: string) => `${base}\u0000${head}`;

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// putting it together for `nod serve`

export interface GithubSourceSetup {
  readonly clock: Clock;
  /** `owner/name`; null: the clone's `origin`. */
  readonly repo: string | null;
  /** The GitHub host; null: the remote's (`--host`, for an ssh alias). */
  readonly host?: string | null;
  /** The clone (default: the current folder). */
  readonly dir?: string;
  /** The CLI's version, for the setup PR's kit pin. */
  readonly version?: string;
  readonly pollMs?: number;
  readonly myKey?: () => string | null;
  /** Test seams. */
  readonly token?: string | null;
  readonly fetch?: typeof fetch;
  readonly patchIds?: PatchIds;
  readonly log?: (line: string) => void;
}

/**
 * The token `gh` holds for `host` (`gh auth token --hostname <host>`); null
 * when it is not logged in there. Never logged.
 */
export function ghToken(host: string): string | null {
  try {
    const r = Bun.spawnSync(["gh", "auth", "token", "--hostname", host], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const token = r.stdout.toString().trim();
    return r.exitCode === 0 && token ? token : null;
  } catch {
    return null;
  }
}

/** The clone's commit identity (`user.name`, `user.email`), as `git commit` would use it. */
function gitIdentity(dir: string): { name: string; email: string } | null {
  const get = (key: string) => {
    const r = Bun.spawnSync(["git", "-C", dir, "config", "--get", key], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  };
  const name = get("user.name");
  const email = get("user.email");
  return name && email ? { name, email } : null;
}

/**
 * The GitHub source for `nod serve`: the clone in `dir`, the repo it is a
 * clone of, the host of its remote and `gh`'s token for that host. Throws
 * `CloneError` with a sentence for the user when `dir` is not a clone of
 * the repo or its host cannot be told.
 */
export function githubSource(setup: GithubSourceSetup): GitHubSource {
  const clone = resolveClone(setup.dir ?? process.cwd(), setup.repo, setup.host ?? null);
  const token = setup.token !== undefined ? setup.token : ghToken(clone.host.name);
  const api = token
    ? new GitHubApi({
        token,
        host: clone.host,
        now: () => setup.clock.now(),
        ...(setup.fetch && { fetch: setup.fetch }),
      })
    : null;
  const source = new GitHubSource({
    clock: setup.clock,
    repo: clone.repo,
    host: clone.host,
    api,
    patchIds: setup.patchIds ?? clonePatchIds(clone, () => token),
    dir: clone.dir,
    ...(setup.log && { log: setup.log }),
    ...(setup.myKey && { myKey: setup.myKey }),
    ...(setup.pollMs !== undefined && { pollMs: setup.pollMs }),
    identity: gitIdentity(clone.dir),
    debug: process.env.NOD_DEBUG === "1",
    openSetupPr: ({ login, publicKey }) =>
      openSetupPrWithInit({
        dir: clone.dir,
        repo: clone.repo,
        host: clone.host.name,
        login,
        publicKey,
        version: setup.version ?? "0.0.0-development",
      }),
  });
  source.start();
  return source;
}
