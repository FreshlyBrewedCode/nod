/**
 * One repo of the GitHub source (ADR 0007, 8): what nod knows of it between
 * two polls, and everything that is about it alone. The host's poller
 * (`host.ts`) reads GitHub for all repos of a host at once and hands each
 * repo its part ({@link GitHubRepo.takePoll}, {@link GitHubRepo.details});
 * the source (`../github-source.ts`) puts the repos together.
 *
 * - **What it reads.** The open PRs and those merged or closed in the last
 *   14 days, their checks, comments, 👀 reactions and timeline. The
 *   verifier's summary is the `text` of the `nod` check run on each head,
 *   fetched once per check run id and cached. `map.ts` turns each PR into
 *   `PrFacts`; `view.ts` makes them relative to me (this host's login).
 * - **The inbox step.** A repo without nod's setup on its default branch
 *   has no verifier: each PR without a summary is classified here, with the
 *   kit's built-in classifiers on what GraphQL returned (`local.ts`, display
 *   only), and "needs me" is GitHub's review requests (teams included, from
 *   the poll's search) and my own stuck PRs.
 * - **Patch-ids** come from a clone (`clone.ts`): the user's (`--dir`) or
 *   nod's own; never the working tree, never the user's branches.
 * - **Writing.** Nod comments, approvals, 👀, the enrolment PR (contents
 *   API) and the setup PR (`nod init` in a temporary worktree).
 */

import type { GitHubHost } from "../../kit/host.ts";
import { decodeSummary, type CheckSummary } from "../../kit/summary.ts";
import { enrolledLogins } from "../../kit/sshsig.ts";
import type { PolicyResult } from "../../kit/policy.ts";
import { isPlanRefusal } from "../../init/ruleset.ts";
import type {
  Enrolment,
  GitHubInfo,
  Person,
  PrLink,
  PrView,
  RepoKey,
  RepoName,
  SetupStatus,
  UnclassifiedPr,
} from "../../shared/protocol";
import { repoKey, sameRepo } from "../../shared/repo-key";
import type { Clock } from "../clock";
import { publicKeyId } from "../signer/ssh-wire";
import {
  SourceError,
  type PostApprovalsInput,
  type PostNodInput,
  type PostResult,
  type SignTarget,
} from "../source";
import { sameLogin, toViews, type PrFacts } from "../view";
import { GitHubApiError, type GitHubApi } from "./api";
import { parseBody } from "./brief";
import type { PatchIds } from "./clone";
import type { InboxSubject } from "../inbox/service";
import { classifyLocally } from "./local";
import { mapPr, nodCheckRun, type SummaryRead } from "./map";
import {
  SIGN_TARGET,
  type DetailsRepo,
  type DetailsRepoData,
  type RawPr,
  type RawRepo,
} from "./queries";
import {
  SETUP_BRANCH,
  SIGNERS_PATH,
  enrolmentOf,
  isSetUp,
  openEnrolPr,
  requiresNodCheck,
  setupStatusOf,
} from "./setup";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

type Info = Omit<RawRepo, "open" | "closed">;

/** What a repo gets from its host: the API, the login, and a way to say it changed. */
export interface RepoContext {
  readonly clock: Clock;
  readonly host: GitHubHost;
  /** The host's API; null: `gh` is not logged in there. */
  api(): GitHubApi | null;
  /** The host's account, from its last poll. */
  viewer(): { readonly login: string; readonly name: string | null } | null;
  /** The local signer's public key, if there is one. */
  myKey(): string | null;
  /** Something the user sees changed: the source compares and pushes. */
  changed(): void;
  /** The user acted: poll this host fast for a while. */
  poke(): void;
  readonly keepClosedMs: number;
  readonly log: (line: string) => void;
}

export interface RepoOptions {
  /** `owner/name`, as configured (GitHub's spelling replaces it once read). */
  readonly name: RepoName;
  /** null: no clone, so no patch-ids (nothing can be signed). */
  readonly patchIds: PatchIds | null;
  /** The git identity for the enrolment commit; null: GitHub's default for the token. */
  readonly identity?: (() => { readonly name: string; readonly email: string } | null) | null;
  /** Opens the setup PR (`nod init`); resolves to its URL. */
  readonly openSetupPr?: (input: { login: string; publicKey: string | null }) => Promise<string>;
}

/** What a repo asks of the next `Details` query. */
export interface DetailsAsk extends Omit<DetailsRepo, "owner" | "name"> {
  /** `nod` check runs whose text is not cached: node id (to ask) and database id (the cache key). */
  readonly checkRuns: ReadonlyArray<{ readonly id: string; readonly databaseId: number }>;
}

/** The part of a poll that is one repo's. */
export interface RepoPoll {
  readonly repo: RawRepo;
  readonly open: ReadonlyArray<RawPr>;
  readonly requested: ReadonlyArray<number>;
}

export class GitHubRepo {
  private info: Info | null = null;
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
  private readonly patchFailed = new Map<number | string, number>();
  private readonly patchRunning = new Set<string>();
  /** Open PRs whose review is requested from me, perhaps through a team (the poll's search). */
  private requestedOfMe = new Set<number>();
  /** The inbox step's own classification, by PR number; empty once the repo is set up. */
  private local = new Map<number, PolicyResult>();

  private facts: PrFacts[] = [];
  /** Open PRs without a summary: shown with no slot, waiting on the verifier. */
  private noSummary = new Set<number>();
  private unclassifiedNow: Omit<UnclassifiedPr, "repo">[] = [];
  private requiresNod: boolean | null = null;
  private rulesRefused = false;
  private rulesAt = -Infinity;
  private rulesRead: Promise<void> | null = null;
  private setupPrLink: PrLink | null = null;
  private enrolPr: { pr: PrLink; key: string } | null = null;
  /** The last poll could not read this repo: why. Its last good read stays. */
  error: string | null = null;
  /** When it was last read well (epoch ms); null: never. */
  readAt: number | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: RepoContext,
    private readonly options: RepoOptions,
  ) {}

  // -- who it is ----------------------------------------------------------------

  /** `owner/name`, as GitHub spells it once read. */
  name(): RepoName {
    return this.info?.nameWithOwner ?? this.options.name;
  }

  /** The repo key (ADR 0007): `owner/name` on github.com, `host/owner/name` elsewhere. */
  key(): RepoKey {
    return repoKey(this.ctx.host.name, this.name());
  }

  github(): GitHubInfo {
    return { host: this.ctx.host.name, webUrl: this.ctx.host.webUrl };
  }

  /** `owner` and `name`, for the queries. */
  parts(): { owner: string; name: string } {
    const [owner, name] = this.name().split("/") as [string, string];
    return { owner, name };
  }

  /** Read at least once. */
  get read(): boolean {
    return this.info !== null;
  }

  canWrite(): boolean {
    const p = this.info?.viewerPermission ?? null;
    return p === "ADMIN" || p === "MAINTAIN" || p === "WRITE";
  }

  pushedAt(): number | null {
    return ms(this.info?.pushedAt ?? null);
  }

  stop(): void {
    this.stopped = true;
  }

  // -- reading (called by the host's poll) ---------------------------------------

  /**
   * The repo's part of a poll arrived. Kept aside until {@link commit}: the
   * details are read in between, so a half-read poll never shows.
   */
  private pending: { poll: RepoPoll; recent: RepoPoll["repo"]["closed"] } | null = null;

  takePoll(poll: RepoPoll): void {
    this.pending = { poll, recent: poll.repo.closed };
  }

  /** What the next `Details` query should fetch for this repo; null: nothing. */
  detailsWanted(): DetailsAsk | null {
    const p = this.pending;
    if (!p) return null;
    const cutoff = this.ctx.clock.now() - this.ctx.keepClosedMs;
    const recent = this.windowOf(p.poll.repo, cutoff);
    const open = p.poll.open;
    const prs = recent
      .filter((c) => this.closed.get(c.number)?.updatedAt !== c.updatedAt)
      .map((c) => c.number)
      .slice(0, 20);
    const raws = [
      ...open,
      ...recent.map((c) => this.closed.get(c.number)?.raw).filter((r): r is RawPr => !!r),
    ];
    const checkRuns = raws
      .map((r) => nodCheckRun(r))
      .filter((r): r is NonNullable<typeof r> => r !== null && !this.summaries.has(r.databaseId))
      .slice(0, 50)
      .map((r) => ({ id: r.id, databaseId: r.databaseId }));
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
      .map((r, i) => ({ key: `signers${i}`, expression: `${r.headRefOid}:${SIGNERS_PATH}` }));
    if (!prs.length && !checkRuns.length && !issues.length && !blobs.length) return null;
    return { prs, issues, blobs, checkRuns };
  }

  /** The answers of a `Details` query: this repo's block, and check run texts by database id. */
  details(
    asked: DetailsAsk,
    block: DetailsRepoData | null,
    texts: ReadonlyMap<number, string | null>,
  ): void {
    const p = this.pending;
    if (!p) return;
    const repo = block ?? {};
    for (const n of asked.prs) {
      const raw = (repo[`pr${n}`] as RawPr | null | undefined) ?? null;
      const listed = (p.recent?.nodes ?? []).find((c) => c?.number === n);
      this.closed.set(n, { updatedAt: listed?.updatedAt ?? "", raw });
    }
    for (const n of asked.issues) {
      const hit = repo[`issue${n}`] as { title?: string } | null | undefined;
      this.epicTitles.set(n, hit?.title ?? `#${n}`);
    }
    for (const b of asked.blobs) {
      const hit = repo[b.key] as { text?: string | null } | null | undefined;
      this.headSigners.set(b.expression.split(":")[0]!, hit?.text ?? null);
    }
    for (const r of asked.checkRuns)
      this.summaries.set(r.databaseId, decodeSummary(texts.get(r.databaseId)));
  }

  private windowOf(repo: RawRepo, cutoff: number) {
    return (repo.closed?.nodes ?? []).filter(
      (c): c is NonNullable<typeof c> => c !== null && (ms(c.closedAt) ?? 0) >= cutoff,
    );
  }

  /** The poll is complete: it becomes what the repo shows. */
  async commit(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const { open: _o, closed: _c, ...info } = p.poll.repo;
    const cutoff = this.ctx.clock.now() - this.ctx.keepClosedMs;
    const recent = this.windowOf(p.poll.repo, cutoff);
    const keep = new Set(recent.map((c) => c.number));
    for (const n of this.closed.keys()) if (!keep.has(n)) this.closed.delete(n);
    this.info = info;
    this.open = [...p.poll.open];
    this.recent = recent.map((c) => c.number);
    this.requestedOfMe = new Set(p.poll.requested);
    this.local = await this.classifyInbox();
    this.error = null;
    this.readAt = this.ctx.clock.now();
  }

  /** The poll could not read this repo; what it showed stays. */
  failed(why: string): void {
    this.pending = null;
    if (why !== this.error) this.ctx.log(`nod serve: reading ${this.key()} failed: ${why}`);
    this.error = why;
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
          repo: this.name(),
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

  /** How many open PRs the last poll found. */
  get openCount(): number {
    return this.open.length;
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

  // -- building the view ----------------------------------------------------------

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
      !sameLogin(summary.repo, this.name())
    )
      return { kind: "unreadable", title: run.title };
    if (summary.base !== raw.baseRefName) return { kind: "outdated", summary };
    return { kind: "ok", summary };
  }

  /** Builds the facts again from what is cached, and starts what is missing. */
  rebuild(): void {
    if (this.stopped) return;
    const me = this.ctx.viewer()?.login ?? null;
    const signers = this.info?.signers?.text ?? "";
    const team = [...enrolledLogins(signers)];
    if (me && !team.some((l) => sameLogin(l, me))) team.push(me);
    const headBranches = new Map(this.open.map((r) => [r.headRefName, r.number] as const));
    const defaultBranch = this.info?.defaultBranchRef?.name ?? "main";
    const facts: PrFacts[] = [];
    const unclassified: Omit<UnclassifiedPr, "repo">[] = [];
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
        repo: this.name(),
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
    this.unclassifiedNow = unclassified;
    this.noSummary = noSummary;
    this.computePatchIds();
    if (this.info?.defaultBranchRef && this.ctx.clock.now() - this.rulesAt > 10 * MINUTE)
      void this.readRules(10 * MINUTE).then(() => this.ctx.changed());
  }

  /** The rows, relative to me on this host. */
  views(now: number, people: ReadonlyArray<Person>): PrView[] {
    const me = this.ctx.viewer()?.login ?? "";
    const key = this.ctx.myKey();
    // ADR 0002: a pending key reads everything and signs nothing; without an
    // active key the asks are GitHub approvals (ADR 0006).
    const signing = key !== null && this.enrolmentOf(key).state === "active";
    return toViews(this.facts, {
      repo: this.key(),
      me,
      now,
      people: [...people],
      signing,
    }).map((v) => {
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
      return out;
    });
  }

  unclassified(): UnclassifiedPr[] {
    const repo = this.key();
    return this.unclassifiedNow.map((u) => ({ ...u, repo }));
  }

  /** Everyone this repo shows: authors, ackers, enrolled signers. */
  people(add: (login: string | undefined | null, name: string | null | undefined) => void): void {
    const raws = [...this.open, ...[...this.closed.values()].map((c) => c.raw)];
    for (const r of raws) {
      if (!r) continue;
      add(r.author?.login, r.author?.name);
      for (const x of r.reactions.nodes) add(x?.user?.login, x?.user?.name);
    }
    for (const l of enrolledLogins(this.info?.signers?.text ?? "")) add(l, null);
  }

  // -- setup and enrolment ----------------------------------------------------------

  async setup(): Promise<SetupStatus> {
    await this.readRules(60 * SECOND);
    return this.setupNow();
  }

  setupNow(): SetupStatus {
    const info = this.info;
    const setupRaw = this.open.find((r) => r.headRefName === SETUP_BRANCH);
    const setupPr = setupRaw
      ? { number: setupRaw.number, url: setupRaw.url }
      : this.setupPrLink && !this.recent.includes(this.setupPrLink.number)
        ? this.setupPrLink
        : null;
    return setupStatusOf({
      repo: this.name(),
      defaultBranch: info?.defaultBranchRef?.name ?? null,
      files: this.filesOnDefault(),
      requiresNod: this.requiresNod,
      rulesRefused: this.rulesRefused,
      autoMerge: info ? info.autoMergeAllowed : null,
      setupPr,
      viewerPermission: info?.viewerPermission ?? null,
    });
  }

  /** Re-reads the default branch's rules when older than `maxAge`; one read at a time. */
  private readRules(maxAge: number): Promise<void> {
    const branch = this.info?.defaultBranchRef?.name;
    if (this.rulesRead) return this.rulesRead;
    const api = this.ctx.api();
    const clock = this.ctx.clock;
    if (!api || !branch || clock.now() - this.rulesAt < maxAge) return Promise.resolve();
    this.rulesRead = (async () => {
      try {
        this.requiresNod = await requiresNodCheck(api, this.name(), branch);
        this.rulesRefused = false;
        this.rulesAt = clock.now();
      } catch (error) {
        // The plan has no rulesets (a private repo on Free): say so, read again later.
        if (error instanceof GitHubApiError && isPlanRefusal(error.message)) {
          this.rulesRefused = true;
          this.rulesAt = clock.now();
          return;
        }
        // Unknown, not missing; tried again in a minute.
        this.rulesAt = clock.now() - 9 * MINUTE;
        if (!(error instanceof GitHubApiError))
          this.ctx.log(`nod serve: reading the rules of ${this.key()} failed: ${message(error)}`);
      } finally {
        this.rulesRead = null;
      }
    })();
    return this.rulesRead;
  }

  async openSetupPr(publicKey: string | null): Promise<PrLink> {
    const status = await this.setup();
    if (status.state === "ready")
      throw new SourceError("already-set-up", `${this.name()} is set up already.`);
    if (status.setupPr) return status.setupPr;
    const viewer = this.ctx.viewer();
    if (!viewer || !this.options.openSetupPr)
      throw new SourceError("github", `\`gh\` is not logged in to ${this.ctx.host.name}.`);
    let url: string;
    try {
      url = await this.options.openSetupPr({ login: viewer.login, publicKey });
    } catch (error) {
      throw new SourceError("github", `Opening the setup PR failed: ${message(error)}`);
    }
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    this.setupPrLink = { number, url };
    this.ctx.changed();
    this.ctx.poke();
    return this.setupPrLink;
  }

  async openEnrolPr(publicKey: string): Promise<PrLink> {
    const branch = this.info?.defaultBranchRef?.name;
    const api = this.ctx.api();
    const viewer = this.ctx.viewer();
    if (!api || !viewer || !branch)
      throw new SourceError("no-repo", `${this.name()} could not be read.`);
    if (!this.info?.signers)
      throw new SourceError(
        "github",
        `${this.name()} is not set up yet: the setup PR enrols the first key.`,
      );
    const current = this.enrolmentOf(publicKey);
    if (current.state === "active")
      throw new SourceError("already-enrolled", "Your key is enrolled already.");
    if (current.state === "pending" && current.pr) return current.pr;
    let pr: PrLink;
    try {
      pr = await openEnrolPr(api, {
        repo: this.name(),
        defaultBranch: branch,
        login: viewer.login,
        publicKey,
        identity: this.options.identity?.() ?? null,
      });
    } catch (error) {
      throw new SourceError("github", `Opening the enrolment PR failed: ${message(error)}`);
    }
    this.enrolPr = { pr, key: publicKeyId(publicKey) };
    this.ctx.changed();
    this.ctx.poke();
    return pr;
  }

  enrolmentOf(publicKey: string): Enrolment {
    const candidates: Array<{ pr: PrLink; text: string }> = [];
    for (const raw of this.open) {
      const text = this.headSigners.get(raw.headRefOid);
      if (text) candidates.push({ pr: { number: raw.number, url: raw.url }, text });
    }
    const e = enrolmentOf({
      publicKey,
      me: this.ctx.viewer()?.login ?? null,
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

  // -- signing and writing ------------------------------------------------------------

  async signTarget(pr: number): Promise<SignTarget | null> {
    const api = this.ctx.api();
    if (!api) throw new SourceError("github", `\`gh\` is not logged in to ${this.ctx.host.name}.`);
    const { owner, name } = this.parts();
    const data = await api.graphql<{
      repository: {
        pullRequest: {
          number: number;
          state: string;
          isDraft: boolean;
          merged: boolean;
          author: { login: string } | null;
          baseRefName: string;
          headRefOid: string;
        } | null;
      } | null;
    }>(SIGN_TARGET, { owner, name, number: pr });
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
        this.ctx.log(`nod serve: the patch-id of ${this.key()}#${pr} failed: ${message(error)}`);
      }
    }
    return {
      repo: this.key(),
      pr,
      state,
      author: p.author?.login ?? "ghost",
      base: p.baseRefName,
      headSha: p.headRefOid,
      patchId,
    };
  }

  async postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>> {
    const api = this.ctx.api();
    const results: PostResult[] = [];
    for (const entry of input.payload.entries) {
      if (
        !api ||
        !sameRepo(input.repo, this.key()) ||
        !sameLogin(input.payload.repo, this.name())
      ) {
        results.push({ pr: entry.pr, ok: false, url: null, message: `Not ${this.name()}.` });
        continue;
      }
      try {
        const r = await api.rest<{ html_url: string }>(
          "POST",
          `/repos/${this.name()}/issues/${entry.pr}/comments`,
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
    this.ctx.poke();
    return results;
  }

  async postApprovals(input: PostApprovalsInput): Promise<ReadonlyArray<PostResult>> {
    const api = this.ctx.api();
    const results: PostResult[] = [];
    const approved: Array<{ pr: number; headSha: string }> = [];
    for (const entry of input.entries) {
      if (!api || !sameRepo(input.repo, this.key())) {
        results.push({ pr: entry.pr, ok: false, url: null, message: `Not ${this.name()}.` });
        continue;
      }
      try {
        // `gh pr review --approve`, pinned to the commit the user looked at.
        const r = await api.rest<{ html_url?: string }>(
          "POST",
          `/repos/${this.name()}/pulls/${entry.pr}/reviews`,
          {
            commit_id: entry.headSha,
            event: "APPROVE",
            ...(input.body ? { body: input.body } : {}),
          },
        );
        results.push({
          pr: entry.pr,
          ok: true,
          url: r.data?.html_url ?? `${this.ctx.host.webUrl}/${this.name()}/pull/${entry.pr}`,
          message: null,
        });
        approved.push(entry);
      } catch (error) {
        results.push({
          pr: entry.pr,
          ok: false,
          url: null,
          message: `Approving #${entry.pr} failed: ${message(error)}`,
        });
      }
    }
    if (approved.length) this.showApprovals(approved);
    this.ctx.poke();
    return results;
  }

  /**
   * My approvals, shown at once; the next poll confirms them. GitHub answers
   * the review request from me; asked through a team, my review answers the
   * team's request (which of my teams it was, the poll tells: until then
   * every team request is taken off).
   */
  private showApprovals(entries: ReadonlyArray<{ pr: number; headSha: string }>) {
    const me = this.ctx.viewer()?.login;
    if (!me) return;
    const at = new Date(this.ctx.clock.now()).toISOString();
    const approve = (raw: RawPr, headSha: string): RawPr => {
      const nodes = raw.reviewRequests?.nodes ?? [];
      const direct = nodes.some((n) => {
        const r = n?.requestedReviewer;
        return !!r && "login" in r && sameLogin(r.login, me);
      });
      const viaTeam = !direct && this.requestedOfMe.has(raw.number);
      return {
        ...raw,
        reviewRequests: {
          nodes: nodes.filter((n) => {
            const r = n?.requestedReviewer;
            if (r && "login" in r) return !sameLogin(r.login, me);
            return !(viaTeam && r && "combinedSlug" in r);
          }),
        },
        latestOpinionatedReviews: {
          nodes: [
            ...(raw.latestOpinionatedReviews?.nodes ?? []).filter(
              (n) => !sameLogin(n?.author?.login ?? null, me),
            ),
            { state: "APPROVED", submittedAt: at, author: { login: me }, commit: { oid: headSha } },
          ],
        },
      };
    };
    for (const { pr, headSha } of entries) {
      this.open = this.open.map((r) => (r.number === pr ? approve(r, headSha) : r));
      this.requestedOfMe.delete(pr);
    }
    this.rebuild();
    this.ctx.changed();
  }

  async ackFyi(pr: number): Promise<void> {
    const f = this.facts.find((x) => x.number === pr);
    if (!f?.fyi) throw new SourceError("not-found", `#${pr} has no FYI.`);
    const api = this.ctx.api();
    const me = this.ctx.viewer();
    if (!api || !me)
      throw new SourceError("github", `\`gh\` is not logged in to ${this.ctx.host.name}.`);
    if (f.fyi.acked.some((l) => sameLogin(l, me.login))) return;
    await api
      .rest("POST", `/repos/${this.name()}/issues/${pr}/reactions`, { content: "eyes" })
      .catch((error: unknown) => {
        throw new SourceError("github", `Acking #${pr} failed: ${message(error)}`);
      });
    // Shown at once; the next poll confirms it.
    const ack = {
      createdAt: new Date(this.ctx.clock.now()).toISOString(),
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
    this.ctx.changed();
    this.ctx.poke();
  }

  /**
   * My inbox's view of an open PR (ADR 0009): its facts from the poll, its
   * files and I/O from the clone, at the base tip of its patch-id. null
   * until the patch-id is known.
   */
  async inboxSubject(pr: number): Promise<InboxSubject | null> {
    const raw = this.open.find((r) => r.number === pr);
    const ids = this.options.patchIds;
    if (!raw || !ids?.inbox) return null;
    const patchId = this.patchIds.get(patchKey(raw.baseRefName, raw.headRefOid));
    if (!patchId) return null;
    const got = await ids.inbox({ base: raw.baseRefName, headSha: raw.headRefOid });
    if (!got) return null;
    return {
      pr: {
        repo: this.name(),
        number: raw.number,
        title: raw.title,
        body: raw.body ?? "",
        author: raw.author?.login ?? "ghost",
        labels: (raw.labels?.nodes ?? []).flatMap((l) => (l?.name ? [l.name] : [])),
        base: raw.baseRefName,
        head_sha: raw.headRefOid,
      },
      files: got.files,
      patchId,
      io: got.io,
    };
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
        (failed !== undefined && this.ctx.clock.now() - failed < 5 * MINUTE)
      )
        continue;
      this.patchRunning.add(key);
      ids
        .compute({ base: raw.baseRefName, headSha: raw.headRefOid })
        .then(
          (id) => void this.patchIds.set(key, id),
          (error: unknown) => {
            this.patchFailed.set(key, this.ctx.clock.now());
            this.ctx.log(
              `nod serve: the patch-id of ${this.key()}#${raw.number} failed: ${message(error)}`,
            );
          },
        )
        .finally(() => {
          this.patchRunning.delete(key);
          this.rebuild();
          this.ctx.changed();
        });
    }
  }
}

const patchKey = (base: string, head: string) => `${base}\u0000${head}`;

export function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
