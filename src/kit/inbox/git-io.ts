/**
 * The real {@link InboxIO}, over a git clone (ADR 0009 decision 6): file
 * reads at the base tip and the head, the PR's diff, and read-only `git`.
 * Argument arrays, never a shell; the kit's {@link gitEnv}; a timeout and
 * an output cap on every call.
 *
 * Reads are lazy and a blobless clone (`--filter=blob:none`, as nod's own
 * are) fetches contents on first read: pass the host's git credentials in
 * `env` (e.g. an `http.<url>.extraheader` through `GIT_CONFIG_COUNT`) for a
 * private repo.
 */
import { run } from "../exec.ts";
import { EMPTY_TREE, PATCH_ID_DIFF_ARGS, gitEnv } from "../patch-id.ts";
import { assertReadOnlyGit } from "./context.ts";
import type { InboxIO } from "./types.ts";

/** Options for {@link gitInboxIO}. */
export interface GitInboxOptions {
  /** A git work tree or bare repo holding both commits. */
  repoDir: string;
  /** The tip of the PR's base branch (a SHA or a ref). */
  baseTip: string;
  /** The PR head commit. */
  head: string;
  /** Extra environment for git, e.g. credentials for lazy fetches. `GIT_*` from the process is never passed. */
  env?: Record<string, string>;
  /** Per git call (default 30 s). */
  timeoutMs?: number;
  /** Largest stdout of one git call (default 16 MiB); larger fails. */
  maxBytes?: number;
  /** Largest file `readBaseFile`/`readHeadFile` returns (default 1 MiB); larger reads as `null`. */
  maxFileBytes?: number;
}

/** Config the clone's own config could set; `-c` beats it. No pager, no textconv drivers, quoted paths. */
const PINNED: readonly string[] = [
  "--no-pager",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.quotePath=true",
  "-c",
  "core.pager=cat",
  `--attr-source=${EMPTY_TREE}`,
];

/** An {@link InboxIO} over the clone at `repoDir`, for the PR from `baseTip` to `head`. */
export function gitInboxIO(options: GitInboxOptions): InboxIO {
  const {
    repoDir,
    baseTip,
    head,
    env = {},
    timeoutMs = 30_000,
    maxBytes = 16 * 1024 * 1024,
    maxFileBytes = 1024 * 1024,
  } = options;

  const call = async (args: readonly string[], literal = false): Promise<string> => {
    const r = await run(
      "git",
      ["-C", repoDir, ...PINNED, ...(literal ? ["--literal-pathspecs"] : []), ...args],
      {
        env: gitEnv(env),
        timeoutMs,
        maxStdoutBytes: maxBytes,
      },
    );
    if (r.status !== 0) {
      throw new Error(
        r.status === null
          ? `git ${args[0] ?? ""} timed out`
          : `git ${args[0] ?? ""} failed: ${r.stderr.trim().slice(0, 300)}`,
      );
    }
    return r.stdout;
  };

  let base: Promise<string> | undefined;
  const mergeBase = () => (base ??= call(["merge-base", baseTip, head]).then((out) => out.trim()));

  const reader =
    (rev: string) =>
    async (path: string): Promise<string | null> => {
      const clean = path.replace(/^\/+/, "");
      if (!clean || clean.split("/").includes("..")) return null;
      const spec = `${rev}:${clean}`;
      try {
        const size = Number((await call(["cat-file", "-s", spec])).trim());
        if (!(size <= maxFileBytes)) return null;
        return await call(["cat-file", "blob", spec]);
      } catch {
        return null;
      }
    };

  return {
    revs: { base: baseTip, head },
    readBaseFile: reader(baseTip),
    readHeadFile: reader(head),
    async diff(paths) {
      if (paths && paths.length === 0) return "";
      // Paths from the PR are names, never pathspec magic such as `:(top)` or a glob.
      const args = ["diff", ...PATCH_ID_DIFF_ARGS, await mergeBase(), head, "--", ...(paths ?? [])];
      return call(args, true);
    },
    async git(args) {
      assertReadOnlyGit(args);
      return call(args);
    },
  };
}
