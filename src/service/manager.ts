/**
 * Running `nod serve` in the background, behind one seam (epic D, ADR 0008):
 *
 * - `SystemdManager` (`systemd.ts`): a systemd user unit on Linux.
 * - `LaunchdManager` (`launchd.ts`): a LaunchAgent on macOS.
 * - `unsupportedManager`: elsewhere (Windows later): `status()` says so,
 *   everything else throws a `ServiceError`.
 * - `FakeServiceManager` (`fake.ts`): in memory, for tests and `--fake`.
 *
 * Process calls go through an injectable `ProcessRunner` and every path
 * through an injectable home and config root; tests never touch the real
 * unit folders or the real `systemctl`/`launchctl`. Only
 * {@link createServiceManager}, given nothing, defaults to the real ones.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { LaunchdManager } from "./launchd";
import { systemRunner, type ProcessRunner } from "./runner";
import { captureEnv, currentNod, ServiceError, type NodInvocation } from "./spec";
import { SystemdManager } from "./systemd";

export { ServiceError } from "./spec";
export type { NodInvocation } from "./spec";

/** What the service is doing. `unitPath` and `command` come from the installed unit file. */
export type ServiceStatus =
  | { readonly state: "unsupported"; readonly platform: string }
  | { readonly state: "not-installed" }
  | {
      readonly state: "installed-stopped";
      readonly unitPath: string;
      /** argv the service runs: runtime, entry point, `serve`, flags. */
      readonly command: readonly string[];
      /** The environment the unit gives it (what it finds `gh` with). */
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly state: "running";
      readonly unitPath: string;
      readonly command: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly pid: number | null;
    };

export interface ServiceManager {
  readonly kind: "systemd" | "launchd" | "unsupported" | "fake";
  status(): Promise<ServiceStatus>;
  /**
   * Writes the unit for the nod that is running, with `serve <args>`, enables
   * it and (re)starts it; installing again replaces the unit. Throws
   * `ServiceError` `unsupported` or `failed`.
   */
  install(options: { readonly args: readonly string[] }): Promise<ServiceStatus>;
  /** Stops and removes the unit; resolves `not-installed`, also when there was none. */
  uninstall(): Promise<ServiceStatus>;
  /** Restarts the service (how an update takes effect). Throws `not-installed`, `failed`. */
  restart(): Promise<ServiceStatus>;
}

export const unsupportedManager = (platform: string): ServiceManager => {
  const refuse = (): never => {
    throw new ServiceError(
      "unsupported",
      `running nod as a service is not built for ${platform} (Linux and macOS only)`,
    );
  };
  return {
    kind: "unsupported",
    status: async () => ({ state: "unsupported", platform }),
    install: async () => refuse(),
    uninstall: async () => refuse(),
    restart: async () => refuse(),
  };
};

export interface ServiceManagerOptions {
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The home folder (default the user's). */
  readonly home?: string;
  /**
   * Where `systemd/user` lives. Default: `$XDG_CONFIG_HOME` (only when `home` is not given),
   * else `<home>/.config`.
   */
  readonly configHome?: string;
  /** Default `process.getuid()`: the launchd domain `gui/<uid>`. */
  readonly uid?: number;
  /** Default the real `systemctl`/`launchctl`. */
  readonly runner?: ProcessRunner;
  /** The nod to run (default: the one running now). */
  readonly nod?: NodInvocation;
  /** The folder the service runs in (default `process.cwd()`). */
  readonly cwd?: string;
  /** The environment to capture `PATH` and friends from (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Finds the `gh` the unit pins as `NOD_GH` (default: on the captured PATH). */
  readonly findGh?: (env: NodeJS.ProcessEnv) => string | null;
}

/** The manager for this platform. Give it temp folders and a fake runner in tests. */
export function createServiceManager(options: ServiceManagerOptions = {}): ServiceManager {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const common = {
    runner: options.runner ?? systemRunner,
    nod: options.nod ?? currentNod(),
    cwd: options.cwd ?? process.cwd(),
    env: captureEnv(env, ...(options.findGh ? [options.findGh] : [])),
  };
  // An explicit home never mixes with the real $XDG_CONFIG_HOME: a test's temp home stays its own.
  const configHome =
    options.configHome ??
    (options.home === undefined ? env.XDG_CONFIG_HOME : undefined) ??
    join(home, ".config");
  if (platform === "linux")
    return new SystemdManager({
      ...common,
      unitDir: join(configHome, "systemd", "user"),
    });
  if (platform === "darwin")
    return new LaunchdManager({
      ...common,
      agentsDir: join(home, "Library", "LaunchAgents"),
      logFile: join(home, "Library", "Logs", "nod", "nod.log"),
      uid: options.uid ?? process.getuid?.() ?? 501,
    });
  return unsupportedManager(platform);
}
