/**
 * `$XDG_CONFIG_HOME/nod/config.json`: the repo list `nod serve` reads (ADR
 * 0007, 2), next to the key file and the pairing token.
 *
 * ```json
 * { "nod": "config", "version": 1,
 *   "repos": [{ "host": "github.com", "repo": "tallyho/fieldbook" },
 *             { "host": "acme.ghe.com", "repo": "finance/ledger" }] }
 * ```
 *
 * - **Tolerant reader.** A missing file is an empty list. Keys it does not
 *   know are kept on every write (an update channel, written by another part
 *   of nod into the same file, survives a `nod repo add`). An entry it
 *   cannot read is skipped and named in `skipped`, and stays in the file.
 * - **Careful writer.** Every change is read, change, write, from the file
 *   as it is now (so a second writer's keys survive), through a temp file and
 *   a rename in the same folder. A file that is not JSON, or of a newer
 *   version, is never written over: the change throws {@link ConfigError}.
 * - The cache of nod's own clones is `$XDG_CACHE_HOME/nod` ({@link cacheDir}).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { GITHUB_COM, hostName } from "../kit/host.ts";
import { repoKey, sameRepo, type RepoKey } from "../shared/repo-key";
import { configDir } from "./token";

export const CONFIG_VERSION = 1;

/** One repo of the list: its GitHub host and `owner/name`. */
export interface ConfigRepo {
  /** Lowercase host name: `github.com`, `acme.ghe.com`. */
  readonly host: string;
  /** `owner/name`, as GitHub spells it. */
  readonly repo: string;
}

export interface ConfigRead {
  readonly repos: ReadonlyArray<ConfigRepo>;
  /** Entries that could not be read, as sentences for the log; they stay in the file. */
  readonly skipped: ReadonlyArray<string>;
  /** Why the file could not be read at all; null: it could (or there is none). */
  readonly unreadable: string | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** `$XDG_CONFIG_HOME/nod/config.json`, else `~/.config/nod/config.json`. */
export function defaultConfigFile(env?: Readonly<Record<string, string | undefined>>): string {
  return join(configDir(env), "config.json");
}

/** `$XDG_CACHE_HOME/nod`, else `~/.cache/nod`: nod's own clones live under `clones/`. */
export function cacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string {
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && xdg.startsWith("/") ? xdg : join(home, ".cache"), "nod");
}

/** The key of a config entry. */
export const keyOf = (r: ConfigRepo): RepoKey => repoKey(r.host, r.repo);

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function readEntry(entry: unknown): ConfigRepo | string {
  if (!entry || typeof entry !== "object") return `not an object: ${JSON.stringify(entry)}`;
  const e = entry as { host?: unknown; repo?: unknown };
  const host =
    typeof e.host === "string" ? hostName(e.host) : e.host === undefined ? GITHUB_COM : null;
  if (!host) return `no GitHub host: ${JSON.stringify(entry)}`;
  if (typeof e.repo !== "string" || !NAME.test(e.repo) || /\/\.\.?$/.test(e.repo))
    return `no owner/name: ${JSON.stringify(entry)}`;
  return { host, repo: e.repo };
}

/** The file as JSON: null when there is none; throws `ConfigError` when it is not readable. */
function load(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`${file} cannot be read: ${(error as Error).message}`);
  }
  if (!text.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`${file} is not JSON; fix it or move it away.`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new ConfigError(`${file} is not a JSON object; fix it or move it away.`);
  return json as Record<string, unknown>;
}

/** Reads the repo list; never throws (a broken file reads as empty, and says why). */
export function readConfig(file: string): ConfigRead {
  let json: Record<string, unknown> | null;
  try {
    json = load(file);
  } catch (error) {
    return { repos: [], skipped: [], unreadable: (error as Error).message };
  }
  if (!json) return { repos: [], skipped: [], unreadable: null };
  const repos: ConfigRepo[] = [];
  const skipped: string[] = [];
  const list = json.repos;
  if (list !== undefined && !Array.isArray(list))
    return { repos, skipped: [`"repos" is not a list`], unreadable: null };
  for (const entry of (list as unknown[] | undefined) ?? []) {
    const read = readEntry(entry);
    if (typeof read === "string") skipped.push(read);
    else if (repos.some((r) => sameRepo(keyOf(r), keyOf(read))))
      skipped.push(`listed twice: ${keyOf(read)}`);
    else repos.push(read);
  }
  return { repos, skipped, unreadable: null };
}

/**
 * One top-level key of the file, as JSON: undefined when the key, the file or
 * the file's JSON is missing. Never throws. For the keys other parts of nod
 * keep in this file, such as the update channel.
 */
export function readConfigValue(file: string, key: string): unknown {
  try {
    return load(file)?.[key];
  } catch {
    return undefined;
  }
}

/** The file's modification time (ms), or null when there is none: to notice another writer. */
export function configStamp(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Changes the file: `change` gets its JSON as it is now (an empty object
 * when there is none) and returns the new one, or null to leave the file as
 * it is. Unknown keys pass through. Writes through a temp file and a rename.
 * Throws `ConfigError` for a file it must not write over.
 */
export function updateConfig(
  file: string,
  change: (json: Record<string, unknown>) => Record<string, unknown> | null,
): void {
  const json = load(file) ?? {};
  const version = json.version;
  if (typeof version === "number" && version > CONFIG_VERSION)
    throw new ConfigError(
      `${file} was written by a newer nod (version ${version}); update nod to change it.`,
    );
  const changed = change(json);
  if (!changed) return;
  const next = { ...changed, nod: "config", version: CONFIG_VERSION };
  // `nod` and `version` first, the way the file is documented.
  const { nod, version: v, ...rest } = next;
  writeAtomic(file, `${JSON.stringify({ nod, version: v, ...rest }, null, 2)}\n`);
}

function writeAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new ConfigError(`writing ${file} failed: ${(error as Error).message}`);
  }
}

/**
 * Adds a repo at the end of the list; a repo listed already is left where it
 * is (false). The entries it cannot read stay.
 */
export function addConfigRepo(file: string, repo: ConfigRepo): boolean {
  let added = false;
  updateConfig(file, (json) => {
    const list = Array.isArray(json.repos) ? [...(json.repos as unknown[])] : [];
    const has = list.some((e) => {
      const r = readEntry(e);
      return typeof r !== "string" && sameRepo(keyOf(r), keyOf(repo));
    });
    if (has) return null;
    list.push({ host: repo.host, repo: repo.repo });
    added = true;
    return { ...json, repos: list };
  });
  return added;
}

/** Removes a repo (every entry of it) from the list; false when it was not listed. */
export function removeConfigRepo(file: string, key: RepoKey): boolean {
  let removed = false;
  updateConfig(file, (json) => {
    const list = Array.isArray(json.repos) ? (json.repos as unknown[]) : [];
    const kept = list.filter((e) => {
      const r = readEntry(e);
      const hit = typeof r !== "string" && sameRepo(keyOf(r), key);
      if (hit) removed = true;
      return !hit;
    });
    return removed ? { ...json, repos: kept } : null;
  });
  return removed;
}
