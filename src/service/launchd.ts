/**
 * The macOS LaunchAgent (`~/Library/LaunchAgents/de.frebreco.nod.plist`):
 * rendering and reading it back are pure functions; `LaunchdManager` writes
 * it and drives `launchctl` through the injected runner.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProcessRunner } from "./runner";
import { ServiceError, serviceCommand, type NodInvocation, type ServiceSpec } from "./spec";
import type { ServiceManager, ServiceStatus } from "./manager";

export const LAUNCHD_LABEL = "de.frebreco.nod";

const xml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const unxml = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/** The plist for `spec`. */
export function renderLaunchdPlist(spec: ServiceSpec): string {
  const logs = spec.logFile
    ? [
        `  <key>StandardOutPath</key>`,
        `  <string>${xml(spec.logFile)}</string>`,
        `  <key>StandardErrorPath</key>`,
        `  <string>${xml(spec.logFile)}</string>`,
      ]
    : [];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- Written by \`nod service install\`; \`nod service uninstall\` removes it. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...spec.command.map((part) => `    <string>${xml(part)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(spec.cwd)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(spec.env).flatMap(([name, value]) => [
      `    <key>${xml(name)}</key>`,
      `    <string>${xml(value)}</string>`,
    ]),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    ...logs,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** The `ProgramArguments` of a plist (as written above), or null. */
export function parsePlistProgramArguments(plist: string): string[] | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!array) return null;
  return [...array[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]!));
}

/** `launchctl print gui/<uid>/<label>` output: whether it runs, and its pid. */
export function parseLaunchctlPrint(output: string): { active: boolean; pid: number | null } {
  const state = /^\s*state = (\S+)/m.exec(output)?.[1];
  const pid = Number(/^\s*pid = (\d+)/m.exec(output)?.[1]);
  return { active: state === "running", pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

export interface LaunchdOptions {
  readonly runner: ProcessRunner;
  /** The `Library/LaunchAgents` folder. */
  readonly agentsDir: string;
  /** Where the service's output goes (`Library/Logs/nod/nod.log`). */
  readonly logFile: string;
  /** The user id: the agent lives in the domain `gui/<uid>`. */
  readonly uid: number;
  readonly nod: NodInvocation;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export class LaunchdManager implements ServiceManager {
  readonly kind = "launchd";
  readonly unitPath: string;
  private readonly target: string;

  constructor(private readonly options: LaunchdOptions) {
    this.unitPath = join(options.agentsDir, `${LAUNCHD_LABEL}.plist`);
    this.target = `gui/${options.uid}/${LAUNCHD_LABEL}`;
  }

  async status(): Promise<ServiceStatus> {
    let plist: string;
    try {
      plist = await readFile(this.unitPath, "utf8");
    } catch {
      return { state: "not-installed" };
    }
    const command = parsePlistProgramArguments(plist) ?? [];
    const printed = await this.options
      .runner("launchctl", ["print", this.target])
      .catch(() => null);
    const { active, pid } =
      printed?.status === 0 ? parseLaunchctlPrint(printed.stdout) : { active: false, pid: null };
    return active
      ? { state: "running", unitPath: this.unitPath, command, pid }
      : { state: "installed-stopped", unitPath: this.unitPath, command };
  }

  async install({ args }: { args: readonly string[] }): Promise<ServiceStatus> {
    const { nod, cwd, env, logFile } = this.options;
    const plist = renderLaunchdPlist({ command: serviceCommand(nod, args), cwd, env, logFile });
    await mkdir(this.options.agentsDir, { recursive: true });
    await mkdir(dirname(logFile), { recursive: true });
    await writeFile(this.unitPath, plist, { mode: 0o644 });
    // Load the new plist: an old one, if it is loaded, goes first (it may not be).
    await this.options.runner("launchctl", ["bootout", this.target]).catch(() => null);
    await this.launchctl(["bootstrap", `gui/${this.options.uid}`, this.unitPath]);
    await this.launchctl(["kickstart", "-k", this.target]);
    return this.status();
  }

  async uninstall(): Promise<ServiceStatus> {
    const before = await this.status();
    if (before.state === "not-installed") return before;
    await this.options.runner("launchctl", ["bootout", this.target]).catch(() => null);
    await rm(this.unitPath, { force: true });
    return { state: "not-installed" };
  }

  async restart(): Promise<ServiceStatus> {
    if ((await this.status()).state === "not-installed")
      throw new ServiceError("not-installed", "the service is not installed");
    await this.launchctl(["kickstart", "-k", this.target]);
    return this.status();
  }

  private async launchctl(args: string[]): Promise<void> {
    let result;
    try {
      result = await this.options.runner("launchctl", args);
    } catch (error) {
      throw new ServiceError(
        "failed",
        `could not run launchctl: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.status !== 0)
      throw new ServiceError(
        "failed",
        `launchctl ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
      );
  }
}
