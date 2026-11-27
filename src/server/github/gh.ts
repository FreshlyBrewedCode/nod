/**
 * `gh`, as `nod serve` and `nod service install` find it: its path (the
 * absolute one `nod service install` pins as `NOD_GH`, else the first on the
 * PATH) and its token for a host (`gh auth token --hostname <host>`).
 *
 * The token is never logged or shown. What `gh` says when it has none is
 * kept, as one line with anything token-shaped taken out: it is what tells
 * "no login" from "the keyring is locked" on the user's machine.
 */

import { statSync } from "node:fs";

/** Why there is no token: no `gh` at all, or `gh` without a login for the host. */
export interface GhFailure {
  readonly state: "no-gh" | "signed-out";
  /** The `gh` that was asked; null when none was found. */
  readonly path: string | null;
  readonly detail: string | null;
}

/** A token, and the `gh` that gave it. */
export interface GhTokenFound {
  readonly token: string;
  readonly path: string;
}

export type GhToken = GhTokenFound | GhFailure;

/** The variables that log `gh` in without its own config. A service never gets them (no token is written to disk). */
export const GH_TOKEN_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/** How long `gh auth token` may take (a keyring that asks for a password never answers). */
const GH_TIMEOUT_MS = 15_000;

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `name` on `PATH`, absolute (symlinks kept: a nix or Homebrew profile link outlives the store path). */
export function onPath(name: string, PATH: string | undefined): string | null {
  return PATH ? Bun.which(name, { PATH }) : null;
}

/** The `gh` this environment runs: `NOD_GH` when it is there, else the first on the PATH. */
export function findGh(env: NodeJS.ProcessEnv = process.env): string | null {
  const pinned = env.NOD_GH;
  if (pinned && isFile(pinned)) return pinned;
  return onPath("gh", env.PATH);
}

/** One line of a program's output for the user: the first non-empty one, tokens taken out, at most 200 characters. */
export function oneLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const clean = line.replace(/\b(gh[opsur]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, "[token]");
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/**
 * The token `gh` holds for `host`, or why there is none. Runs `gh auth
 * token --hostname <host>` (an argument array, never a shell) in `env`.
 */
export function ghToken(host: string, env: NodeJS.ProcessEnv = process.env): GhToken {
  const path = findGh(env);
  if (!path) return { state: "no-gh", path: null, detail: null };
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync([path, "auth", "token", "--hostname", host], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: GH_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      state: "no-gh",
      path,
      detail: oneLine(error instanceof Error ? error.message : String(error)),
    };
  }
  const token = r.stdout?.toString().trim() ?? "";
  if (r.exitCode === 0 && token) return { token, path };
  const said = oneLine(r.stderr?.toString() ?? "");
  return {
    state: "signed-out",
    path,
    detail:
      said ??
      (r.signalCode
        ? `gh auth token did not answer within ${GH_TIMEOUT_MS / 1000} s`
        : `gh auth token exited with ${r.exitCode}`),
  };
}

/** Whether a {@link ghToken} result is a token. */
export function isToken(r: GhToken): r is GhTokenFound {
  return "token" in r;
}
