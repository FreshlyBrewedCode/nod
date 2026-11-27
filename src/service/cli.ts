/**
 * `nod service install [serve flags…] | uninstall | status`: `nod serve` in
 * the background, as a systemd user unit (Linux) or a LaunchAgent (macOS).
 * The flags after `install` are `nod serve`'s own, validated by it.
 */

import { tmpdir } from "node:os";

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
                      above; not --open). Run it again to change them
  service uninstall   stop the service and remove it
  service status      not installed, installed but stopped, or running; the
                      unit file and the command it runs
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
        io.out(describeStatus(status));
        return status.state === "unsupported" ? 1 : 0;
      }
      case "install": {
        const entry = options.entry ?? currentNod().entry;
        if (isFragileEntry(entry, options.tmpdir ?? tmpdir()))
          io.err(
            `nod service: warning: ${entry} looks like a cache or temp folder; the service would break when it is cleaned. Install nod properly, or run this from a checkout.\n`,
          );
        const status = await manager.install({ args: flags.serveArgs });
        io.out(describeStatus(status));
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
