/**
 * The app's side of `nod serve` (ADR 0008 §8, §9, §12): the update checker,
 * the channel, the installer and the background service, behind one object
 * the session asks and listens to.
 *
 * - **Installing always takes a click** (`installUpdate`, the version the
 *   user saw). Nothing here installs on its own.
 * - **After an install**, a `nod serve` that is the service restarts through
 *   it (`ServiceManager.restart()`); the app reconnects to the new version
 *   and the service worker brings the new shell. A plain `nod serve` cannot
 *   restart itself and does not try: the state says "restart nod serve" with
 *   the command.
 * - **Setting the service up from the page** (a plain `nod serve`) installs
 *   it with this server's own flags (`serveArgs`: never `--open` or a token
 *   renewal), and then hands over: this process stops (`onHandOver`), the
 *   port is free, and the service, which failed to bind meanwhile, starts on
 *   its next try (`Restart=on-failure`, `RestartSec=5`; launchd's
 *   `KeepAlive`). The page reconnects to it with the same token.
 * - **Sides**: every state is the same for both sides but `mayChange`; the
 *   session refuses the machine-changing requests from the other device's
 *   side before they reach here.
 * - **`--fake`** (`simulate`): the seams are fakes (`fake-app.ts`), and what
 *   a real restart or hand-over does is played: the reported version becomes
 *   the installed one, and every tab reconnects (`onRestarted`).
 *
 * `toAppState` maps the server's state to the wire (`AppState`): nothing of
 * the checker's or the service manager's insides leaks.
 */

import type {
  AfterInstall,
  AppState,
  DeviceLink,
  InstallMethodView,
  ReleaseView,
  ServiceView,
  UpdateChannel,
} from "../shared/protocol";
import { ServiceError, type ServiceManager, type ServiceStatus } from "../service/manager";
import type { Clock, Timer } from "./clock";
import { RequestFailure } from "./request-failure";
import type { Side } from "./signer";
import {
  UpdateChecker,
  distTag,
  installCommand,
  type ChannelStore,
  type Installer,
  type ReleaseFeed,
  type ReleaseInfo,
  type UpdateState,
} from "./update";

/** The four seams: real in `nod serve`, fakes in tests and `--fake`. */
export interface AppSeams {
  readonly feed: ReleaseFeed;
  readonly installer: Installer;
  readonly channelStore: ChannelStore;
  readonly service: ServiceManager;
}

export interface AppControlOptions extends AppSeams {
  /** The running version; a checkout's placeholder or null is a development build. */
  readonly version: string | null;
  readonly clock: Clock;
  /** `nod serve`'s own flags: what the service is set up with, and what a restart by hand runs. */
  readonly serveArgs: ReadonlyArray<string>;
  /** Whether a status is this very process. Default: running, with this process's pid. */
  readonly isThisNod?: (status: ServiceStatus) => boolean;
  /** `--allow-host`'s origin. */
  readonly namedOrigin?: string | null;
  /** The other device's link as a QR code (only with `--allow-host`). */
  readonly deviceLink?: (() => Promise<DeviceLink>) | null;
  /** A plain `nod serve` just set the service up: stop, so the service takes the port. */
  readonly onHandOver?: () => void;
  /** `--fake`: play a restart and a hand-over; `onRestarted` makes every tab reconnect. */
  readonly simulate?: { readonly onRestarted: () => void } | null;
  /** The checker's cadence (default ten minutes). */
  readonly intervalMs?: number;
  /** How long the last push gets to reach the tabs before a restart or a hand-over. Default 800 ms. */
  readonly graceMs?: number;
}

/** The service's state, as this server keeps it. */
interface ServiceKeep {
  readonly status: ServiceStatus | null;
  readonly busy: ServiceView["busy"];
  readonly error: string | null;
  readonly handOver: boolean;
}

/** The commands shown when nod does not know how it was installed. */
const MANUAL_METHODS = ["npm", "bun"] as const;

/** One argument for a shell line, quoted only when it needs it. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The command that starts this `nod serve` again: `nod serve --port 4520`. */
export function serveCommand(args: ReadonlyArray<string>): string {
  return ["nod", "serve", ...args].map(shellQuote).join(" ");
}

/** Where the service's output goes. */
export function serviceLogs(kind: ServiceManager["kind"]): string | null {
  switch (kind) {
    case "systemd":
    case "fake":
      return "journalctl --user -u nod.service -f";
    case "launchd":
      return "~/Library/Logs/nod/nod.log";
    case "unsupported":
      return null;
  }
}

function releaseView(release: ReleaseInfo): ReleaseView {
  const at = Date.parse(release.publishedAt);
  return {
    version: release.version,
    publishedAt: Number.isFinite(at) ? at : 0,
    notes: release.notes,
    url: release.url,
    prerelease: release.prerelease,
  };
}

export interface AppStateInput {
  readonly update: UpdateState;
  readonly installer: Installer;
  readonly serviceKind: ServiceManager["kind"];
  readonly service: ServiceKeep;
  readonly thisNod: boolean;
  readonly serveArgs: ReadonlyArray<string>;
  readonly after: AfterInstall | null;
  readonly namedOrigin: string | null;
}

/** The server's state as the wire carries it, for one side. */
export function toAppState(input: AppStateInput, side: Side): AppState {
  const { update, installer, service } = input;
  const target = update.latest && update.kind ? update.latest.version : distTag(update.channel);
  const install: InstallMethodView = {
    method: installer.method,
    command: installer.method ? installer.command(target) : null,
    commands: installer.method
      ? []
      : MANUAL_METHODS.map((m) => installCommand(m, target)).filter((c): c is string => c !== null),
  };
  const status = service.status;
  const serviceView: ServiceView = {
    state:
      status === null
        ? "unknown"
        : status.state === "installed-stopped"
          ? "stopped"
          : status.state === "running"
            ? "running"
            : status.state,
    manager: input.serviceKind,
    unitPath: status && "unitPath" in status ? status.unitPath : null,
    command: status && "command" in status ? status.command.map(shellQuote).join(" ") : null,
    thisNod: input.thisNod,
    args: input.serveArgs,
    logs: serviceLogs(input.serviceKind),
    busy: service.busy,
    error: service.error,
    handOver: service.handOver,
  };
  return {
    version: update.current,
    development: update.development,
    channel: update.channel,
    update: {
      status: update.status,
      latest: update.latest ? releaseView(update.latest) : null,
      kind: update.kind,
      checkedAt: update.checkedAt,
      nextCheckAt: update.nextCheckAt,
      error: update.error,
      installation: { ...update.installation },
      after: input.after,
    },
    install,
    service: serviceView,
    mayChange: side === "loopback",
    otherDevice: input.namedOrigin ? { origin: input.namedOrigin } : null,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A service manager's error as a request's: "not built here" is `not-implemented`. */
const serviceFailure = (error: unknown) =>
  new RequestFailure(
    error instanceof ServiceError && error.code === "unsupported" ? "not-implemented" : "service",
    message(error),
  );

/** How long a read service status is good for, before a tab's arrival reads it again. */
const SERVICE_FRESH_MS = 10_000;

export class AppControl {
  private version: string | null;
  private checker: UpdateChecker;
  private offChecker: () => void;
  private service: ServiceKeep = { status: null, busy: null, error: null, handOver: false };
  private serviceReadAt: number | null = null;
  private serviceRead: Promise<ServiceStatus | null> | null = null;
  private after: AfterInstall | null = null;
  private readonly timers = new Set<Timer>();
  private readonly listeners = new Set<() => void>();
  private stopped = false;

  constructor(private readonly options: AppControlOptions) {
    this.version = options.version;
    this.checker = this.makeChecker(this.version);
    this.offChecker = this.checker.subscribe(() => this.emit());
  }

  /** Starts the update checks (a development build checks only when asked) and reads the service. */
  start(): void {
    this.checker.start();
    void this.readService();
  }

  stop(): void {
    this.stopped = true;
    this.offChecker();
    this.checker.stop();
    for (const timer of this.timers) timer.clear();
    this.timers.clear();
  }

  /** Calls `fn` after every change; returns the way to stop. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The state as `side` sees it. */
  state(side: Side): AppState {
    return toAppState(
      {
        update: this.checker.state,
        installer: this.options.installer,
        serviceKind: this.options.service.kind,
        service: this.service,
        thisNod: this.isThisNod(this.service.status),
        serveArgs: this.options.serveArgs,
        after: this.after,
        namedOrigin: this.options.namedOrigin ?? null,
      },
      side,
    );
  }

  /** The version the checker runs as (the fake's changes after a played restart). */
  get runningVersion(): string | null {
    return this.checker.state.current;
  }

  /** A tab arrived: read the service again when the last read is old. */
  refreshService(): void {
    const at = this.serviceReadAt;
    if (at === null || this.options.clock.now() - at >= SERVICE_FRESH_MS) void this.readService();
  }

  async checkNow(): Promise<void> {
    await this.checker.checkNow();
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    if (this.checker.state.installation.status !== "installing") this.after = null;
    await this.checker.setChannel(channel);
  }

  /**
   * Starts installing `version`, which must be the update on offer (what the
   * user saw and clicked). Answers once it started; the rest is pushed.
   */
  installUpdate(version: string): void {
    const { latest, kind, installation } = this.checker.state;
    if (installation.status === "installing") {
      if (installation.version === version) return;
      throw new RequestFailure("stale", `nod is installing ${installation.version} already.`);
    }
    if (!latest || !kind) throw new RequestFailure("not-found", "There is no update to install.");
    if (latest.version !== version)
      throw new RequestFailure(
        "stale",
        `The update on offer is ${latest.version} now, not ${version}. Look at it again.`,
      );
    if (!this.options.installer.method)
      throw new RequestFailure(
        "not-implemented",
        "nod does not know how it was installed, so it does not install updates itself. Run the command shown.",
      );
    this.after = null;
    void this.checker.install();
  }

  /** "Run nod in the background": the service with this server's flags; a plain `nod serve` then hands over. */
  async installService(): Promise<void> {
    const { service, simulate } = this.options;
    if (service.kind === "unsupported")
      throw new RequestFailure(
        "not-implemented",
        "Running nod in the background is built for Linux and macOS only.",
      );
    if (this.service.busy) throw new RequestFailure("bad-request", "The service is busy already.");
    this.patchService({ busy: "installing", error: null });
    let status: ServiceStatus;
    try {
      status = await service.install({ args: this.options.serveArgs });
    } catch (error) {
      this.patchService({ busy: null, error: message(error) });
      throw serviceFailure(error);
    }
    this.serviceReadAt = this.options.clock.now();
    // A plain `nod serve` gives the port to the service it set up.
    const handOver = simulate ? true : !this.isThisNod(status);
    this.patchService({ status, busy: null, error: null, handOver });
    if (!handOver) return;
    this.later(() => {
      if (simulate) {
        this.patchService({ handOver: false });
        simulate.onRestarted();
      } else this.options.onHandOver?.();
    });
  }

  async uninstallService(): Promise<void> {
    const { service } = this.options;
    if (service.kind === "unsupported")
      throw new RequestFailure(
        "not-implemented",
        "Running nod in the background is built for Linux and macOS only.",
      );
    if (this.service.busy) throw new RequestFailure("bad-request", "The service is busy already.");
    this.patchService({ busy: "uninstalling", error: null });
    try {
      const status = await service.uninstall();
      this.serviceReadAt = this.options.clock.now();
      this.patchService({ status, busy: null, handOver: false });
    } catch (error) {
      this.patchService({ busy: null, error: message(error) });
      throw serviceFailure(error);
    }
  }

  async deviceLink(): Promise<DeviceLink> {
    const link = this.options.deviceLink;
    if (!link)
      throw new RequestFailure(
        "not-found",
        "nod serve runs without --allow-host: no other device can reach it.",
      );
    return link();
  }

  // -- inside ------------------------------------------------------------------

  private makeChecker(version: string | null): UpdateChecker {
    const { feed, installer, channelStore, clock, intervalMs } = this.options;
    return new UpdateChecker({
      version,
      feed,
      installer,
      channelStore,
      clock,
      ...(intervalMs !== undefined && { intervalMs }),
      onInstalled: (installed) => void this.installed(installed),
    });
  }

  private isThisNod(status: ServiceStatus | null): boolean {
    if (!status) return false;
    if (this.options.isThisNod) return this.options.isThisNod(status);
    return status.state === "running" && status.pid === process.pid;
  }

  /** An install succeeded: restart through the service, or say how to. */
  private async installed(version: string): Promise<void> {
    const status = await this.readService();
    if (this.stopped) return;
    if (!this.isThisNod(status)) {
      this.after = { state: "restart-by-hand", command: serveCommand(this.options.serveArgs) };
      this.emit();
      return;
    }
    this.after = { state: "restarting" };
    this.emit();
    this.later(async () => {
      try {
        await this.options.service.restart();
      } catch (error) {
        this.after = { state: "restart-failed", error: message(error) };
        this.emit();
        return;
      }
      // A real restart ends this process; the fake plays the new one.
      if (this.options.simulate) this.restarted(version);
    });
  }

  /** `--fake`: what the restarted process would be: the new version, nothing installing, tabs reconnect. */
  private restarted(version: string): void {
    this.offChecker();
    this.checker.stop();
    this.version = version;
    this.after = null;
    this.checker = this.makeChecker(version);
    this.offChecker = this.checker.subscribe(() => this.emit());
    this.checker.start();
    this.emit();
    this.options.simulate?.onRestarted();
  }

  private readService(): Promise<ServiceStatus | null> {
    this.serviceRead ??= this.options.service
      .status()
      .then(
        (status) => status,
        () => null,
      )
      .then((status) => {
        this.serviceRead = null;
        this.serviceReadAt = this.options.clock.now();
        if (!this.stopped) this.patchService({ status });
        return status;
      });
    return this.serviceRead;
  }

  private later(fn: () => void | Promise<void>): void {
    const timer = this.options.clock.after(this.options.graceMs ?? 800, () => {
      this.timers.delete(timer);
      if (!this.stopped) void fn();
    });
    this.timers.add(timer);
  }

  private patchService(patch: Partial<ServiceKeep>): void {
    this.service = { ...this.service, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a listener must not break the app's state
      }
    }
  }
}
