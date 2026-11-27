/**
 * The app's seams for `nod serve --fake` (and tests): every one a fake, so a
 * fake run never reaches GitHub Releases, a package manager, `systemctl` or
 * `launchctl`, or nod's config file. The flags pick the state to start in:
 *
 * - `--fake-update available` (default): a `0.2.0` on stable, `0.3.0` on
 *   offer with release notes; `none`: `0.3.0`, up to date; `failing`: the
 *   check fails; `downgrade`: a `0.4.0-next.2` switched to stable, so the
 *   newest stable (`0.3.0`) is on offer as a downgrade.
 * - `--fake-service not-installed` (default) | `running` | `stopped` |
 *   `unsupported`: a running fake service counts as this `nod serve`, so an
 *   update restarts through it (played: the version becomes the new one and
 *   the tabs reconnect).
 * - `--fake-install npm` (default) | `bun` | `unknown` (nod does not know how
 *   it was installed: the commands only) | `fail` (the install fails). An
 *   install takes a few seconds, so "installing" can be seen.
 */

import { FakeServiceManager } from "../service/fake";
import type { ServiceStatus } from "../service/manager";
import type { AppSeams } from "./app-control";
import type { Clock } from "./clock";
import { FakeInstaller, FakeReleaseFeed, memoryChannelStore, type Channel } from "./update";

export const FAKE_UPDATES = ["available", "none", "failing", "downgrade"] as const;
export type FakeUpdate = (typeof FAKE_UPDATES)[number];
export const FAKE_SERVICES = ["not-installed", "running", "stopped", "unsupported"] as const;
export type FakeService = (typeof FAKE_SERVICES)[number];
export const FAKE_INSTALLS = ["npm", "bun", "unknown", "fail"] as const;
export type FakeInstall = (typeof FAKE_INSTALLS)[number];

export interface FakeAppOptions {
  readonly update?: FakeUpdate;
  readonly service?: FakeService;
  readonly install?: FakeInstall;
  readonly clock: Clock;
  /** How long a fake install takes (default 4 s). */
  readonly installMs?: number;
}

export interface FakeApp {
  readonly seams: AppSeams & {
    readonly feed: FakeReleaseFeed;
    readonly installer: FakeInstaller;
    readonly service: FakeServiceManager;
  };
  /** The release the fake plays. */
  readonly version: string;
  /** A running fake service is this `nod serve`. */
  readonly isThisNod: (status: ServiceStatus) => boolean;
}

const VERSIONS: Readonly<Record<FakeUpdate, string>> = {
  available: "0.2.0",
  none: "0.3.0",
  failing: "0.2.0",
  downgrade: "0.4.0-next.2",
};

export function fakeApp(options: FakeAppOptions): FakeApp {
  const update = options.update ?? "available";
  const install = options.install ?? "npm";
  const feed = new FakeReleaseFeed();
  if (update === "failing") feed.fail();
  const channel: Channel | null = update === "downgrade" ? "stable" : null;
  const installer = new FakeInstaller({
    method: install === "unknown" ? null : install === "bun" ? "bun" : "npm",
    clock: options.clock,
    delayMs: options.installMs ?? 4000,
    fail: install === "fail",
  });
  const state = options.service ?? "not-installed";
  const service = new FakeServiceManager(state === "stopped" ? "installed-stopped" : state);
  return {
    seams: { feed, installer, channelStore: memoryChannelStore(channel), service },
    version: VERSIONS[update],
    isThisNod: (status) => status.state === "running",
  };
}
