/**
 * The inbox runner (ADR 0009 decision 8): a few inbox subprocesses
 * (`process.ts`) that run my classifiers and analyzers, one job at a time
 * each, `open` jobs first.
 *
 * - **Loading.** Every process loads the folder on start. The first answer
 *   after a (re)load is the inbox's status: `ready` with what it loaded, or
 *   `error` with why it does not load; then no job runs until the folder
 *   changes, and the service keeps what it showed.
 * - **Reload on save.** The folder is watched (`watch.ts`, debounced): a
 *   change stops every process and loads again; `loaded` tells the service
 *   to drop its cache.
 * - **Timeouts.** An analyzer gets the kit's `ANALYZER_TIMEOUT_MS` for its
 *   `when`, the classifiers of one PR the `poll` one; a job still running a
 *   little after that is killed with its process, which starts again at
 *   once. Its result is `failed`.
 * - **Crashes** (a process that exits on its own) restart after a pause that
 *   doubles each time, up to 30 s, and resets after a job succeeds; after
 *   three in a row the status says so.
 * - Everything a process returns is validated here again.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { combineAttention, errorMessage, ANALYZER_TIMEOUT_MS } from "../../kit/inbox/run.ts";
import type { InboxIO, InsightState, PersonalAttention } from "../../kit/inbox/types.ts";
import { cleanString, parseAttention, parseInsightState } from "../../kit/inbox/validate.ts";
import type { InboxStatus } from "../../shared/protocol";
import { INBOX_FILE } from "./paths.ts";
import { inboxEnv } from "./env.ts";
import { InboxProcess, JobTimeout } from "./process.ts";
import { watchFolder } from "./watch.ts";
import { parsePlan, type JobInput, type LoadedInbox, type PlannedAnalyzer } from "./wire.ts";

export interface RunnerOptions {
  /** The inbox folder (`inboxDir()`); it may not exist (the defaults run). */
  readonly dir: string;
  /** The subprocess's environment (default `inboxEnv()`). */
  readonly env?: Record<string, string>;
  /** How many processes (default 2: a slow `open` analyzer does not hold up the poll's). */
  readonly size?: number;
  /** Watch the folder and reload on a change (default true). */
  readonly watch?: boolean;
  readonly debounceMs?: number;
  /** Per `when`, and for one PR's classifiers (default the kit's, and its `poll` one). */
  readonly timeouts?: { readonly poll?: number; readonly open?: number; readonly prepare?: number };
  /** Past the timeout before the process is killed (default 2 s). */
  readonly graceMs?: number;
  /** The first pause after a crash (default 500 ms), doubling up to `maxBackoffMs` (30 s). */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Test seams: the runtime and the entry file. */
  readonly execPath?: string;
  readonly entry?: string;
  readonly log?: (line: string) => void;
}

/** One PR's classifiers' result and the analyzers that apply. */
export interface Prepared {
  readonly attention: PersonalAttention;
  readonly analyzers: ReadonlyArray<PlannedAnalyzer>;
}

type Event = "status" | "loaded";

interface Queued {
  readonly priority: boolean;
  readonly run: (p: InboxProcess) => Promise<unknown>;
  readonly resolve: (v: unknown) => void;
  /** It cannot run: the inbox does not load, or the runner stopped. */
  readonly skip: () => void;
}

const SECOND = 1000;

/** A personal attention from anything a process sent: marks validated, the sum computed here. */
export function parsePersonal(v: unknown): PersonalAttention {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const marks = parseAttention(o.marks).map((m) => ({
    ...m,
    classifier: m.classifier ?? "classifier",
  }));
  const errors = (Array.isArray(o.errors) ? o.errors : [])
    .map((e) => cleanString(e, 300))
    .filter((e): e is string => e !== undefined)
    .slice(0, 20);
  return combineAttention(marks, errors);
}

export class InboxRunner {
  private readonly dir: string;
  private readonly env: Record<string, string>;
  private readonly size: number;
  private readonly log: (line: string) => void;
  private readonly workers: Array<InboxProcess | null>;
  private readonly queue: Queued[] = [];
  private readonly listeners = new Set<(e: Event) => void>();
  private state: InboxStatus["state"] = "starting";
  private error: string | null = null;
  private loaded: LoadedInbox | null = null;
  private loadedConfig: "default" | "yours";
  /** Bumped by every load that succeeded: results of an older one are stale. */
  private gen = 0;
  /** Bumped by every (re)load started: a process of an older one is ignored. */
  private epoch = 0;
  private crashes = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  private stopped = false;
  private firstLoad: Promise<void>;
  private settleFirst!: () => void;

  constructor(private readonly options: RunnerOptions) {
    this.dir = options.dir;
    this.env = options.env ?? inboxEnv();
    this.size = Math.max(1, options.size ?? 2);
    this.log = options.log ?? ((line) => console.error(line));
    this.workers = Array.from({ length: this.size }, () => null);
    this.loadedConfig = this.hasFile() ? "yours" : "default";
    this.firstLoad = new Promise((r) => (this.settleFirst = r));
  }

  private hasFile(): boolean {
    return existsSync(join(this.dir, INBOX_FILE));
  }

  /** Where the inbox is, what it loaded, whether it loads. */
  status(): InboxStatus {
    return {
      config: this.loaded?.config ?? this.loadedConfig,
      path: this.dir,
      state: this.state,
      error: this.error,
      classifiers: this.loaded?.classifiers ?? [],
      analyzers: this.loaded?.analyzers ?? [],
    };
  }

  /** The current load's number; results cached under an older one are stale. */
  get generation(): number {
    return this.gen;
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  /** `status`: the status changed; `loaded`: a load succeeded (drop cached results). */
  subscribe(listener: (e: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: Event) {
    for (const l of this.listeners) l(e);
  }

  /** Starts the processes and the watcher. */
  start(): void {
    if (this.stopped) return;
    this.load();
    if (this.options.watch !== false)
      this.unwatch = watchFolder(this.dir, () => this.reload(), {
        debounceMs: this.options.debounceMs ?? 300,
      });
  }

  /** Resolves once the first load answered (ready or error). */
  ready(): Promise<void> {
    return this.firstLoad;
  }

  /** The folder changed: stop every process and load again. */
  reload(): void {
    if (this.stopped) return;
    this.log(`nod serve: ${this.dir} changed; loading the inbox again`);
    this.load();
  }

  private load() {
    this.epoch++;
    this.crashes = 0;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const [i, w] of this.workers.entries()) {
      w?.kill();
      this.workers[i] = null;
    }
    this.loadedConfig = this.hasFile() ? "yours" : "default";
    this.setState("starting", null);
    this.spawn(0, true);
  }

  private setState(state: InboxStatus["state"], error: string | null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit("status");
  }

  /**
   * Starts worker `i`. The first of a load decides the status; the others
   * start once it loaded.
   */
  private spawn(i: number, first = false): void {
    if (this.stopped) return;
    const epoch = this.epoch;
    const p = new InboxProcess({
      dir: this.dir,
      env: this.env,
      log: this.log,
      ...(this.options.execPath && { execPath: this.options.execPath }),
      ...(this.options.entry && { entry: this.options.entry }),
    });
    this.workers[i] = p;
    p.start().then(
      (loaded) => {
        if (epoch !== this.epoch || this.stopped) return p.kill();
        this.loadedProcs.add(p);
        if (first || this.state !== "ready") {
          this.loaded = loaded;
          this.gen++;
          this.setState("ready", this.crashes >= 3 ? this.error : null);
          this.emit("loaded");
          this.settleFirst();
          for (let j = 1; j < this.size; j++) if (!this.workers[j]) this.spawn(j);
        }
        this.dispatch();
      },
      (e: unknown) => {
        if (epoch !== this.epoch || this.stopped) return;
        if (first) {
          // It does not load: say why, keep what was shown, run nothing until a change.
          p.kill();
          this.workers[i] = null;
          this.setState("error", errorMessage(e));
          this.settleFirst();
          this.drain();
        }
      },
    );
    void p.exited.then(({ crashed }) => {
      if (epoch !== this.epoch || this.stopped || this.workers[i] !== p) return;
      this.workers[i] = null;
      if (this.state === "error" && this.loaded === null) return;
      if (!crashed) {
        // Killed for a timeout: back at once.
        this.spawn(i, this.state !== "ready");
        return;
      }
      this.crashes++;
      if (this.crashes >= 3)
        this.setState(this.state, `the inbox process keeps exiting; nod serve tries again`);
      const pause = Math.min(
        this.options.maxBackoffMs ?? 30 * SECOND,
        (this.options.backoffMs ?? 500) * 2 ** (this.crashes - 1),
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (epoch === this.epoch) this.spawn(i, this.state !== "ready");
      }, pause);
    });
  }

  /** Hands queued jobs to idle, loaded processes, `open` ones first. */
  private dispatch() {
    if (this.state !== "ready") return;
    for (const w of this.workers) {
      if (!w || !w.alive || w.busy || !this.loadedProcs.has(w)) continue;
      const i = this.queue.findIndex((q) => q.priority);
      const next = i >= 0 ? this.queue.splice(i, 1)[0] : this.queue.shift();
      if (!next) return;
      void next
        .run(w)
        .then(next.resolve, () => next.skip())
        .finally(() => this.dispatch());
    }
  }

  /** Processes that said `hello`: only they take jobs. */
  private readonly loadedProcs = new WeakSet<InboxProcess>();

  /** Jobs that cannot run now: the inbox does not load. */
  private drain() {
    for (const q of this.queue.splice(0)) q.skip();
  }

  private enqueue<T>(
    priority: boolean,
    run: (p: InboxProcess) => Promise<T>,
    fallback: () => T,
  ): Promise<T> {
    if (this.stopped || this.state === "error") return Promise.resolve(fallback());
    return new Promise<T>((resolve) => {
      this.queue.push({
        priority,
        run,
        resolve: resolve as (v: unknown) => void,
        skip: () => resolve(fallback()),
      });
      this.dispatch();
    });
  }

  private timeoutOf(when: "poll" | "open" | "prepare"): number {
    const t = this.options.timeouts;
    if (when === "prepare") return t?.prepare ?? t?.poll ?? ANALYZER_TIMEOUT_MS.poll;
    return t?.[when] ?? ANALYZER_TIMEOUT_MS[when];
  }

  /**
   * One PR's classifiers and its analyzers' plan, ahead of queued poll
   * analyzers (the list's tiers wait for it). null when it could not run
   * (the inbox does not load, the runner stopped); a timeout or a crash
   * gives an attention of 0 with the error.
   */
  prepare(
    job: JobInput,
    io: InboxIO,
    _options: { priority?: boolean } = {},
  ): Promise<Prepared | null> {
    const timeout = this.timeoutOf("prepare");
    return this.enqueue<Prepared | null>(
      true,
      async (p) => {
        try {
          const r = await p.run(
            { t: "prepare", ...job },
            io,
            timeout,
            this.options.graceMs ?? 2 * SECOND,
          );
          this.crashes = 0;
          if (r.t !== "prepared") throw new Error("unexpected answer");
          return { attention: parsePersonal(r.attention), analyzers: parsePlan(r.analyzers) };
        } catch (e) {
          if (!(e instanceof JobTimeout) && !p.alive) throw e; // gone: skipped, the next round tries again
          return { attention: combineAttention([], [errorMessage(e)]), analyzers: [] };
        }
      },
      () => null,
    );
  }

  /**
   * Runs one analyzer on one PR. null when it could not run; otherwise its
   * state, `failed` on a timeout (the process is restarted) or a crash.
   */
  analyze(
    job: JobInput,
    analyzer: PlannedAnalyzer,
    io: InboxIO,
    options: { priority?: boolean } = {},
  ): Promise<InsightState | null> {
    const timeout = this.timeoutOf(analyzer.when);
    const base = {
      id: analyzer.id,
      title: analyzer.title,
      origin: analyzer.origin,
      when: analyzer.when,
    };
    return this.enqueue<InsightState | null>(
      options.priority ?? false,
      async (p) => {
        const started = Date.now();
        try {
          const r = await p.run(
            { t: "analyze", analyzer: analyzer.id, timeoutMs: timeout, ...job },
            io,
            timeout,
            this.options.graceMs ?? 2 * SECOND,
          );
          this.crashes = 0;
          if (r.t !== "analyzed") throw new Error("unexpected answer");
          const state = parseInsightState(r.state);
          if (!state)
            return {
              ...base,
              status: "failed",
              error: "it returned something that is not an insight",
            };
          // What the plan says it is, whatever the process claims.
          return { ...state, ...base } as InsightState;
        } catch (e) {
          return { ...base, status: "failed", error: errorMessage(e), ms: Date.now() - started };
        }
      },
      () => null,
    );
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const w of this.workers) w?.kill();
    this.drain();
    this.settleFirst();
  }
}
