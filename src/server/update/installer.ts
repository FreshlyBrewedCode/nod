/**
 * The installer seam: how nod was installed, the command that installs a
 * version or dist-tag the same way, and a `run()` that executes it through an
 * injectable {@link Runner}.
 *
 * - The install method is read from the running entry point's path (where the
 *   package manager put the package): `~/.bun/install/global/...` is bun,
 *   `.../lib/node_modules/@frebreco/nod` is npm, `.../pnpm/global/...` is
 *   pnpm, `.../yarn/global/...` is yarn. A checkout, a `bunx`/`npx` cache and
 *   anything unknown give `null`: the UI then shows the command only.
 * - Commands are argument arrays, never a shell string; the string form is
 *   for display. The target is a semver version or a dist-tag, checked
 *   against a strict pattern.
 * - **Tests never run a real install**: `createInstaller` takes the runner,
 *   and `FakeInstaller` (`fake-installer.ts`) stands in for the whole thing.
 * - Windows is later: no install method is detected there.
 */

import { spawn } from "node:child_process";

export const PACKAGE_NAME = "@frebreco/nod";

export type InstallMethod = "npm" | "bun" | "pnpm" | "yarn";

/** What the settings page needs to know of the installer. */
export interface InstallInfo {
  readonly method: InstallMethod | null;
  /** The command for the update on offer, for display; null when the method is unknown. */
  readonly command: string | null;
}

/** An install's outcome. `output` is the tail of stdout and stderr. */
export interface InstallResult {
  readonly ok: boolean;
  /** The exit code; null when the process never started or was killed. */
  readonly code: number | null;
  readonly output: string;
}

export interface Installer {
  readonly method: InstallMethod | null;
  /** The install command for a version or dist-tag as one line, or null when the method is unknown. */
  command(target: string): string | null;
  /** Runs it. Never throws: a failure is `{ ok: false }` with what the process said. */
  run(target: string): Promise<InstallResult>;
}

/** Runs one program with an argument array (never a shell) and reports how it ended. */
export type Runner = (
  program: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<{ readonly code: number | null; readonly output: string }>;

/** How much of an install's output is kept. */
export const OUTPUT_TAIL = 4000;

export function tail(text: string, max = OUTPUT_TAIL): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}

/** A version (`0.2.0`, `0.2.0-next.6`) or a dist-tag (`next`, `latest`): nothing a package manager reads as a flag or a path. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function isInstallTarget(target: string): boolean {
  return TARGET.test(target) && target.length <= 64;
}

/** The program and arguments that install `target` globally with `method`; null for a target that is not safe. */
export function installArgs(
  method: InstallMethod,
  target: string,
): { program: string; args: string[] } | null {
  if (!isInstallTarget(target)) return null;
  const spec = `${PACKAGE_NAME}@${target}`;
  switch (method) {
    case "npm":
      return { program: "npm", args: ["install", "-g", spec] };
    case "bun":
      return { program: "bun", args: ["add", "-g", spec] };
    case "pnpm":
      return { program: "pnpm", args: ["add", "-g", spec] };
    case "yarn":
      return { program: "yarn", args: ["global", "add", spec] };
  }
}

/** The command line, for display. */
export function installCommand(method: InstallMethod, target: string): string | null {
  const cmd = installArgs(method, target);
  return cmd ? [cmd.program, ...cmd.args].join(" ") : null;
}

/**
 * How the package at `entryPath` was installed. `entryPath` is the real path
 * of the running `nod` (symlinks resolved): the bin symlink in a global `bin/`
 * dir points into the package manager's own tree, which is what gives it away.
 */
export function detectInstallMethod(entryPath: string | null | undefined): InstallMethod | null {
  if (!entryPath) return null;
  const path = entryPath.replaceAll("\\", "/");
  // Where the package lives, and only there: a checkout of nod itself, or an
  // unrelated project that happens to sit under a `node_modules`, is not an install.
  if (!path.includes(`/node_modules/${PACKAGE_NAME}/`)) return null;
  // Throwaway runs: nothing to update.
  if (
    /\/\.bun\/install\/cache\//.test(path) ||
    /\/_npx\//.test(path) ||
    /\/\.cache\/bunx/.test(path)
  )
    return null;
  if (/\/\.bun\/install\/global\//.test(path)) return "bun";
  // pnpm: <home>/pnpm/global/5/node_modules/.pnpm/@frebreco+nod@x/node_modules/@frebreco/nod
  if (/\/pnpm\/global\//.test(path) || /\/\.pnpm\//.test(path)) return "pnpm";
  // yarn classic: ~/.config/yarn/global/node_modules/@frebreco/nod
  if (/\/yarn\/global\//.test(path) || /\/\.yarn\/global\//.test(path)) return "yarn";
  // npm: <prefix>/lib/node_modules/@frebreco/nod (nvm, volta, system prefixes alike).
  if (/\/lib\/node_modules\/@frebreco\/nod\//.test(path)) return "npm";
  return null;
}

export interface InstallerOptions {
  /** The real path of the running entry point (`realpath(process.argv[1])`). */
  readonly entryPath?: string | null;
  /** Overrides detection (a `--install-method` flag, a test). */
  readonly method?: InstallMethod | null;
  readonly runner?: Runner;
  /** Default `process.platform`. */
  readonly platform?: string;
  /** An install gets this long (default 5 minutes). */
  readonly timeoutMs?: number;
}

export function createInstaller(options: InstallerOptions = {}): Installer {
  const platform = options.platform ?? process.platform;
  const detected =
    options.method !== undefined ? options.method : detectInstallMethod(options.entryPath);
  const method = platform === "win32" ? null : detected;
  const runner = options.runner ?? spawnRunner;
  return {
    method,
    command: (target) => (method ? installCommand(method, target) : null),
    async run(target) {
      const cmd = method ? installArgs(method, target) : null;
      if (!method || !cmd)
        return {
          ok: false,
          code: null,
          output: method
            ? `"${target}" is not a version or dist-tag nod can install.`
            : "nod does not know how it was installed.",
        };
      try {
        const done = await runner(cmd.program, cmd.args, {
          timeoutMs: options.timeoutMs ?? 300_000,
        });
        return { ok: done.code === 0, code: done.code, output: tail(done.output) };
      } catch (error) {
        return {
          ok: false,
          code: null,
          output: tail(error instanceof Error ? error.message : String(error)),
        };
      }
    },
  };
}

/**
 * The real runner: one child process, arguments as an array (no shell), the
 * output of both streams kept (its tail). Only `createInstaller`'s default
 * uses it, and tests never do with a package manager.
 */
export const spawnRunner: Runner = (program, args, options) =>
  new Promise((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL * 2);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = options?.timeoutMs
      ? setTimeout(() => {
          output += `\n(stopped after ${Math.round(options.timeoutMs! / 1000)} s)`;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output });
    });
  });
