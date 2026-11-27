/**
 * What a service runs, independent of the service manager: the command (the
 * same nod that installed it), its working folder and its environment.
 */

import { findGh as defaultFindGh } from "../server/github/gh";

/** The nod that is running: the runtime and the entry point it was started with, both absolute. */
export interface NodInvocation {
  readonly runtime: string;
  readonly entry: string;
}

/** What the unit and the plist are rendered from. */
export interface ServiceSpec {
  /** argv: runtime, entry point, `serve`, the serve flags. */
  readonly command: readonly string[];
  /** The folder `nod serve` runs in (its `--dir` default). Absolute. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Where the service's output goes, for service managers without a journal (launchd). */
  readonly logFile?: string;
}

/** Thrown for a service that cannot be installed, started or described. */
export class ServiceError extends Error {
  constructor(
    readonly code: "unsupported" | "not-installed" | "invalid" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** The nod that is running now: Bun and the script it was started with. */
export function currentNod(): NodInvocation {
  return { runtime: process.execPath, entry: Bun.main };
}

/** The command a service runs: `<runtime> <entry> serve <flags>`. */
export function serviceCommand(nod: NodInvocation, args: readonly string[]): readonly string[] {
  return [nod.runtime, nod.entry, "serve", ...args];
}

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The environment a service gets, captured at install: `PATH` (so it finds
 * `gh` and `git`), `HOME`, the variables that say where nod's and gh's files
 * are, and how this machine reaches GitHub (a proxy, extra CA certificates).
 * Tokens are never captured: they would end up in a file on disk; `gh`
 * gets its login from its own config (or keyring). A proxy URL with a
 * password in it is left out for the same reason (`preflight.ts` says so).
 */
export const CAPTURED_ENV = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "GH_CONFIG_DIR",
  "NOD_WEB_URL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** A proxy URL that carries a user and password: not written into a unit file. */
export const hasCredentials = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(value);

const PROXY = /^(https?|no)_proxy$/i;

/**
 * The service's environment: {@link CAPTURED_ENV} as it is now, plus
 * `NOD_GH`, the absolute path of the `gh` this environment finds (the
 * service runs that one even when its PATH would find another, or none),
 * and `NOD_SERVICE=1`, so the service's nod knows it is one (its sign-in
 * page says the service's environment is what counts).
 */
export function captureEnv(
  env: NodeJS.ProcessEnv,
  findGh: (env: NodeJS.ProcessEnv) => string | null = defaultFindGh,
): Record<string, string> {
  const captured: Record<string, string> = { PATH: env.PATH || DEFAULT_PATH };
  for (const name of CAPTURED_ENV) {
    const value = env[name];
    if (name === "PATH" || !value) continue;
    if (PROXY.test(name) && hasCredentials(value)) continue;
    captured[name] = value;
  }
  const gh = findGh({ ...env, PATH: captured.PATH });
  if (gh) captured.NOD_GH = gh;
  captured.NOD_SERVICE = "1";
  return captured;
}

/**
 * Whether `entry` lives somewhere that is cleaned up (the `bunx` cache, a
 * temp folder), so a service pointing at it would break later.
 */
export function isFragileEntry(entry: string, tmpdir: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  const tmp = tmpdir.replaceAll("\\", "/").replace(/\/$/, "");
  return (
    normalized.startsWith(`${tmp}/`) || /\/(bunx-[^/]*|install\/cache|_npx)\//.test(normalized)
  );
}
