/**
 * `nod service install [serve flags…] | uninstall | status`: `nod serve` in
 * the background, as a systemd user unit (Linux) or a LaunchAgent (macOS).
 * The flags after `install` are `nod serve`'s own, validated by it.
 */

import { tmpdir } from "node:os";

import { DEFAULT_SERVE_PORT } from "../shared/protocol";
import { findGh } from "../server/github/gh";
import { preflightProblems, type Preflight } from "./preflight";
import {
  createServiceManager,
  ServiceError,
  type ServiceManager,
  type ServiceStatus,
} from "./manager";
import { currentNod, isFragileEntry } from "./spec";

export type ServiceCommand = "install" | "uninstall" | "status";

export interface ServiceFlags {
  readonly command: ServiceCommand;
  /** `install`: the `nod serve` flags the service runs with. */
  readonly serveArgs: readonly string[];
}

export const SERVICE_HELP = `service commands:
  service install [serve options]
                      run nod serve in the background: a systemd user unit
                      (Linux) or a LaunchAgent (macOS), started now and at
                      login, restarted when it fails. It runs the nod that
                      installed it, with the serve options given here (see
                      above; not --open), and the gh its PATH finds; it warns
                      when that gh would not be logged in for the service
                      (GH_TOKEN is never written into it). Run it again to
                      change them
  service uninstall   stop the service and remove it
  service status      not installed, installed but stopped, or running; the
                      unit file, the command it runs, the gh it runs and,
                      while it runs, what it sees of GitHub
`;

/** What parsing `nod serve <args>` gives. */
export type ServeParse =
  | { kind: "serve"; flags: { readonly open: boolean } }
  | { kind: "help" }
  | { kind: "error"; message: string };

type Parsed =
  | { kind: "service"; flags: ServiceFlags }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * `validateServe` is the CLI's own parse of `nod serve <args>`, passed in so
 * this module need not import `cli.ts`.
 */
export function parseServiceArgs(
  args: readonly string[],
  validateServe: (args: string[]) => ServeParse,
): Parsed {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    return command === undefined
      ? { kind: "error", message: "nod service needs one of: install, uninstall, status" }
      : { kind: "help" };
  }
  if (command !== "install" && command !== "uninstall" && command !== "status")
    return { kind: "error", message: "nod service needs one of: install, uninstall, status" };
  if (command !== "install") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return { kind: "help" };
    if (rest.length) return { kind: "error", message: `unexpected argument: ${rest[0]}` };
    return { kind: "service", flags: { command, serveArgs: [] } };
  }
  const parsed = validateServe(rest);
  if (parsed.kind === "help") return { kind: "help" };
  if (parsed.kind === "error") return { kind: "error", message: parsed.message };
  if (parsed.flags.open)
    return {
      kind: "error",
      message: "--open does not belong in a service: it would open a browser at every start",
    };
  return { kind: "service", flags: { command, serveArgs: rest } };
}

/** The terminal and the service manager, injectable for tests. */
export interface ServiceIo {
  out(text: string): void;
  err(text: string): void;
}

export interface RunServiceOptions {
  /** Default: the real manager for this platform. Tests pass a fake. */
  readonly manager?: ServiceManager;
  readonly io?: ServiceIo;
  /** The entry point to check for a fragile place (default: the running nod's). */
  readonly entry?: string;
  readonly tmpdir?: string;
  /**
   * `install`: what the service's nod will see (`preflight.ts`), checked
   * before installing; its problems are printed as warnings. Default: none;
   * `cli.ts` passes the real check.
   */
  readonly preflight?: () => Preflight;
  /** `status`: what the running service says of `gh` on `/health` ({@link fetchHealth}). Default: not asked. */
  readonly health?: (port: number) => Promise<HealthGh | null>;
}

/** `/health`'s `gh`: what a running nod serve sees of GitHub (`Session.ghHealth`). */
export interface HealthGh {
  readonly host: string;
  readonly state: string;
  readonly detail: string | null;
}

/** Asks the nod serve on `port` for its `/health`. null: it does not answer (yet). */
export async function fetchHealth(port: number): Promise<HealthGh | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await r.json()) as { name?: string; gh?: HealthGh };
    return body.name === "nod" && body.gh ? body.gh : null;
  } catch {
    return null;
  }
}

/** The port a service's command serves on (`--port`), else the default. */
export function portOf(command: readonly string[]): number {
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    const value =
      arg === "--port" ? command[i + 1] : arg.startsWith("--port=") ? arg.slice(7) : null;
    if (value && /^\d+$/.test(value)) return Number(value);
  }
  return DEFAULT_SERVE_PORT;
}

const HEALTH_WORDS: Record<string, string> = {
  "signed-in": "signed in",
  "no-gh": "no gh on its PATH",
  "signed-out": "gh is not logged in",
  unreachable: "could not reach GitHub",
};

/** The lines `nod service status` adds: the gh the unit runs, and what the running service sees. */
export function describeGh(status: ServiceStatus, health: HealthGh | null | undefined): string {
  if (status.state !== "running" && status.state !== "installed-stopped") return "";
  const lines: string[] = [];
  if (status.env) {
    const gh = findGh(status.env);
    lines.push(
      `  gh:      ${gh ?? "not found on the service's PATH (nod service install pins it)"}`,
    );
  }
  if (status.state === "running" && health !== undefined)
    lines.push(
      health
        ? `  GitHub:  ${health.host}: ${HEALTH_WORDS[health.state] ?? health.state}${health.detail ? ` (${health.detail})` : ""}`
        : "  GitHub:  the service does not answer on its port yet",
    );
  return lines.map((l) => `${l}\n`).join("");
}

const terminal: ServiceIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** What `nod service status` prints. */
export function describeStatus(status: ServiceStatus): string {
  switch (status.state) {
    case "unsupported":
      return `nod service: not built for ${status.platform} (Linux and macOS only)\n`;
    case "not-installed":
      return "nod service: not installed\n  install it with: nod service install\n";
    case "installed-stopped":
    case "running": {
      const what =
        status.state === "running"
          ? `running${status.pid ? ` (pid ${status.pid})` : ""}`
          : "installed, not running";
      return `nod service: ${what}\n  unit:    ${status.unitPath}\n  command: ${status.command.join(" ")}\n`;
    }
  }
}

/** Runs one `nod service` command; resolves to the exit code. */
export async function runService(
  flags: ServiceFlags,
  options: RunServiceOptions = {},
): Promise<number> {
  const io = options.io ?? terminal;
  const manager = options.manager ?? createServiceManager();
  try {
    switch (flags.command) {
      case "status": {
        const status = await manager.status();
        const health =
          status.state === "running" && options.health
            ? await options.health(portOf(status.command))
            : undefined;
        io.out(describeStatus(status) + describeGh(status, health));
        return status.state === "unsupported" ? 1 : 0;
      }
      case "install": {
        const entry = options.entry ?? currentNod().entry;
        if (isFragileEntry(entry, options.tmpdir ?? tmpdir()))
          io.err(
            `nod service: warning: ${entry} looks like a cache or temp folder; the service would break when it is cleaned. Install nod properly, or run this from a checkout.\n`,
          );
        // What the service's nod will see, checked in its environment before it starts.
        const problems = options.preflight ? preflightProblems(options.preflight()) : [];
        const status = await manager.install({ args: flags.serveArgs });
        io.out(describeStatus(status) + describeGh(status, undefined));
        for (const problem of problems) io.err(`nod service: warning: ${problem}\n`);
        if (manager.kind === "systemd")
          io.out("\nTo keep it running when you are logged out, once:\n  loginctl enable-linger\n");
        io.out(
          manager.kind === "systemd"
            ? "\nIt prints the link to pair a browser into the journal:\n  journalctl --user -u nod.service\n"
            : manager.kind === "launchd"
              ? "\nIt prints the link to pair a browser into its log:\n  ~/Library/Logs/nod/nod.log\n"
              : "",
        );
        return 0;
      }
      case "uninstall": {
        const before = await manager.status();
        await manager.uninstall();
        io.out(
          before.state === "not-installed"
            ? "nod service: it was not installed\n"
            : "nod service: stopped and removed\n",
        );
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      io.err(`nod service ${flags.command}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
