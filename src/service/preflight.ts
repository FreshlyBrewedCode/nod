/**
 * What the service's nod will see, checked at install (`nod service install`
 * and "Run nod in the background"): whether its environment finds `gh` and
 * `git`, and whether `gh` is logged in there for each host nod reads.
 *
 * The service gets the environment `captureEnv` writes into the unit, and
 * from the service manager `HOME`, the user and, on Linux, the session bus
 * (the keyring `gh` may keep its token in). The check runs `gh auth token`
 * in that environment, so a terminal whose `gh` is logged in only through
 * `GH_TOKEN` (which no unit gets: no token is written to disk) is told so
 * before the service starts, not by a sign-in page afterwards. The token
 * `gh` prints is thrown away at once.
 */

import { GITHUB_COM, ghLoginCommand } from "../kit/host.ts";
import { GH_TOKEN_VARS, ghToken, isToken, onPath, type GhToken } from "../server/github/gh";
import { captureEnv, CAPTURED_ENV, hasCredentials } from "./spec";

export interface PreflightHost {
  readonly host: string;
  readonly ok: boolean;
  /** What `gh` said when it has no login there. */
  readonly detail: string | null;
}

export interface Preflight {
  /** The `gh` the service runs; null: none on its PATH. */
  readonly gh: string | null;
  /** The `git` on its PATH; null: none. */
  readonly git: string | null;
  /** Per host nod reads: is `gh` logged in there in the service's environment. Empty without `gh`. */
  readonly hosts: ReadonlyArray<PreflightHost>;
  /** Token variables this environment sets, which the service does not get. Names only. */
  readonly tokenVars: ReadonlyArray<string>;
  /** Proxy variables left out of the unit for the password in them. Names only. */
  readonly droppedProxies: ReadonlyArray<string>;
}

/** What the service manager adds to the unit's environment, as far as it matters to `gh`. */
const FROM_THE_MANAGER = ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/**
 * Checks the service's environment, as captured from `env`, for `hosts`.
 * `token` is the seam for tests (default: the real `gh auth token`).
 */
export function servicePreflight(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly hosts: ReadonlyArray<string>;
  readonly token?: (host: string, env: NodeJS.ProcessEnv) => GhToken;
}): Preflight {
  const unit = captureEnv(input.env);
  const env: Record<string, string> = { ...unit };
  for (const name of FROM_THE_MANAGER) {
    const value = input.env[name];
    if (value && env[name] === undefined) env[name] = value;
  }
  const gh = unit.NOD_GH ?? null;
  const token = input.token ?? ghToken;
  const hosts = gh
    ? [...new Set(input.hosts)].map((host) => {
        const r = token(host, env);
        return { host, ok: isToken(r), detail: isToken(r) ? null : r.detail };
      })
    : [];
  return {
    gh,
    git: onPath("git", unit.PATH),
    hosts,
    tokenVars: GH_TOKEN_VARS.filter((name) => input.env[name]),
    droppedProxies: CAPTURED_ENV.filter(
      (name) => /proxy/i.test(name) && input.env[name] && hasCredentials(input.env[name]!),
    ),
  };
}

/**
 * The hosts the service will read: `--host` among the serve flags, else
 * the repo list's hosts, else github.com (the account of an empty list).
 */
export function hostsToCheck(
  serveArgs: ReadonlyArray<string>,
  listed: ReadonlyArray<string>,
): string[] {
  const at = serveArgs.indexOf("--host");
  const flag =
    at >= 0 ? serveArgs[at + 1] : serveArgs.find((a) => a.startsWith("--host="))?.slice(7);
  if (flag) return [flag.toLowerCase()];
  return listed.length ? [...new Set(listed)] : [GITHUB_COM];
}

/** Whether the service would show the sign-in page: no `gh`, or a host `gh` is not logged in to. */
export function blocksSignIn(p: Preflight): boolean {
  return p.gh === null || p.hosts.some((h) => !h.ok);
}

/** What is wrong, one sentence each, for the terminal and the page. Empty: nothing. */
export function preflightProblems(p: Preflight): string[] {
  const out: string[] = [];
  if (p.gh === null)
    out.push(
      "The service would find no `gh` on its PATH, so it could not read GitHub. Install the GitHub CLI, or run `nod service install` from a terminal where `gh auth status` works.",
    );
  for (const h of p.hosts.filter((h) => !h.ok)) {
    const login = ghLoginCommand(h.host);
    out.push(
      p.tokenVars.length
        ? `\`gh\` is not logged in to ${h.host} without ${p.tokenVars.join(" or ")}, which your shell sets and a service does not get (nod writes no token into a file). Run \`${login}\` so gh keeps its own login, then \`nod service install\` again.`
        : `\`gh\` (${p.gh}) is not logged in to ${h.host} in the service's environment${h.detail ? ` (gh: ${h.detail})` : ""}. Run \`${login}\`, then \`nod service install\` again.`,
    );
  }
  if (p.git === null)
    out.push("The service would find no `git` on its PATH: nod needs it to compare commits.");
  for (const name of p.droppedProxies)
    out.push(
      `${name} has a password in it, so it is not written into the service: the service reaches GitHub without that proxy.`,
    );
  return out;
}
