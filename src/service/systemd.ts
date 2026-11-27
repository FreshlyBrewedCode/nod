/**
 * The systemd user unit (`~/.config/systemd/user/nod.service`): rendering
 * and reading it back are pure functions; `SystemdManager` writes it and
 * drives `systemctl --user` through the injected runner.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProcessRunner } from "./runner";
import { ServiceError, serviceCommand, type NodInvocation, type ServiceSpec } from "./spec";
import type { ServiceManager, ServiceStatus } from "./manager";

export const SYSTEMD_UNIT = "nod.service";

const quote = (value: string, doubleDollar: boolean): string => {
  if (/[\n\r\0]/.test(value)) throw new ServiceError("invalid", "a service argument has a newline");
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (doubleDollar) escaped = escaped.replace(/\$/g, () => "$$");
  return `"${escaped}"`;
};

/** The unit file for `spec`. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  if (/[\n\r\0]/.test(spec.cwd)) throw new ServiceError("invalid", "the folder has a newline");
  const lines = [
    "# Written by `nod service install`; `nod service uninstall` removes it.",
    "[Unit]",
    "Description=nod, the local server of the nod dashboard",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.cwd.replaceAll("%", "%%")}`,
    `ExecStart=${spec.command.map((part) => quote(part, true)).join(" ")}`,
    ...Object.entries(spec.env).map(
      ([name, value]) => `Environment=${quote(`${name}=${value}`, false)}`,
    ),
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

/** The command line of `ExecStart=` in a unit file (as written above, or by hand), or null. */
export function parseSystemdExecStart(unit: string): string[] | null {
  const line = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  if (line === undefined) return null;
  const text = line.slice("ExecStart=".length).replace(/^[-@:+!]+/, "");
  return splitWords(text).map((part) => part.replaceAll("%%", "%").replaceAll("$$", "$"));
}

/** The `Environment=` variables of a unit file (as written above, or by hand). */
export function parseSystemdEnvironment(unit: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of unit.split("\n")) {
    if (!line.startsWith("Environment=")) continue;
    for (const word of splitWords(line.slice("Environment=".length))) {
      const at = word.indexOf("=");
      if (at > 0) env[word.slice(0, at)] = word.slice(at + 1).replaceAll("%%", "%");
    }
  }
  return env;
}

/** A systemd line's words: whitespace apart, `"…"` quoted with `\` escapes. */
function splitWords(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let has = false;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuote && c === "\\" && i + 1 < text.length) current += text[++i];
    else if (c === '"') {
      inQuote = !inQuote;
      has = true;
    } else if (!inQuote && /\s/.test(c)) {
      if (has) parts.push(current);
      current = "";
      has = false;
    } else {
      current += c;
      has = true;
    }
  }
  if (has) parts.push(current);
  return parts;
}

/** `systemctl --user show --property=ActiveState,MainPID` output: whether it runs, and its pid. */
export function parseSystemdShow(output: string): { active: boolean; pid: number | null } {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const pid = Number(values.get("MainPID"));
  return {
    active: values.get("ActiveState") === "active",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

export interface SystemdOptions {
  readonly runner: ProcessRunner;
  /** The `systemd/user` folder (`<config home>/systemd/user`). */
  readonly unitDir: string;
  readonly nod: NodInvocation;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export class SystemdManager implements ServiceManager {
  readonly kind = "systemd";
  readonly unitPath: string;

  constructor(private readonly options: SystemdOptions) {
    this.unitPath = join(options.unitDir, SYSTEMD_UNIT);
  }

  async status(): Promise<ServiceStatus> {
    let unit: string;
    try {
      unit = await readFile(this.unitPath, "utf8");
    } catch {
      return { state: "not-installed" };
    }
    const command = parseSystemdExecStart(unit) ?? [];
    const env = parseSystemdEnvironment(unit);
    const shown = await this.options
      .runner("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=ActiveState,MainPID"])
      .catch(() => null);
    const { active, pid } =
      shown?.status === 0 ? parseSystemdShow(shown.stdout) : { active: false, pid: null };
    return active
      ? { state: "running", unitPath: this.unitPath, command, env, pid }
      : { state: "installed-stopped", unitPath: this.unitPath, command, env };
  }

  async install({ args }: { args: readonly string[] }): Promise<ServiceStatus> {
    const { nod, cwd, env } = this.options;
    const unit = renderSystemdUnit({ command: serviceCommand(nod, args), cwd, env });
    await mkdir(this.options.unitDir, { recursive: true });
    await writeFile(this.unitPath, unit, { mode: 0o644 });
    await this.systemctl(["daemon-reload"]);
    await this.systemctl(["enable", SYSTEMD_UNIT]);
    await this.systemctl(["restart", SYSTEMD_UNIT]);
    return this.status();
  }

  async uninstall(): Promise<ServiceStatus> {
    const before = await this.status();
    if (before.state === "not-installed") return before;
    // Best effort: a missing systemctl must not keep the unit file around.
    await this.options
      .runner("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT])
      .catch(() => null);
    await rm(this.unitPath, { force: true });
    await this.options.runner("systemctl", ["--user", "daemon-reload"]).catch(() => null);
    return { state: "not-installed" };
  }

  async restart(): Promise<ServiceStatus> {
    if ((await this.status()).state === "not-installed")
      throw new ServiceError("not-installed", "the service is not installed");
    await this.systemctl(["restart", SYSTEMD_UNIT]);
    return this.status();
  }

  private async systemctl(args: string[]): Promise<void> {
    let result;
    try {
      result = await this.options.runner("systemctl", ["--user", ...args]);
    } catch (error) {
      throw new ServiceError(
        "failed",
        `could not run systemctl: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.status !== 0)
      throw new ServiceError(
        "failed",
        `systemctl --user ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
      );
  }
}
