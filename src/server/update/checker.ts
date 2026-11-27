/**
 * The update checker: keeps "is there an update?" for `nod serve`.
 *
 * - Checks every ~10 minutes (the {@link Clock} says when) and on demand
 *   (`checkNow`). A `304` from the feed costs nothing, so the cadence is cheap.
 * - Never throws into the server: every failure becomes `status: "error"` with
 *   a plain message; the next try is later (doubling from a minute up to an
 *   hour; after a rate limit, when GitHub said to come back, and never sooner
 *   than the cadence).
 * - A checkout (version null) is a "development build": nothing is checked
 *   until `checkNow` asks, and then the answer is shown as information only.
 * - **Available means "differs from what the channel wants"**: a channel switch
 *   from next to stable offers the newest stable release even when that is
 *   older (`kind: "downgrade"`).
 * - Installing always takes a call to `install()`; the checker never installs
 *   by itself.
 *
 * The state is plain JSON. `latest` and `kind` keep the last successful
 * check's answer while `checking` or `error` follow, so an indicator does not
 * flicker: `kind` is set exactly when an update is known.
 */

import type { Clock, Timer } from "../clock";
import { isRelease } from "../web-url";
import { defaultChannel, type ChannelStore } from "./channel-store";
import type { InstallInfo, Installer } from "./installer";
import { FeedRateLimited, type Channel, type ReleaseFeed, type ReleaseInfo } from "./release-feed";
import { compareSemver } from "./semver";

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "error";
export type UpdateKind = "upgrade" | "downgrade";
export type InstallStatus = "idle" | "installing" | "installed" | "failed";

/** The install the user started: what ran and, when it failed, what it said. */
export interface InstallProgress {
  readonly status: InstallStatus;
  /** The version being or last installed. */
  readonly version: string | null;
  /** The tail of the package manager's output once it finished. */
  readonly output: string | null;
  readonly error: string | null;
  /** Epoch ms. */
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface UpdateState {
  /** The running version; null in a checkout ("development build"). */
  readonly current: string | null;
  readonly development: boolean;
  readonly channel: Channel;
  readonly status: UpdateStatus;
  /** The newest release of the channel from the last successful check. */
  readonly latest: ReleaseInfo | null;
  /** Set when `latest` differs from `current`; null when up to date (or in a checkout). */
  readonly kind: UpdateKind | null;
  /** Epoch ms of the last successful check. */
  readonly checkedAt: number | null;
  /** Epoch ms of the next scheduled check; null when none is. */
  readonly nextCheckAt: number | null;
  readonly error: string | null;
  readonly install: InstallInfo;
  readonly installation: InstallProgress;
}

export const CHECK_INTERVAL_MS = 10 * 60_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const RATE_LIMIT_DEFAULT_MS = 60 * 60_000;

export interface UpdateCheckerOptions {
  /** The running version (`VERSION` in `cli.ts`); a checkout's placeholder or null means a development build. */
  readonly version: string | null | undefined;
  readonly feed: ReleaseFeed;
  readonly installer: Installer;
  readonly channelStore: ChannelStore;
  readonly clock: Clock;
  /** Default ten minutes. */
  readonly intervalMs?: number;
  /** After an install succeeded; the service restarts nod here, or nothing does. */
  readonly onInstalled?: (version: string) => void;
}

const IDLE_INSTALLATION: InstallProgress = {
  status: "idle",
  version: null,
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

/** The npm dist-tag a channel follows. */
export function distTag(channel: Channel): string {
  return channel === "stable" ? "latest" : "next";
}

export class UpdateChecker {
  private readonly current: string | null;
  private readonly interval: number;
  private channel: Channel;
  private snapshot: UpdateState;
  private timer: Timer | null = null;
  private started = false;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private limitedUntil: number | null = null;
  private readonly listeners = new Set<(state: UpdateState) => void>();

  constructor(private readonly options: UpdateCheckerOptions) {
    this.current = isRelease(options.version) ? options.version : null;
    this.interval = options.intervalMs ?? CHECK_INTERVAL_MS;
    this.channel = options.channelStore.get() ?? defaultChannel(this.current);
    this.snapshot = {
      current: this.current,
      development: this.current === null,
      channel: this.channel,
      status: "idle",
      latest: null,
      kind: null,
      checkedAt: null,
      nextCheckAt: null,
      error: null,
      install: this.installInfo(null, null),
      installation: IDLE_INSTALLATION,
    };
  }

  get state(): UpdateState {
    return this.snapshot;
  }

  /** Calls `fn` after every change of the state; returns the way to stop. */
  subscribe(fn: (state: UpdateState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Starts the cadence: a first check now, then one every interval. A development build checks nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.current !== null) void this.run(false);
  }

  stop(): void {
    this.started = false;
    this.timer?.clear();
    this.timer = null;
    this.update({ nextCheckAt: null });
  }

  /** "Check now". Resolves with the state afterwards; never rejects. */
  async checkNow(): Promise<UpdateState> {
    await this.run(true);
    return this.snapshot;
  }

  /** Picks the channel, keeps the choice and checks the new one at once. */
  async setChannel(channel: Channel): Promise<UpdateState> {
    if (channel === this.channel) return this.snapshot;
    this.channel = channel;
    try {
      this.options.channelStore.set(channel);
    } catch {
      // the choice holds for this run
    }
    // What was found belongs to the other channel.
    this.update({
      channel,
      kind: null,
      latest: null,
      error: null,
      install: this.installInfo(null, null),
    });
    if (this.current !== null || this.snapshot.checkedAt !== null) await this.run(true);
    return this.snapshot;
  }

  /**
   * Installs the release on offer with the package manager nod came with.
   * Resolves when the install ended; a failure is in `installation`, not
   * thrown. Nothing is run without an update on offer and a known method.
   */
  async install(): Promise<UpdateState> {
    const { latest, kind, installation } = this.snapshot;
    if (installation.status === "installing") return this.snapshot;
    const now = this.options.clock.now();
    const refuse = (error: string) => {
      this.update({
        installation: { ...IDLE_INSTALLATION, status: "failed", error, finishedAt: now },
      });
      return this.snapshot;
    };
    if (!latest || !kind) return refuse("There is no update to install.");
    if (!this.options.installer.method)
      return refuse("nod does not know how it was installed; run the command yourself.");

    this.update({
      installation: {
        ...IDLE_INSTALLATION,
        status: "installing",
        version: latest.version,
        startedAt: now,
      },
    });
    const result = await this.options.installer.run(latest.version).catch((error: unknown) => ({
      ok: false,
      code: null,
      output: error instanceof Error ? error.message : String(error),
    }));
    const finishedAt = this.options.clock.now();
    this.update({
      installation: {
        status: result.ok ? "installed" : "failed",
        version: latest.version,
        output: result.output,
        error: result.ok
          ? null
          : `The install failed${result.code === null ? "" : ` (exit ${result.code})`}.`,
        startedAt: now,
        finishedAt,
      },
    });
    if (result.ok) {
      try {
        this.options.onInstalled?.(latest.version);
      } catch {
        // restarting is the caller's business
      }
    }
    return this.snapshot;
  }

  // -- checking ------------------------------------------------------------

  private run(manual: boolean): Promise<void> {
    this.inflight ??= this.check(manual).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async check(manual: boolean): Promise<void> {
    const clock = this.options.clock;
    try {
      if (this.limitedUntil !== null && clock.now() < this.limitedUntil) {
        // GitHub said to wait: asking again only prolongs it.
        const at = new Date(this.limitedUntil).toISOString();
        if (manual)
          this.update({
            status: "error",
            error: `GitHub is rate-limiting the update check until ${at}.`,
          });
        this.schedule(this.limitedUntil - clock.now());
        return;
      }
      const known = this.snapshot.status === "up-to-date" || this.snapshot.status === "available";
      if (manual || !known) this.update({ status: "checking", error: null });

      // A channel switch while the answer is on its way makes it the wrong one: ask again.
      for (;;) {
        const channel = this.channel;
        const latest = await this.options.feed.latest(channel);
        if (channel !== this.channel) continue;
        this.failures = 0;
        this.limitedUntil = null;
        this.settle(latest);
        this.schedule(this.interval);
        return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private settle(latest: ReleaseInfo | null): void {
    const kind: UpdateKind | null =
      this.current && latest && compareSemver(latest.version, this.current) !== 0
        ? compareSemver(latest.version, this.current) > 0
          ? "upgrade"
          : "downgrade"
        : null;
    this.update({
      status: this.current === null ? "idle" : kind ? "available" : "up-to-date",
      latest,
      kind,
      checkedAt: this.options.clock.now(),
      error: null,
      install: this.installInfo(latest, kind),
    });
  }

  private fail(error: unknown): void {
    this.failures++;
    const now = this.options.clock.now();
    let delay = Math.min(BACKOFF_START_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    let message = error instanceof Error ? error.message : "The update check failed.";
    if (error instanceof FeedRateLimited) {
      const until = error.until ?? now + RATE_LIMIT_DEFAULT_MS;
      this.limitedUntil = until;
      delay = Math.max(until - now, this.interval);
      message = `GitHub is rate-limiting the update check until ${new Date(until).toISOString()}.`;
    }
    this.update({ status: "error", error: message });
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    this.timer?.clear();
    this.timer = null;
    if (!this.started || this.current === null) {
      this.update({ nextCheckAt: null });
      return;
    }
    const wait = Math.max(0, delay);
    this.update({ nextCheckAt: this.options.clock.now() + wait });
    this.timer = this.options.clock.after(wait, () => void this.run(false));
  }

  private installInfo(latest: ReleaseInfo | null, kind: UpdateKind | null): InstallInfo {
    const installer = this.options.installer;
    const target = latest && kind ? latest.version : distTag(this.channel);
    return { method: installer.method, command: installer.command(target) };
  }

  private update(patch: Partial<UpdateState>): void {
    const changed = (Object.keys(patch) as (keyof UpdateState)[]).some(
      (key) => this.snapshot[key] !== patch[key],
    );
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch {
        // a listener must not break the checker
      }
    }
  }
}
