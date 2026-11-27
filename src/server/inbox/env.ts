/**
 * The inbox subprocess's environment (ADR 0009 decision 8): built from an
 * allow-list, never by removing names from nod's own.
 *
 * It gets: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`,
 * `TMPDIR`, and the XDG base folders (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
 * `XDG_DATA_HOME`, `XDG_STATE_HOME`, filled in with their defaults when
 * unset), plus `NO_COLOR=1`.
 *
 * It never gets: a GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise
 * ones), nod's own variables (`NOD_*`), git's (`GIT_*`, so no credentials
 * for lazy fetches either: the server does the git I/O), `SSH_AUTH_SOCK`,
 * proxy settings, or anything else. The socket token and the signing key
 * are never in an environment in the first place; the subprocess holds no
 * handle to the server but its stdio.
 *
 * Not a sandbox: the subprocess runs as the user and can read whatever the
 * user can, nod's own files included. The scrub keeps nod from handing
 * secrets to personal code; it does not stop that code from looking.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Names passed through when set. */
export const PASSED: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TZ",
  "TMPDIR",
];

/** The XDG base folders, with their defaults under `HOME`. */
const XDG: Readonly<Record<string, string>> = {
  XDG_CONFIG_HOME: ".config",
  XDG_CACHE_HOME: ".cache",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
};

/** The subprocess's environment, from `from` (default: nod's own). */
export function inboxEnv(
  from: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const v = from[name];
    if (v) env[name] = v;
  }
  for (const [name, v] of Object.entries(from)) if (/^LC_[A-Z_]+$/.test(name) && v) env[name] = v;
  const home = env.HOME ?? homedir();
  for (const [name, rel] of Object.entries(XDG)) env[name] = from[name] || join(home, rel);
  env.NO_COLOR = "1";
  return env;
}
