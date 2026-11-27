/**
 * The real `Source`: the repos of the user's list, on every GitHub host they
 * are on, through `gh`'s token for each host (ADR 0007).
 *
 * - **The list** is `$XDG_CONFIG_HOME/nod/config.json` (`config.ts`),
 *   managed with `nod repo add|remove|list` and the add, remove and suggest
 *   requests (#49's settings page). A change by another process (`nod repo
 *   add` while serving) is picked up before the next poll.
 * - **The clone override.** `--dir <clone>` (`--repo`, `--host`), or no flag
 *   and an empty list in a clone: the one repo of that clone, read as
 *   before; the list is never written then.
 * - **Repos** (`github/repo.ts`): each keeps its cache and builds its rows.
 *   **Hosts** (`github/host.ts`): each has its own token, `GitHubApi`, login
 *   and rate limit, and polls all of its repos with one GraphQL query. A
 *   token goes to its own host only (`fetchWithToken`).
 * - **Clones.** Patch-ids come from the `--dir` clone, or from nod's own
 *   blobless bare clone under `$XDG_CACHE_HOME/nod/clones/<host>/<owner>/<repo>.git`,
 *   made on the first patch-id (`github/clone.ts`). Removing a repo leaves
 *   its clone: a cache, deleted by hand.
 * - **The login** (`account`, `gh()`): the account of the first repo's host
 *   (github.com without a repo) through `gh`'s token there. A missing `gh`,
 *   a host `gh` is not logged in to, or a GitHub that does not answer is
 *   asked again every `GH_RETRY_MS` (and on `check-github`), never kept as
 *   "not logged in": a service that starts before the network or the
 *   keyring, or a `gh auth login` made meanwhile, needs no restart. Each
 *   change is logged once and pushed as `account`.
 * - **Pushes.** `repos` when the list or my login on a repo's host changed
 *   (before the `prs` that follows it), `prs` only when the user's view
 *   changed, `setup` and `enrolment` when a repo's setup or my enrolment did.
 *
 * No state beyond the cache and the list: everything shared lives in GitHub.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { GITHUB_COM, githubHost, type GitHubHost } from "../kit/host.ts";
import {
  GH_RETRY_MS,
  type Account,
  type Enrolment,
  type GhLogin,
  type Person,
  type PrLink,
  type RepoKey,
  type RepoList,
  type RepoName,
  type RepoSuggestion,
  type SetupStatus,
  type Snapshot,
  type SyncStatus,
} from "../shared/protocol";
import { parseRepoInput, repoKey, sameRepo } from "../shared/repo-key";
import type { Clock, Timer } from "./clock";
import {
  addConfigRepo,
  cacheDir as defaultCacheDir,
  ConfigError,
  configStamp,
  defaultConfigFile,
  keyOf,
  readConfig,
  removeConfigRepo,
  type ConfigRepo,
} from "./config";
import { gitEnv } from "../kit/patch-id.ts";
import { GitHubApi, GitHubApiError } from "./github/api";
import { findGh, ghToken as askGh, isToken, type GhFailure } from "./github/gh";
import {
  CloneError,
  OwnClone,
  clonePatchIds,
  ownClonePath,
  ownClonePatchIds,
  resolveClone,
  type PatchIds,
} from "./github/clone";
import { DEFAULT_POLL_MS, HostPoller } from "./github/host";
import { GitHubRepo, message, type RepoOptions } from "./github/repo";
import type { InboxSubject } from "./inbox/service";
import { openSetupPrWithInit } from "./github/setup-pr";
import { rankSuggestions, resolveRepo, suggestOnHost } from "./github/suggest";
import {
  SourceError,
  type PostApprovalsInput,
  type PostNodInput,
  type PostResult,
  type SignTarget,
  type Source,
  type SourceChange,
  type SourceRepo,
} from "./source";

export { DEFAULT_POLL_MS, FAST_FOR_MS, FAST_POLL_MS } from "./github/host";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** Merged and closed PRs stay in the snapshot this long. */
export const KEEP_CLOSED_MS = 14 * DAY;

/** A repo the source reads: where it is, and how its patch-ids and setup PR are made. */
export interface RepoSpec {
  readonly host: GitHubHost;
  /** `owner/name`. */
  readonly name: RepoName;
}

export interface GitHubSourceOptions {
  readonly clock: Clock;
  /** The repos at the start, in order. */
  readonly repos: ReadonlyArray<RepoSpec>;
  /**
   * The API for a host, or why there is none (null: `gh` is not logged in
   * there). An API is kept; a failure is asked again later (`force`: now,
   * past any cache of the token).
   */
  readonly api: (
    host: GitHubHost,
    options: { readonly force: boolean },
  ) => GitHubApi | GhFailure | null;
  /** The `gh` nod serve runs, for what `gh()` says (default: none named). */
  readonly ghPath?: () => string | null;
  /** This nod serve is the background service (`NOD_SERVICE=1`): `GhLogin.service`. */
  readonly service?: boolean;
  /** A repo's patch-ids, setup PR and commit identity. */
  readonly repoOptions: (spec: RepoSpec) => Omit<RepoOptions, "name">;
  /**
   * The list's file: `addRepo` and `removeRepo` write it, and a change to it
   * is read before each poll. null: the clone override (`clone`), and the
   * list is never touched.
   */
  readonly configFile: string | null;
  /** The clone override: the folder it serves. */
  readonly clone?: { readonly dir: string } | null;
  /** The local signer's public key, if there is one: for the enrolment and what I can sign. */
  readonly myKey?: () => string | null;
  readonly pollMs?: number;
  readonly fastMs?: number;
  readonly fastForMs?: number;
  readonly keepClosedMs?: number;
  readonly log?: (line: string) => void;
  /** Log one line per poll and host: queries, REST calls, GraphQL cost, time (`NOD_DEBUG=1`). */
  readonly debug?: boolean;
}

interface Entry {
  readonly spec: RepoSpec;
  readonly repo: GitHubRepo;
}

export class GitHubSource implements Source {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private entries: Entry[] = [];
  private readonly hosts = new Map<string, HostPoller>();
  private readonly apis = new Map<string, GitHubApi>();
  /** Why a host has no API, from the last ask. */
  private readonly failures = new Map<string, GhFailure>();
  /** Hosts whose token GitHub refused: the next ask goes past the token's cache. */
  private readonly refused = new Set<string>();
  private readonly accounts = new Map<string, Account>();
  private login: GhLogin | null = null;
  private loginTimer: Timer | null = null;
  private readonly listeners = new Set<(change: SourceChange) => void>();
  private readonly last = { repos: "", prs: "", setup: "", enrolment: "" };
  private stamp: number | null = null;
  private configTimer: Timer | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly options: GitHubSourceOptions) {
    this.clock = options.clock;
    this.log = options.log ?? ((line) => console.error(line));
    for (const spec of options.repos) this.addEntry(spec);
    if (options.configFile) this.stamp = configStamp(options.configFile);
  }

  /** Start polling: every host's first read now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const host of this.hosts.values()) host.start();
    // The hosts look at the file before each poll; this also covers a list with no host yet.
    if (this.options.configFile)
      this.configTimer = this.clock.every(this.options.pollMs ?? DEFAULT_POLL_MS, () =>
        this.syncConfig(),
      );
    // Not signed in (no gh, no login, GitHub not reachable yet): look again.
    this.loginTimer = this.clock.every(GH_RETRY_MS, () => {
      if (!this.signedIn()) void this.account();
    });
  }

  /** Resolves once every host's first poll ended, well or not. */
  get ready(): Promise<void> {
    return Promise.all([...this.hosts.values()].map((h) => h.ready)).then(() => {});
  }

  /** Whether this is the clone override (`--dir`): the list is not used. */
  get cloneMode(): boolean {
    return this.options.configFile === null;
  }

  /** `fixed` for the clone override, else the config file's list (`managed`). */
  get repoList(): RepoList {
    return this.cloneMode ? "fixed" : "managed";
  }

  // -- the repos and hosts ------------------------------------------------------

  private apiFor(host: GitHubHost, force = false): GitHubApi | null {
    const had = this.apis.get(host.name);
    if (had) return had;
    const got = this.options.api(host, { force: force || this.refused.has(host.name) });
    // Past the cache once: later asks wait their turn (GH_RETRY_MS) again.
    this.refused.delete(host.name);
    if (got instanceof GitHubApi) {
      this.apis.set(host.name, got);
      this.failures.delete(host.name);
      return got;
    }
    this.failures.set(host.name, got ?? { state: "signed-out", path: null, detail: null });
    return null;
  }

  private hostFor(host: GitHubHost): HostPoller {
    let poller = this.hosts.get(host.name);
    if (!poller) {
      poller = new HostPoller({
        clock: this.clock,
        host,
        api: () => this.apiFor(host),
        repos: () => this.entries.filter((e) => e.spec.host.name === host.name).map((e) => e.repo),
        beforePoll: () => this.syncConfig(),
        polled: () => this.rebuild(host.name),
        log: this.log,
        ...(this.options.pollMs !== undefined && { pollMs: this.options.pollMs }),
        ...(this.options.fastMs !== undefined && { fastMs: this.options.fastMs }),
        ...(this.options.fastForMs !== undefined && { fastForMs: this.options.fastForMs }),
        ...(this.options.debug !== undefined && { debug: this.options.debug }),
      });
      this.hosts.set(host.name, poller);
    }
    return poller;
  }

  private addEntry(spec: RepoSpec): Entry {
    const poller = this.hostFor(spec.host);
    const repo = new GitHubRepo(
      {
        clock: this.clock,
        host: spec.host,
        api: () => poller.api,
        viewer: () => poller.viewer,
        myKey: () => this.options.myKey?.() ?? null,
        changed: () => this.emitChanges(),
        poke: () => poller.poke(),
        keepClosedMs: this.options.keepClosedMs ?? KEEP_CLOSED_MS,
        log: this.log,
      },
      { name: spec.name, ...this.options.repoOptions(spec) },
    );
    const entry = { spec, repo };
    this.entries.push(entry);
    // A host new since the start polls now, with its repo in the list.
    if (this.started) poller.start();
    return entry;
  }

  private dropEntry(entry: Entry): void {
    entry.repo.stop();
    this.entries = this.entries.filter((e) => e !== entry);
    const host = entry.spec.host.name;
    if (!this.entries.some((e) => e.spec.host.name === host)) {
      this.hosts.get(host)?.stop();
      this.hosts.delete(host);
    }
  }

  private find(key: RepoKey): Entry | null {
    return this.entries.find((e) => sameRepo(e.repo.key(), key)) ?? null;
  }

  /** The repo of a key; throws `not-found` for one it does not read. */
  private need(key: RepoKey): Entry {
    const hit = this.find(key);
    if (!hit) throw new SourceError("not-found", `nod serve does not read ${key}.`);
    return hit;
  }

  /**
   * A repo as the session sees it. `login` is mine on its host, from the
   * host's last poll (null before it): logins differ between hosts (a
   * managed user on GHE.com is `mara_acme`), so a nod's `reviewer` and the
   * "your own PR" check use the repo's, not `welcome.me` (ADR 0007, 8).
   */
  private sourceRepo(e: Entry): SourceRepo {
    return {
      key: e.repo.key(),
      name: e.repo.name(),
      github: e.repo.github(),
      login: this.hosts.get(e.spec.host.name)?.viewer?.login ?? null,
    };
  }

  repos(): ReadonlyArray<SourceRepo> {
    return this.entries.map((e) => this.sourceRepo(e));
  }

  /**
   * The list in the config file changed under us (`nod repo add` in another
   * terminal): take its repos, in its order, keeping what is read already.
   */
  private syncConfig(): void {
    const file = this.options.configFile;
    if (!file || this.stopped) return;
    const stamp = configStamp(file);
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const read = readConfig(file);
    if (read.unreadable) {
      this.log(`nod serve: ${read.unreadable}`);
      return;
    }
    for (const s of read.skipped) this.log(`nod serve: ${file}: skipped an entry, ${s}`);
    const wanted = read.repos.map((r) => ({ r, key: keyOf(r) }));
    let changed = false;
    const listed = (e: Entry) =>
      wanted.findIndex((w) => sameRepo(w.key, e.repo.key()) || sameRepo(w.key, keyOf(specOf(e))));
    for (const e of [...this.entries]) {
      if (listed(e) >= 0) continue;
      this.dropEntry(e);
      changed = true;
    }
    for (const { r } of wanted)
      if (!this.find(keyOf(r))) {
        this.addEntry({ host: githubHost(r.host), name: r.repo });
        changed = true;
      }
    const sorted = [...this.entries].sort((a, b) => listed(a) - listed(b));
    if (sorted.some((e, i) => e !== this.entries[i])) changed = true;
    this.entries = sorted;
    if (changed) {
      this.log(
        `nod serve: the repo list changed: ${this.entries.map((e) => e.repo.key()).join(", ") || "none"}`,
      );
      this.listChanged();
    }
  }

  /** The list changed: every host with repos polls, and the tabs hear of it. */
  private listChanged(): void {
    for (const host of this.hosts.values()) host.poke();
    this.emitChanges();
    // The first repo's host may be another one now: its account.
    if (!this.signedIn()) void this.account();
  }

  // -- Source: reading ------------------------------------------------------

  /** The host of the account: the first repo's, github.com without a repo. */
  private accountHost(): GitHubHost {
    return this.entries[0]?.spec.host ?? githubHost(GITHUB_COM);
  }

  private signedIn(): boolean {
    return this.accounts.has(this.accountHost().name);
  }

  /**
   * The account of the first repo's host (github.com without a repo); null
   * while there is none, and then `gh()` says why. Kept once read; a
   * failure is not: the next call asks again (`force`: past the token's
   * cache, for "Try again").
   */
  async account(options: { readonly force?: boolean } = {}): Promise<Account | null> {
    const host = this.accountHost();
    const path = () => this.options.ghPath?.() ?? null;
    const had = this.accounts.get(host.name);
    if (had) {
      this.setLogin({ host: host.name, state: "signed-in", path: path(), detail: null });
      return had;
    }
    const api = this.apiFor(host, options.force ?? false);
    if (!api) {
      const why = this.failures.get(host.name)!;
      this.setLogin({ host: host.name, ...why });
      return null;
    }
    try {
      const r = await api.rest<{ login: string; name: string | null }>("GET", "/user");
      const scopes = (r.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const account = { login: r.data.login, name: r.data.name ?? null, scopes };
      this.accounts.set(host.name, account);
      this.setLogin({ host: host.name, state: "signed-in", path: path(), detail: null });
      // Hosts that waited for a login read now.
      for (const poller of this.hosts.values())
        if (poller.sync.at === null && poller.sync.error && poller.api) void poller.refresh();
      return account;
    } catch (error) {
      // A token GitHub refuses (expired, revoked): ask gh again next time, it may have a new one.
      const refused = error instanceof GitHubApiError && error.status === 401;
      if (refused) {
        this.apis.delete(host.name);
        this.refused.add(host.name);
      }
      this.setLogin({
        host: host.name,
        state: refused ? "signed-out" : "unreachable",
        path: path(),
        detail: refused ? `GitHub refused gh's token for ${host.name}` : message(error),
      });
      return null;
    }
  }

  /** What this nod serve sees of `gh` and the login (`welcome.gh`). */
  gh(): GhLogin {
    return (
      this.login ?? {
        host: this.accountHost().name,
        state: "unreachable",
        path: this.options.ghPath?.() ?? null,
        detail: "not checked yet",
        checkedAt: null,
        service: this.options.service ?? false,
      }
    );
  }

  /** A new look at the login: logged once per change, pushed as `account`. */
  private setLogin(next: Omit<GhLogin, "checkedAt" | "service">): void {
    const before = this.login;
    this.login = { ...next, checkedAt: this.clock.now(), service: this.options.service ?? false };
    const same =
      before !== null &&
      before.host === next.host &&
      before.state === next.state &&
      before.path === next.path &&
      before.detail === next.detail;
    if (same || this.stopped) return;
    this.log(`nod serve: ${loginLine(this.login)}`);
    for (const listener of this.listeners) listener("account");
  }

  snapshot(): Snapshot | null {
    const read = this.entries.filter((e) => this.hosts.get(e.spec.host.name)?.viewer);
    if (!read.length) return null;
    const first = this.entries[0]!;
    const me =
      this.hosts.get(first.spec.host.name)?.viewer?.login ??
      this.hosts.get(read[0]!.spec.host.name)!.viewer!.login;
    const people = this.people();
    const now = this.clock.now();
    return {
      me,
      people,
      prs: read.flatMap((e) => e.repo.views(now, people)),
      unclassified: read.flatMap((e) => e.repo.unclassified()),
      sync: this.sync(),
    };
  }

  /**
   * One status for all hosts and repos (ADR 0007, 5): the oldest successful
   * read, every failing host's and repo's message (each names its host or
   * repo), and the latest time a rate-limited host reads again.
   */
  private sync(): SyncStatus {
    const hosts = [...this.hosts.values()];
    const many = hosts.length > 1;
    const ats = hosts.map((h) => h.sync.at).filter((a): a is number => a !== null);
    const errors: string[] = [];
    for (const h of hosts)
      if (h.sync.error)
        errors.push(
          many && !h.sync.error.includes(h.host.name)
            ? `${h.host.name}: ${h.sync.error}`
            : h.sync.error,
        );
    for (const e of this.entries)
      if (e.repo.error && !this.hosts.get(e.spec.host.name)?.sync.error) errors.push(e.repo.error);
    const limited = hosts.filter((h) => h.sync.rateLimit);
    const until = limited.some((h) => h.sync.rateLimit!.until === null)
      ? null
      : Math.max(...limited.map((h) => h.sync.rateLimit!.until!));
    return {
      at: ats.length ? Math.min(...ats) : null,
      error: errors.length ? errors.join(" ") : null,
      ...(limited.length && { rateLimit: { until } }),
    };
  }

  private people(): Person[] {
    const out = new Map<string, Person>();
    const add = (login: string | undefined | null, name: string | null | undefined) => {
      if (!login) return;
      const k = login.toLowerCase();
      const had = out.get(k);
      if (!had || (!had.name && name)) out.set(k, { login, name: name ?? null });
    };
    for (const h of this.hosts.values()) if (h.viewer) add(h.viewer.login, h.viewer.name);
    for (const e of this.entries) e.repo.people(add);
    return [...out.values()];
  }

  async refresh(): Promise<void> {
    this.syncConfig();
    await Promise.all([...this.hosts.values()].map((h) => h.refresh()));
  }

  async signTarget(repo: RepoKey, pr: number): Promise<SignTarget | null> {
    return this.need(repo).repo.signTarget(pr);
  }

  /** My inbox's view of an open PR (ADR 0009), from its repo's clone. */
  async inboxSubject(repo: RepoKey, pr: number): Promise<InboxSubject | null> {
    return this.need(repo).repo.inboxSubject(pr);
  }

  // -- Source: writing ------------------------------------------------------

  async postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>> {
    const hit = this.find(input.repo);
    if (!hit)
      return input.payload.entries.map((e) => ({
        pr: e.pr,
        ok: false,
        url: null,
        message: `nod serve does not read ${input.repo}.`,
      }));
    return hit.repo.postNod(input);
  }

  async postApprovals(input: PostApprovalsInput): Promise<ReadonlyArray<PostResult>> {
    const hit = this.find(input.repo);
    if (!hit)
      return input.entries.map((e) => ({
        pr: e.pr,
        ok: false,
        url: null,
        message: `nod serve does not read ${input.repo}.`,
      }));
    return hit.repo.postApprovals(input);
  }

  async ackFyi(repo: RepoKey, pr: number): Promise<void> {
    return this.need(repo).repo.ackFyi(pr);
  }

  async setup(repo: RepoKey): Promise<SetupStatus> {
    const e = this.need(repo);
    await this.hosts.get(e.spec.host.name)?.ready;
    return e.repo.setup();
  }

  async openSetupPr(repo: RepoKey, publicKey: string | null): Promise<PrLink> {
    const e = this.need(repo);
    await this.hosts.get(e.spec.host.name)?.ready;
    return e.repo.openSetupPr(publicKey);
  }

  async openEnrolPr(repo: RepoKey, publicKey: string): Promise<PrLink> {
    const e = this.need(repo);
    await this.hosts.get(e.spec.host.name)?.ready;
    return e.repo.openEnrolPr(publicKey);
  }

  enrolment(repo: RepoKey, publicKey: string): Enrolment {
    return this.need(repo).repo.enrolmentOf(publicKey);
  }

  keyCreated(_publicKey: string): void {
    for (const e of this.entries) e.repo.rebuild();
    this.emitChanges();
  }

  // -- the list: add, remove, suggest (#49's settings page) ---------------------

  /**
   * Adds a repo to the list: `owner/name`, `host/owner/name` or a GitHub URL.
   * GitHub must know it and let this account read it (`not-found`); `gh`
   * must be logged in to its host (`forbidden`). A repo listed already is
   * returned as it is. Writes the config; the clone comes with the first
   * patch-id; a poll of its host follows.
   */
  async addRepo(input: string): Promise<SourceRepo> {
    const file = this.options.configFile;
    if (!file)
      throw new SourceError(
        "forbidden",
        `nod serve reads only the clone in ${this.options.clone?.dir ?? "its folder"} (--dir, or started in a clone with no repo list). To read more repositories, add them with \`nod repo add\` and start nod serve without --dir, outside a clone.`,
      );
    const parsed = parseRepoInput(input);
    if (!parsed)
      throw new SourceError(
        "bad-request",
        `"${input}" is not a repository: use owner/name, host/owner/name or its GitHub URL.`,
      );
    const listed = this.find(repoKey(parsed.host, parsed.name));
    if (listed) return this.sourceRepo(listed);
    const host = githubHost(parsed.host);
    const name = await resolveRepo(this.apiFor(host), host, parsed.name);
    const again = this.find(repoKey(host.name, name));
    if (again) return this.sourceRepo(again);
    try {
      addConfigRepo(file, { host: host.name, repo: name });
    } catch (error) {
      throw new SourceError(
        "forbidden",
        error instanceof ConfigError ? error.message : message(error),
      );
    }
    this.stamp = configStamp(file);
    const entry = this.addEntry({ host, name });
    this.log(`nod serve: added ${entry.repo.key()}`);
    this.listChanged();
    return this.sourceRepo(entry);
  }

  /** Takes a repo off the list. Its clone stays in the cache. */
  async removeRepo(repo: RepoKey): Promise<void> {
    const file = this.options.configFile;
    if (!file)
      throw new SourceError(
        "forbidden",
        `nod serve reads only the clone in ${this.options.clone?.dir ?? "its folder"}; there is no list to remove ${repo} from.`,
      );
    const entry = this.need(repo);
    try {
      removeConfigRepo(file, keyOf(specOf(entry)));
      if (!sameRepo(entry.repo.key(), keyOf(specOf(entry))))
        removeConfigRepo(file, entry.repo.key());
    } catch (error) {
      throw new SourceError(
        "forbidden",
        error instanceof ConfigError ? error.message : message(error),
      );
    }
    this.stamp = configStamp(file);
    this.dropEntry(entry);
    this.log(`nod serve: removed ${entry.repo.key()}`);
    this.listChanged();
  }

  /**
   * Repos where I have open PRs or review requests, on every host I am
   * logged in to (the list's hosts and github.com), without those listed:
   * the most review requests first, then my PRs. A host that fails is
   * left out (and logged). Nothing in the clone override: it cannot add.
   */
  async suggestRepos(): Promise<ReadonlyArray<RepoSuggestion>> {
    if (this.cloneMode) return [];
    const hosts = new Map<string, GitHubHost>([[GITHUB_COM, githubHost(GITHUB_COM)]]);
    for (const e of this.entries) hosts.set(e.spec.host.name, e.spec.host);
    const found = await Promise.all(
      [...hosts.values()].map(async (host) => {
        const api = this.apiFor(host);
        if (!api) return [];
        try {
          return await suggestOnHost(
            api,
            (key) => this.find(key) !== null,
            (name) => repoKey(host.name, name),
          );
        } catch (error) {
          this.log(`nod serve: suggesting repos on ${host.name} failed: ${message(error)}`);
          return [];
        }
      }),
    );
    return rankSuggestions(found.flat());
  }

  subscribe(listener: (change: SourceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
    this.configTimer?.clear();
    this.loginTimer?.clear();
    for (const h of this.hosts.values()) h.stop();
    for (const e of this.entries) e.repo.stop();
    this.listeners.clear();
  }

  /** Poll fast for a while: the user just acted. */
  poke(): void {
    for (const h of this.hosts.values()) h.poke();
  }

  // -- pushes -----------------------------------------------------------------

  private rebuild(host: string): void {
    if (this.stopped) return;
    for (const e of this.entries) if (e.spec.host.name === host) e.repo.rebuild();
    this.emitChanges();
    // A poll that read GitHub: the account can be read too, if it was not.
    if (!this.signedIn() && this.hosts.get(host)?.viewer) void this.account();
  }

  private emitChanges() {
    if (this.stopped) return;
    const snapshot = this.snapshot();
    const { at: _at, ...sync } = this.sync();
    const prs = JSON.stringify({
      prs: snapshot?.prs ?? null,
      u: snapshot?.unclassified ?? null,
      sync,
    });
    const repos = JSON.stringify(this.repos().map((r) => [r.key, r.login]));
    const setup = JSON.stringify(this.entries.map((e) => [e.repo.key(), e.repo.setupNow()]));
    const key = this.options.myKey?.() ?? null;
    const enrolment = JSON.stringify(key ? this.entries.map((e) => e.repo.enrolmentOf(key)) : null);
    const changed: SourceChange[] = [];
    // The list first: a tab learns of a repo before it sees its PRs.
    if (repos !== this.last.repos) changed.push("repos");
    if (prs !== this.last.prs) changed.push("prs");
    if (setup !== this.last.setup) changed.push("setup");
    if (enrolment !== this.last.enrolment) changed.push("enrolment");
    Object.assign(this.last, { repos, prs, setup, enrolment });
    for (const change of changed) for (const listener of this.listeners) listener(change);
  }
}

const specOf = (e: Entry): ConfigRepo => ({ host: e.spec.host.name, repo: e.spec.name });

/** The log line of a login state: what the journal of a service shows. */
export function loginLine(login: GhLogin): string {
  const via = login.path ? ` (${login.path})` : "";
  const said = login.detail ? `: ${login.detail}` : "";
  const again = `; nod serve checks again every ${GH_RETRY_MS / 1000} s`;
  switch (login.state) {
    case "signed-in":
      return `signed in to ${login.host} through gh${via}`;
    case "no-gh":
      return `no gh on nod serve's PATH (${process.env.PATH ?? "no PATH"})${said}: nod reads GitHub through gh's login${login.service ? "; run `nod service install` again in a terminal where gh works" : ""}${again}`;
    case "signed-out":
      return `gh${via} is not logged in to ${login.host}${said}${login.service ? "; the service has its own environment: run `nod service install` again in a terminal where gh works" : ""}${again}`;
    case "unreachable":
      return `could not reach GitHub on ${login.host}${said}${again}`;
  }
}

// ---------------------------------------------------------------------------
// putting it together for `nod serve`

export interface GithubSourceSetup {
  readonly clock: Clock;
  /** `--repo`: `owner/name` of the clone's remote; null: its `origin`. */
  readonly repo: string | null;
  /** `--host`: the GitHub host; null: the remote's. */
  readonly host?: string | null;
  /** `--dir`: the clone to serve; null/undefined: none given. */
  readonly dir?: string | null;
  /** The folder `nod serve` starts in (default: the current one). */
  readonly cwd?: string;
  /** The repo list (default `$XDG_CONFIG_HOME/nod/config.json`). */
  readonly configFile?: string;
  /** nod's cache, its clones under `clones/` (default `$XDG_CACHE_HOME/nod`). */
  readonly cacheDir?: string;
  /** The CLI's version, for the setup PR's kit pin. */
  readonly version?: string;
  readonly pollMs?: number;
  readonly myKey?: () => string | null;
  /**
   * Test seams: a host's token (or why there is none), its `fetch`, the
   * clone's patch-ids, where nod clones from, the environment `gh` runs in.
   */
  readonly token?: (host: string) => string | GhFailure | null;
  readonly fetch?: (host: GitHubHost) => typeof fetch;
  readonly patchIds?: PatchIds;
  readonly cloneUrl?: (host: GitHubHost, name: string) => string;
  readonly log?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The token `gh` holds for `host` (`gh auth token --hostname <host>`); null
 * when it is not logged in there (`github/gh.ts` says why). Never logged.
 */
export function ghToken(host: string): string | null {
  const r = askGh(host);
  return isToken(r) ? r.token : null;
}

/** The commit identity (`user.name`, `user.email`) git would use in `dir`. */
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

/** Whether `dir` is inside a git work tree (a clone, perhaps of something else). */
function inWorkTree(dir: string): boolean {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(),
  });
  return r.exitCode === 0 && r.stdout.toString().trim() === "true";
}

/**
 * The GitHub source for `nod serve`, in one of two modes (ADR 0007, 2):
 *
 * - **the clone override**: `--dir` (or `--repo`/`--host`), or no flag, an
 *   empty list and a start inside a clone: that clone's repo, its host from
 *   the remote, patch-ids in it, the setup PR from it. Throws `CloneError`
 *   with a sentence for the user when the folder is not a usable clone;
 * - **the list**: every repo of `config.json`, nod's own clones; none at all
 *   outside a clone with an empty list (the web app offers to add one).
 */
export function githubSource(setup: GithubSourceSetup): GitHubSource {
  const log = setup.log ?? ((line: string) => console.error(line));
  const cwd = resolve(setup.cwd ?? process.cwd());
  const configFile = setup.configFile ?? defaultConfigFile();
  const cache = setup.cacheDir ?? defaultCacheDir();
  const env = setup.env ?? process.env;
  // A token is kept; no token is asked again after GH_RETRY_MS (or at once, `force`).
  const tokens = new Map<string, string>();
  const failed = new Map<string, { at: number; why: GhFailure }>();
  const ask = (host: string): string | GhFailure => {
    if (setup.token) return setup.token(host) ?? { state: "signed-out", path: null, detail: null };
    const r = askGh(host, env);
    return isToken(r) ? r.token : r;
  };
  const tokenResult = (host: string, force = false): string | GhFailure => {
    if (!force && tokens.has(host)) return tokens.get(host)!;
    const last = failed.get(host);
    if (!force && last && setup.clock.now() - last.at < GH_RETRY_MS) return last.why;
    const r = ask(host);
    if (typeof r === "string") {
      tokens.set(host, r);
      failed.delete(host);
    } else {
      tokens.delete(host);
      failed.set(host, { at: setup.clock.now(), why: r });
    }
    return r;
  };
  const tokenOf = (host: string): string | null => {
    const r = tokenResult(host);
    return typeof r === "string" ? r : null;
  };
  const api = (host: GitHubHost, { force }: { readonly force: boolean }) => {
    const token = tokenResult(host.name, force);
    return typeof token === "string"
      ? new GitHubApi({
          token,
          host,
          now: () => setup.clock.now(),
          ...(setup.fetch && { fetch: setup.fetch(host) }),
        })
      : token;
  };
  const common = {
    clock: setup.clock,
    api,
    ghPath: () => (setup.token ? null : findGh(env)),
    service: env.NOD_SERVICE === "1",
    log,
    ...(setup.myKey && { myKey: setup.myKey }),
    ...(setup.pollMs !== undefined && { pollMs: setup.pollMs }),
    debug: process.env.NOD_DEBUG === "1",
  };
  const version = setup.version ?? "0.0.0-development";

  const explicit = setup.dir != null || setup.repo != null || setup.host != null;
  const config = explicit ? null : readConfig(configFile);
  if (config?.unreadable) log(`nod serve: ${config.unreadable}`);
  for (const s of config?.skipped ?? []) log(`nod serve: ${configFile}: skipped an entry, ${s}`);

  if (explicit || (config!.repos.length === 0 && !config!.unreadable && inWorkTree(cwd))) {
    const clone = resolveClone(resolve(cwd, setup.dir ?? "."), setup.repo, setup.host ?? null);
    const source = new GitHubSource({
      ...common,
      repos: [{ host: clone.host, name: clone.repo }],
      configFile: null,
      clone: { dir: clone.dir },
      repoOptions: () => ({
        patchIds: setup.patchIds ?? clonePatchIds(clone, () => tokenOf(clone.host.name)),
        identity: () => gitIdentity(clone.dir),
        openSetupPr: ({ login, publicKey }) =>
          openSetupPrWithInit({
            dir: clone.dir,
            repo: clone.repo,
            host: clone.host.name,
            login,
            publicKey,
            version,
          }),
      }),
    });
    source.start();
    return source;
  }

  const repos: RepoSpec[] = [];
  for (const r of config!.repos) {
    try {
      repos.push({ host: githubHost(r.host), name: r.repo });
    } catch (error) {
      log(`nod serve: ${configFile}: skipped ${keyOf(r)}: ${message(error)}`);
    }
  }
  const source = new GitHubSource({
    ...common,
    repos,
    configFile,
    repoOptions: ({ host, name }) => {
      const clone = new OwnClone({
        dir: ownClonePath(cache, host.name, name),
        host,
        name,
        token: () => tokenOf(host.name),
        ...(setup.cloneUrl && { url: setup.cloneUrl(host, name) }),
      });
      return {
        patchIds: setup.patchIds ?? ownClonePatchIds(clone, host),
        identity: () => gitIdentity(existsSync(clone.dir) ? clone.dir : cwd),
        openSetupPr: async ({ login, publicKey }) => {
          await clone.serial(async () => {});
          return openSetupPrWithInit({
            dir: clone.dir,
            repo: name,
            host: host.name,
            login,
            publicKey,
            version,
            gitAuth: clone.env(),
          });
        },
      };
    },
  });
  source.start();
  return source;
}

export { CloneError };
