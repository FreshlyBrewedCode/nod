/**
 * `nod repo add | remove | list`: the repo list `nod serve` reads, from a
 * terminal (ADR 0007, 2). The list is `$XDG_CONFIG_HOME/nod/config.json`
 * (`config.ts`); a running `nod serve` picks a change up before its next
 * poll. `add` checks the repo on GitHub with `gh`'s login for its host and
 * makes nod's own clone of it; `remove` leaves the clone in the cache.
 */

import { existsSync } from "node:fs";
import { parseArgs as parseFlags } from "node:util";

import { githubHost, type GitHubHost } from "../kit/host.ts";
import { parseRepoInput, repoKey } from "../shared/repo-key";
import {
  addConfigRepo,
  cacheDir as defaultCacheDir,
  defaultConfigFile,
  keyOf,
  readConfig,
  removeConfigRepo,
} from "./config";
import { GitHubApi } from "./github/api";
import { OwnClone, ownClonePath } from "./github/clone";
import { resolveRepo } from "./github/suggest";
import { ghToken } from "./github-source";

export type RepoCommand = "add" | "remove" | "list";

export interface RepoFlags {
  readonly command: RepoCommand;
  /** `add`, `remove`: what was typed. */
  readonly repo: string | null;
  /** `add`: do not clone now (the first patch-id does). */
  readonly noClone: boolean;
}

export const REPO_HELP = `repo commands (the list nod serve reads, in $XDG_CONFIG_HOME/nod/config.json):
  repo list           the repositories in the list, in order
  repo add <repo>     add one: owner/name (github.com), host/owner/name or
                      its URL; checks it on GitHub with gh's login for its
                      host, and clones it (blobless) into
                      $XDG_CACHE_HOME/nod/clones/
    --no-clone        do not clone now: nod serve clones on first use
  repo remove <repo>  take one off the list; its clone stays in the cache
`;

export function parseRepoArgs(
  args: readonly string[],
): { kind: "repo"; flags: RepoFlags } | { kind: "help" } | { kind: "error"; message: string } {
  let parsed;
  try {
    parsed = parseFlags({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        "no-clone": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  const [command, repo, ...extra] = positionals;
  if (command !== "add" && command !== "remove" && command !== "list")
    return { kind: "error", message: "nod repo needs one of: add, remove, list" };
  if (command === "list" && repo !== undefined)
    return { kind: "error", message: `unexpected argument: ${repo}` };
  if (command !== "list" && repo === undefined)
    return { kind: "error", message: `nod repo ${command} needs a repository: owner/name` };
  if (extra.length) return { kind: "error", message: `unexpected argument: ${extra[0]}` };
  if (values["no-clone"] && command !== "add")
    return { kind: "error", message: "--no-clone goes with nod repo add" };
  return {
    kind: "repo",
    flags: { command, repo: repo ?? null, noClone: values["no-clone"] },
  };
}

export interface RepoDeps {
  readonly configFile?: string;
  readonly cacheDir?: string;
  /** Test seams: a host's token, its `fetch`, where to clone from. */
  readonly token?: (host: string) => string | null;
  readonly fetch?: (host: GitHubHost) => typeof fetch;
  readonly cloneUrl?: (host: GitHubHost, name: string) => string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/** Runs `nod repo …`; resolves to the exit code. */
export async function runRepo(flags: RepoFlags, deps: RepoDeps = {}): Promise<number> {
  const file = deps.configFile ?? defaultConfigFile();
  const cache = deps.cacheDir ?? defaultCacheDir();
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const token = deps.token ?? ghToken;

  if (flags.command === "list") {
    const read = readConfig(file);
    if (read.unreadable) {
      err(`nod repo: ${read.unreadable}`);
      return 1;
    }
    if (!read.repos.length)
      out(`no repositories in ${file}; add one with \`nod repo add owner/name\``);
    else {
      const keys = read.repos.map(keyOf);
      const width = Math.max(...keys.map((k) => k.length));
      for (const [i, r] of read.repos.entries()) {
        const clone = ownClonePath(cache, r.host, r.repo);
        out(`${keys[i]!.padEnd(width)}  ${existsSync(clone) ? clone : "not cloned yet"}`);
      }
    }
    for (const s of read.skipped) err(`nod repo: ${file}: skipped an entry, ${s}`);
    return 0;
  }

  const parsed = parseRepoInput(flags.repo!);
  if (!parsed) {
    err(
      `nod repo: "${flags.repo}" is not a repository: use owner/name, host/owner/name or its GitHub URL.`,
    );
    return 2;
  }

  try {
    if (flags.command === "remove") {
      const key = repoKey(parsed.host, parsed.name);
      if (!removeConfigRepo(file, key)) {
        err(`nod repo: ${key} is not in ${file}.`);
        return 1;
      }
      const clone = ownClonePath(cache, parsed.host, parsed.name);
      out(`removed ${key}`);
      if (existsSync(clone))
        out(`  its clone stays in the cache: ${clone} (delete it by hand if you like)`);
      return 0;
    }

    const host = githubHost(parsed.host);
    const t = token(host.name);
    const api = t
      ? new GitHubApi({ token: t, host, ...(deps.fetch && { fetch: deps.fetch(host) }) })
      : null;
    const name = await resolveRepo(api, host, parsed.name);
    const key = repoKey(host.name, name);
    if (!addConfigRepo(file, { host: host.name, repo: name })) {
      out(`${key} is in the list already`);
      return 0;
    }
    out(`added ${key} to ${file}`);
    if (flags.noClone) return 0;
    const clone = new OwnClone({
      dir: ownClonePath(cache, host.name, name),
      host,
      name,
      token: () => t,
      ...(deps.cloneUrl && { url: deps.cloneUrl(host, name) }),
    });
    if (clone.exists()) return 0;
    out(`cloning it (blobless) into ${clone.dir}…`);
    try {
      await clone.ensure();
    } catch (error) {
      // Not fatal: nod serve clones again on first use.
      err(`nod repo: ${error instanceof Error ? error.message : String(error)}`);
      err("  nod serve tries again when it first needs the clone.");
    }
    return 0;
  } catch (error) {
    err(`nod repo: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
