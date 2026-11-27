/**
 * My inbox inside `nod serve` (ADR 0009 decision 7): what runs when, the
 * cache, and what each PR shows.
 *
 * - **After every change of the PRs** (`schedule()`, the session calls it on
 *   the source's `prs`) a round goes over the open PRs: each one's subject
 *   from the source (`Source.inboxSubject`: the PR, its files from git, its
 *   patch-id and the I/O over its clone), then its classifiers and its plan
 *   (`prepare`) when anything they read changed: the PR, its files, my open
 *   PRs (`myWork`, across the snapshot), the repo layer's result, the load.
 * - **`when: "poll"` analyzers** run when the plan names a cache key that
 *   has no result yet: by analyzer and patch-id (`insightCacheKey`, plus an
 *   analyzer's own `cacheKey`). A rebase that keeps the patch-id keeps the
 *   result. **`when: "open"` analyzers** run on `open()`, when the panel
 *   opens on the PR.
 * - **Never blocking.** A round runs beside the snapshot: a PR shows what it
 *   had until a new result arrives (`running` only where it had nothing),
 *   each result is an `insights` event, and a round that changed someone's
 *   personal attention ends with one `personal` event (the session pushes a
 *   snapshot then).
 * - **The cache** is in memory, by key, at most `cacheSize` results (the
 *   oldest used go first). A load that succeeds (a save of `inbox.ts`) drops
 *   it all, the defaults' results too, since their options may have changed.
 *   No disk cache: a restart of `nod serve` runs the poll analyzers again.
 */

import { hashKey } from "../../kit/inbox/run.ts";
import type { InboxInput } from "../../kit/inbox/context.ts";
import type {
  InboxIO,
  InsightState,
  MyPullRequest,
  PersonalAttention,
  RepoSummary,
} from "../../kit/inbox/types.ts";
import type { PullRequestInfo } from "../../kit/classifiers/types.ts";
import type { ChangedFile } from "../../kit/patch-id.ts";
import type { InboxStatus, PrView, RepoKey, Snapshot } from "../../shared/protocol";
import { sameRepo } from "../../shared/repo-key";
import type { SourceRepo } from "../source";
import { sameLogin } from "../view";
import type { Prepared } from "./runner.ts";
import type { JobInput, PlannedAnalyzer } from "./wire.ts";

/** What the source knows of one open PR for my inbox. */
export interface InboxSubject {
  /** `repo` is `owner/name`, as the nod payload names it. */
  readonly pr: PullRequestInfo;
  /** Every changed file, from git where there is a clone. */
  readonly files: ReadonlyArray<ChangedFile>;
  readonly patchId: string;
  /** Reads, diffs and read-only git, on the server's side. */
  readonly io: InboxIO;
}

/** The part of a `Source` the inbox reads. */
export interface InboxSource {
  snapshot(): Snapshot | null;
  repos(): ReadonlyArray<SourceRepo>;
  /** null: not known yet (no patch-id, no clone), or the source has none. */
  inboxSubject?(repo: RepoKey, pr: number): Promise<InboxSubject | null>;
}

/** The part of `InboxRunner` the service uses. */
export interface RunnerLike {
  status(): InboxStatus;
  readonly generation: number;
  readonly isReady: boolean;
  subscribe(listener: (e: "status" | "loaded") => void): () => void;
  prepare(job: JobInput, io: InboxIO, options?: { priority?: boolean }): Promise<Prepared | null>;
  analyze(
    job: JobInput,
    analyzer: PlannedAnalyzer,
    io: InboxIO,
    options?: { priority?: boolean },
  ): Promise<InsightState | null>;
}

export type InboxEvent =
  | { readonly t: "status" }
  | { readonly t: "insights"; readonly repo: RepoKey; readonly pr: number }
  | { readonly t: "personal" };

export interface ServiceOptions {
  readonly runner: RunnerLike;
  readonly source: InboxSource;
  /** Most results kept (default 2000). */
  readonly cacheSize?: number;
  /** Subjects read and PRs prepared at once (default 4). */
  readonly concurrency?: number;
  readonly log?: (line: string) => void;
}

interface Rec {
  readonly repo: RepoKey;
  readonly number: number;
  subjectKey: string;
  subject: InboxSubject | null;
  /** What the last prepare ran on, with the load's generation. */
  inputKey: string | null;
  job: JobInput | null;
  personal: PersonalAttention | null;
  plan: ReadonlyArray<PlannedAnalyzer>;
  readonly states: Map<string, InsightState>;
  readonly inflight: Set<string>;
}

/** A map that forgets the least recently used entry past `max`. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

const idOf = (repo: RepoKey, n: number) => `${repo.toLowerCase()}#${n}`;
const isOpen = (p: Pick<PrView, "state">) => p.state === "open" || p.state === "draft";

async function eachLimited<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** What the repo layer said about the PR, for `ctx.repoSummary`; null while it is not classified. */
export function repoSummaryOf(view: PrView, snapshot: Snapshot): RepoSummary | null {
  if (snapshot.unclassified.some((u) => sameRepo(u.repo, view.repo) && u.number === view.number))
    return null;
  return {
    source: view.classifiedBy === "local" ? "local" : "verifier",
    risk: view.risk,
    category: view.category,
    tags: [...view.tags],
    fyi: view.fyi !== null,
    satisfied: view.requirement.satisfied,
  };
}

export class InboxService {
  private readonly runner: RunnerLike;
  private readonly source: InboxSource;
  private readonly cache: Lru<string, InsightState>;
  private readonly concurrency: number;
  private readonly log: (line: string) => void;
  private readonly records = new Map<string, Rec>();
  private readonly listeners = new Set<(e: InboxEvent) => void>();
  private readonly unsubscribe: () => void;
  private round: Promise<void> | null = null;
  /** Analyzers running now, across PRs. */
  private running = 0;
  private again = false;
  private stopped = false;

  constructor(options: ServiceOptions) {
    this.runner = options.runner;
    this.source = options.source;
    this.cache = new Lru(options.cacheSize ?? 2000);
    this.concurrency = options.concurrency ?? 4;
    this.log = options.log ?? ((line) => console.error(line));
    this.unsubscribe = this.runner.subscribe((e) => {
      if (e === "loaded") {
        // New code: every result may differ. What is on screen stays until replaced.
        this.cache.clear();
        for (const r of this.records.values()) r.inputKey = null;
        this.schedule();
      } else this.emit({ t: "status" });
    });
  }

  status(): InboxStatus {
    return this.runner.status();
  }

  subscribe(listener: (e: InboxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: InboxEvent) {
    if (this.stopped) return;
    for (const l of this.listeners) l(e);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  // -- what the PRs show ---------------------------------------------------------

  /** A snapshot with each PR's `personal` and `insights`. */
  decorate(snapshot: Snapshot): Snapshot {
    if (this.records.size === 0) return snapshot;
    return {
      ...snapshot,
      prs: snapshot.prs.map((p) => {
        const rec = this.records.get(idOf(p.repo, p.number));
        if (!rec) return p;
        const insights = this.insightsOf(rec);
        return {
          ...p,
          ...(rec.personal && { personal: rec.personal }),
          ...(insights.length > 0 && { insights }),
        };
      }),
    };
  }

  /** One PR's insights now, in its plan's order. */
  insights(repo: RepoKey, pr: number): InsightState[] {
    const rec = this.records.get(idOf(repo, pr));
    return rec ? this.insightsOf(rec) : [];
  }

  private insightsOf(rec: Rec): InsightState[] {
    return rec.plan.flatMap((a) => {
      const s = rec.states.get(a.id);
      return s ? [s] : [];
    });
  }

  // -- rounds --------------------------------------------------------------------

  /** The PRs changed: a round, after the one running (never two at once). */
  schedule(): void {
    if (this.stopped) return;
    if (this.round) {
      this.again = true;
      return;
    }
    this.round = this.runRound()
      .catch((e: unknown) => this.log(`nod serve: the inbox round failed: ${String(e)}`))
      .finally(() => {
        this.round = null;
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      });
  }

  /** Resolves when no round runs (tests). */
  async idle(): Promise<void> {
    while (this.round) await this.round;
  }

  /** Resolves when no round and no analyzer runs (tests, the fake's `insights-error`). */
  async settled(): Promise<void> {
    for (;;) {
      await this.idle();
      if (this.running === 0 && !this.round) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async runRound(): Promise<void> {
    const snapshot = this.source.snapshot();
    if (!snapshot || !this.runner.isReady || !this.source.inboxSubject) return;
    const open = snapshot.prs.filter(isOpen);
    const present = new Set(snapshot.prs.map((p) => idOf(p.repo, p.number)));
    for (const id of this.records.keys()) if (!present.has(id)) this.records.delete(id);

    await eachLimited(open, this.concurrency, (v) => this.readSubject(v));
    const myWork = this.myWork(snapshot);
    let personalChanged = false;
    // Every PR's classifiers first (the tiers wait for them), then the analyzers.
    await eachLimited(open, this.concurrency, async (v) => {
      if (await this.prepare(v, snapshot, myWork)) personalChanged = true;
    });
    if (personalChanged) this.emit({ t: "personal" });
    for (const v of open) {
      const rec = this.records.get(idOf(v.repo, v.number));
      if (rec?.job) this.runPlan(rec, "poll", false);
    }
  }

  private rec(v: Pick<PrView, "repo" | "number">): Rec {
    const id = idOf(v.repo, v.number);
    let rec = this.records.get(id);
    if (!rec) {
      rec = {
        repo: v.repo,
        number: v.number,
        subjectKey: "",
        subject: null,
        inputKey: null,
        job: null,
        personal: null,
        plan: [],
        states: new Map(),
        inflight: new Set(),
      };
      this.records.set(id, rec);
    }
    return rec;
  }

  private async readSubject(v: PrView): Promise<void> {
    const rec = this.rec(v);
    const key = `${v.headSha}:${v.patchId ?? ""}:${v.base}`;
    if (rec.subject && rec.subjectKey === key) return;
    try {
      rec.subject = (await this.source.inboxSubject?.(v.repo, v.number)) ?? null;
      rec.subjectKey = rec.subject ? key : "";
    } catch (e) {
      this.log(`nod serve: reading ${v.repo}#${v.number} for the inbox failed: ${String(e)}`);
      rec.subject = null;
    }
  }

  /** My open PRs across the snapshot, with their files (from git where known). */
  private myWork(snapshot: Snapshot): MyPullRequest[] {
    const repos = this.source.repos();
    return snapshot.prs
      .filter((p) => isOpen(p) && sameLogin(p.author, this.loginIn(p.repo, snapshot, repos)))
      .map((p) => {
        const rec = this.records.get(idOf(p.repo, p.number));
        const files = rec?.subject
          ? rec.subject.files.map((f) => f.path)
          : (p.files ?? []).map((f) => f.path);
        return { repo: this.nameOf(p.repo, repos), number: p.number, title: p.title, files };
      });
  }

  private loginIn(repo: RepoKey, snapshot: Snapshot, repos = this.source.repos()): string {
    return repos.find((r) => sameRepo(r.key, repo))?.login ?? snapshot.me;
  }

  private nameOf(repo: RepoKey, repos = this.source.repos()): string {
    return repos.find((r) => sameRepo(r.key, repo))?.name ?? repo.split("/").slice(-2).join("/");
  }

  /**
   * Classifies one PR and plans its analyzers when what they read changed.
   * True when its personal attention changed.
   */
  private async prepare(
    v: PrView,
    snapshot: Snapshot,
    myWork: MyPullRequest[],
    priority = false,
  ): Promise<boolean> {
    const rec = this.rec(v);
    const subject = rec.subject;
    if (!subject) return false;
    const input: InboxInput = {
      pr: subject.pr,
      files: [...subject.files],
      me: this.loginIn(v.repo, snapshot),
      myWork,
      repoSummary: repoSummaryOf(v, snapshot),
    };
    const generation = this.runner.generation;
    const inputKey = `${generation}:${subject.patchId}:${hashKey(JSON.stringify(input))}`;
    if (rec.inputKey === inputKey) return false;
    const job: JobInput = { input, revs: subject.io.revs, patchId: subject.patchId };
    const prepared = await this.runner.prepare(job, subject.io, { priority });
    if (!prepared || generation !== this.runner.generation || this.stopped) return false;
    const changed = JSON.stringify(prepared.attention) !== JSON.stringify(rec.personal);
    rec.inputKey = inputKey;
    rec.job = job;
    rec.subject = subject;
    rec.personal = prepared.attention;
    rec.plan = prepared.analyzers;
    return changed;
  }

  /**
   * Fills a PR's states from the cache and starts what has no result: its
   * poll analyzers, and on `open` its open ones too (a failed open result is
   * tried again then). A state it had stays until the new one arrives.
   */
  private runPlan(rec: Rec, when: "poll" | "open", priority: boolean): void {
    const before = JSON.stringify(this.insightsOf(rec));
    const keep = new Set(rec.plan.map((a) => a.id));
    for (const id of rec.states.keys()) if (!keep.has(id)) rec.states.delete(id);
    for (const a of rec.plan) {
      let cached = this.cache.get(a.key);
      if (cached?.status === "failed" && a.when === "open" && when === "open") {
        this.cache.delete(a.key);
        cached = undefined;
      }
      if (cached) {
        rec.states.set(a.id, cached);
        continue;
      }
      if (a.when === "open" && when !== "open") continue;
      const prev = rec.states.get(a.id);
      if (!prev || prev.status === "failed")
        rec.states.set(a.id, {
          id: a.id,
          title: a.title,
          origin: a.origin,
          when: a.when,
          status: "running",
        });
      this.start(rec, a, priority || a.when === "open");
    }
    if (JSON.stringify(this.insightsOf(rec)) !== before)
      this.emit({ t: "insights", repo: rec.repo, pr: rec.number });
  }

  private start(rec: Rec, a: PlannedAnalyzer, priority: boolean): void {
    if (rec.inflight.has(a.key) || !rec.job || !rec.subject) return;
    rec.inflight.add(a.key);
    this.running++;
    const generation = this.runner.generation;
    void this.runner.analyze(rec.job, a, rec.subject.io, { priority }).then((state) => {
      rec.inflight.delete(a.key);
      this.running--;
      if (this.stopped) return;
      const current = this.records.get(idOf(rec.repo, rec.number)) === rec;
      const planned = rec.plan.some((p) => p.key === a.key);
      if (!state || generation !== this.runner.generation) {
        // It did not run (the inbox stopped loading, or loaded anew): no `running` left behind.
        if (current && rec.states.get(a.id)?.status === "running") {
          rec.states.delete(a.id);
          this.emit({ t: "insights", repo: rec.repo, pr: rec.number });
        }
        return;
      }
      this.cache.set(a.key, state);
      if (!current || !planned) return;
      rec.states.set(a.id, state);
      this.emit({ t: "insights", repo: rec.repo, pr: rec.number });
    });
  }

  /**
   * The panel opened on a PR: its `open` analyzers run (those without a
   * result for this patch-id). Answers with its insights as they are now.
   */
  async open(repo: RepoKey, pr: number): Promise<InsightState[]> {
    const snapshot = this.source.snapshot();
    const view = snapshot?.prs.find((p) => sameRepo(p.repo, repo) && p.number === pr);
    if (!snapshot || !view) return [];
    if (!isOpen(view) || !this.runner.isReady) return this.insights(repo, pr);
    const rec = this.rec(view);
    if (!rec.job) {
      await this.readSubject(view);
      await this.prepare(view, snapshot, this.myWork(snapshot), true);
    }
    this.runPlan(rec, "open", true);
    return this.insightsOf(rec);
  }
}
