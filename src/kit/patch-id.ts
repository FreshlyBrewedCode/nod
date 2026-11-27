/**
 * The diff a nod is about, computed locally with `git` exactly as ADR 0001
 * defines it, so the signer and the verifier agree byte for byte. Never from
 * the API diff (it detects renames and stops at 300 files) and never from the
 * files API (it stops at 3000 files).
 */
import { readFile } from "node:fs/promises";

import { run } from "./exec.ts";

/** The empty tree: used as `--attr-source`, so `.gitattributes` from the PR cannot change the diff. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Flags of the patch-id diff (ADR 0001). The extra ones beyond the ADR pin
 * settings a local config could change to their git defaults.
 */
export const PATCH_ID_DIFF_ARGS: readonly string[] = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--full-index",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "-U3",
  "--inter-hunk-context=0",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--ignore-submodules=none",
  "--submodule=short",
  "--no-relative",
];

// Config the repo's own `.git/config` could set; `-c` beats it.
const PINNED_CONFIG: readonly string[] = [
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.quotePath=true",
  "-c",
  "patchid.verbatim=false",
];

/**
 * The environment for every git call: the caller's environment without any
 * `GIT_*` variable (no injected config, no `GIT_DIR`, no `GIT_EXTERNAL_DIFF`),
 * with empty global and system config and no prompts.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

/**
 * Runs `git -C <repoDir> <args>` with {@link gitEnv} and returns stdout.
 * Throws with git's message on a non-zero exit.
 */
export async function git(
  repoDir: string,
  args: readonly string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const r = await run("git", ["-C", repoDir, ...PINNED_CONFIG, ...args], {
    env: gitEnv(options.env),
    input: options.input,
    timeoutMs: 300_000,
  });
  if (r.status !== 0)
    throw new Error(`git ${args[0] ?? ""} failed: ${r.stderr.trim().slice(0, 500)}`);
  return r.stdout;
}

/** Which two commits a PR diff is between. */
export interface DiffRange {
  /** A git work tree or bare repo holding both commits. */
  repoDir: string;
  /** The tip of the PR's base branch (a SHA or a ref such as `refs/nod/base`). */
  baseTip: string;
  /** The PR head commit. */
  head: string;
  /**
   * Added to git's environment, e.g. an `http.<url>.extraheader` through
   * `GIT_CONFIG_*`, for a partial (blobless) clone that fetches the blobs
   * the diff needs on demand.
   */
  env?: Record<string, string>;
}

/** `git merge-base <baseTip> <head>`: where the PR's diff starts. */
export async function mergeBase({ repoDir, baseTip, head, env }: DiffRange): Promise<string> {
  return (await git(repoDir, ["merge-base", baseTip, head], { env })).trim();
}

/**
 * The PR's patch-id (ADR 0001): `git patch-id --stable` over the pinned diff
 * from `merge-base(baseTip, head)` to `head`. `""` for an empty diff.
 *
 * Refuses to run when the repo has a non-empty `info/attributes`, the one
 * attributes source no flag can switch off: it would make this signer's id
 * differ from the verifier's.
 */
export async function patchId(range: DiffRange): Promise<string> {
  const { repoDir, head, env } = range;
  await assertNoInfoAttributes(repoDir);
  const base = await mergeBase(range);
  const diff = await git(
    repoDir,
    [`--attr-source=${EMPTY_TREE}`, "diff", ...PATCH_ID_DIFF_ARGS, base, head, "--"],
    { env },
  );
  if (diff === "") return "";
  const out = await git(repoDir, ["patch-id", "--stable"], { input: diff });
  return out.trim().split(/\s+/)[0] ?? "";
}

/** One file a PR changes, from git. */
export interface ChangedFile {
  /** Path relative to the repo root. A rename shows as a deletion plus an addition. */
  path: string;
  status: "added" | "modified" | "deleted" | "type-changed";
  /** Lines added; `0` for binary files. */
  added: number;
  /** Lines removed; `0` for binary files. */
  removed: number;
  binary: boolean;
}

/**
 * Every file the PR changes (`git diff --raw --numstat -z --no-renames`
 * between the merge base and `head`), with line counts. Uses the same pinned
 * attributes as {@link patchId}, so `.gitattributes` in the PR cannot hide a
 * file's lines by marking it binary.
 */
export async function changedFiles(range: DiffRange): Promise<ChangedFile[]> {
  const { repoDir, head } = range;
  const base = await mergeBase(range);
  const out = await git(repoDir, [
    `--attr-source=${EMPTY_TREE}`,
    "diff",
    "--raw",
    "--numstat",
    "-z",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    "--no-relative",
    base,
    head,
    "--",
  ]);
  return parseRawNumstat(out);
}

/** Parses the output of `git diff --raw --numstat -z --no-renames`. */
export function parseRawNumstat(out: string): ChangedFile[] {
  const tokens = out.split("\0");
  const status = new Map<string, ChangedFile["status"]>();
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "") continue;
    if (t.startsWith(":")) {
      const letter = t.trim().split(" ").pop() ?? "M";
      status.set(tokens[++i] ?? "", STATUS[letter[0]!] ?? "modified");
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t);
    if (!m) continue;
    const binary = m[1] === "-";
    files.push({
      path: m[3]!,
      status: status.get(m[3]!) ?? "modified",
      added: binary ? 0 : Number(m[1]),
      removed: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return files;
}

const STATUS: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "type-changed",
};

/**
 * Returns a reader for files at `rev` (normally the base tip), for
 * classifiers that need trusted content such as `modules/x/module.json`.
 * Resolves to `null` when the file does not exist there or is larger than
 * `maxBytes` (default 1 MiB).
 */
export function gitFileReader(
  repoDir: string,
  rev: string,
  maxBytes = 1024 * 1024,
): (path: string) => Promise<string | null> {
  return async (path) => {
    const clean = path.replace(/^\/+/, "");
    if (!clean || clean.split("/").includes("..")) return null;
    const spec = `${rev}:${clean}`;
    const size = await run("git", ["-C", repoDir, "cat-file", "-s", spec], { env: gitEnv() });
    if (size.status !== 0 || Number(size.stdout.trim()) > maxBytes) return null;
    const r = await run("git", ["-C", repoDir, "cat-file", "blob", spec], { env: gitEnv() });
    return r.status === 0 ? r.stdout : null;
  };
}

/**
 * The environment that hands git a token for one host only: an
 * `http.<serverUrl>.extraheader` through `GIT_CONFIG_COUNT`/`_KEY_0`/`_VALUE_0`,
 * so it never shows on a command line or in a repo's config, and git sends
 * it to URLs under `serverUrl` and nowhere else.
 */
export function tokenGitEnv(token: string, serverUrl: string): Record<string, string> {
  const host = serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${host}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

/**
 * Fetches a PR's base branch and head commit as plain objects, never
 * checking anything out: `+refs/heads/<base>` lands in `refs/nod/base` and
 * the head SHA is fetched by id. A token, if given, goes into an
 * `http.extraheader` through the environment, not the command line.
 * Returns the ref to use as `baseTip`.
 */
export async function fetchPullRequestObjects(options: {
  repoDir: string;
  base: string;
  headSha: string;
  remote?: string;
  token?: string;
  /** Host the token is for (default `https://github.com/`). */
  serverUrl?: string;
}): Promise<string> {
  const {
    repoDir,
    base,
    headSha,
    remote = "origin",
    token,
    serverUrl = "https://github.com/",
  } = options;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(headSha))
    throw new Error("head SHA must be a full commit id");
  if (!/^[^\s:~^?*[\\]+$/.test(base) || base.startsWith("-") || /\p{Cc}/u.test(base)) {
    throw new Error("unexpected base branch name");
  }
  const env = token ? tokenGitEnv(token, serverUrl) : {};
  const ref = "refs/nod/base";
  await git(
    repoDir,
    ["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${base}:${ref}`, headSha],
    { env },
  );
  return ref;
}

async function assertNoInfoAttributes(repoDir: string): Promise<void> {
  const path = (
    await git(repoDir, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"])
  ).trim();
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.trim() !== "") {
    throw new Error(`${path} sets git attributes that would change the patch-id; empty it first`);
  }
}
