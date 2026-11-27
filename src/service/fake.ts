/**
 * Fakes for tests and `nod serve --fake`: a `ProcessRunner` that records
 * what it was asked and answers from a script, and a `ServiceManager` that
 * lives in memory. Nothing here starts a process or writes a file.
 */

import type { ServiceManager, ServiceStatus } from "./manager";
import { ServiceError } from "./spec";
import type { ProcessRunner, RunResult } from "./runner";

export interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** Records every call; answers exit 0 with no output unless a `respond` rule matches (last rule wins). */
export class FakeRunner {
  readonly calls: RecordedCall[] = [];
  private rules: {
    match: (call: RecordedCall) => boolean;
    result: Partial<RunResult> | "throw";
  }[] = [];

  /** Answer the calls `match` accepts with `result`; "throw" makes the program fail to start. */
  respond(match: (call: RecordedCall) => boolean, result: Partial<RunResult> | "throw"): this {
    this.rules.push({ match, result });
    return this;
  }

  /** The calls as one line each: `systemctl --user daemon-reload`. */
  get lines(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(" "));
  }

  readonly run: ProcessRunner = async (command, args) => {
    const call = { command, args };
    this.calls.push(call);
    const rule = [...this.rules].reverse().find((r) => r.match(call));
    if (rule?.result === "throw") throw new Error(`spawn ${command} ENOENT`);
    return { status: 0, stdout: "", stderr: "", ...rule?.result };
  };
}

export const FAKE_UNIT_PATH = "/home/mara/.config/systemd/user/nod.service";
const FAKE_RUNTIME = ["/home/mara/.bun/bin/bun", "/home/mara/nod/src/cli.ts", "serve"] as const;

/** The states `--fake` can show, by name. */
export const FAKE_SERVICE_STATES = [
  "not-installed",
  "installed-stopped",
  "running",
  "unsupported",
] as const;
export type FakeServiceState = (typeof FAKE_SERVICE_STATES)[number];

/**
 * A service in memory. `install` makes it `running` with the given flags,
 * `uninstall` `not-installed`, `restart` counts. `failNext` makes the next
 * call throw a `ServiceError` `failed`, to see the error state.
 */
export class FakeServiceManager implements ServiceManager {
  readonly kind = "fake";
  /** The calls made, in order: "install", "uninstall", "restart". */
  readonly calls: string[] = [];
  /** The `args` of the last install. */
  installedArgs: readonly string[] | null = null;
  failNext: string | null = null;
  private current: ServiceStatus;

  constructor(initial: FakeServiceState | ServiceStatus = "not-installed") {
    this.current = typeof initial === "string" ? fakeStatus(initial) : initial;
  }

  async status(): Promise<ServiceStatus> {
    return this.current;
  }

  async install({ args }: { args: readonly string[] }): Promise<ServiceStatus> {
    this.enter("install");
    this.installedArgs = args;
    return (this.current = {
      state: "running",
      unitPath: FAKE_UNIT_PATH,
      command: [...FAKE_RUNTIME, ...args],
      pid: 4242,
    });
  }

  async uninstall(): Promise<ServiceStatus> {
    this.enter("uninstall");
    return (this.current = { state: "not-installed" });
  }

  async restart(): Promise<ServiceStatus> {
    this.enter("restart");
    if (this.current.state === "not-installed")
      throw new ServiceError("not-installed", "the service is not installed");
    return this.current;
  }

  private enter(call: string): void {
    this.calls.push(call);
    if (this.current.state === "unsupported")
      throw new ServiceError(
        "unsupported",
        "running nod as a service is not built for this platform",
      );
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      throw new ServiceError("failed", message);
    }
  }
}

function fakeStatus(state: FakeServiceState): ServiceStatus {
  switch (state) {
    case "not-installed":
      return { state };
    case "unsupported":
      return { state, platform: "win32" };
    case "installed-stopped":
      return { state, unitPath: FAKE_UNIT_PATH, command: FAKE_RUNTIME };
    case "running":
      return { state, unitPath: FAKE_UNIT_PATH, command: FAKE_RUNTIME, pid: 4242 };
  }
}
