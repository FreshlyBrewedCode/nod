/**
 * The analyzer context (ADR 0009 decision 6): what crosses into the
 * subprocess as plain JSON ({@link InboxInput}), the I/O as an interface
 * ({@link InboxIO}), the read-only git rule, and a test double so an
 * analyzer can be tested without a clone.
 *
 * Pure: imports nothing from Node. The git-backed I/O is `git-io.ts`.
 */
import type { PullRequestInfo } from "../classifiers/types.ts";
import type { ChangedFile } from "../patch-id.ts";
import type { PolicyResult } from "../policy.ts";
import type { CheckSummary } from "../summary.ts";
import type { InboxContext, InboxIO, MyPullRequest, RepoSummary } from "./types.ts";

/** The plain-JSON part of a context: what the runner sends to its subprocess for one PR. */
export interface InboxInput {
  pr: PullRequestInfo;
  files: ChangedFile[];
  me: string;
  myWork: MyPullRequest[];
  repoSummary: RepoSummary | null;
}

/** A context from the PR's facts and an I/O. */
export function createInboxContext(input: InboxInput, io: InboxIO): InboxContext {
  return {
    pr: input.pr,
    files: input.files,
    me: input.me,
    myWork: input.myWork,
    repoSummary: input.repoSummary,
    revs: io.revs,
    readBaseFile: (path) => io.readBaseFile(path),
    readHeadFile: (path) => io.readHeadFile(path),
    diff: (paths) => io.diff(paths),
    git: (args) => io.git(args),
  };
}

/** The repo layer's result as the personal layer reads it, from a verifier's summary. */
export function repoSummaryFromCheck(summary: CheckSummary): RepoSummary {
  return {
    source: "verifier",
    risk: summary.risk,
    category: summary.category,
    tags: [...new Set(summary.reasons.map((r) => r.tag))],
    fyi: summary.fyi,
    satisfied: summary.satisfied,
  };
}

/** The repo layer's result as the personal layer reads it, from `nod serve`'s own policy run. */
export function repoSummaryFromPolicy(result: PolicyResult, satisfied = false): RepoSummary {
  return {
    source: "local",
    risk: result.risk,
    category: result.category,
    tags: [...new Set(result.reasons.map((r) => r.tag))],
    fyi: result.fyi,
    satisfied,
  };
}

/**
 * The git subcommands `ctx.git` allows: they only read. `grep` and `blame`
 * read contents (which a blobless clone fetches); the rest read history and
 * trees.
 */
export const GIT_READ_ONLY: readonly string[] = [
  "log",
  "show",
  "diff",
  "diff-tree",
  "rev-list",
  "rev-parse",
  "merge-base",
  "cat-file",
  "ls-tree",
  "blame",
  "shortlog",
  "describe",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "grep",
];

/**
 * Long options that write files, run programs or read outside the repo,
 * refused in any position. Git accepts a unique prefix of a long option
 * (`--outp=x` is `--output=x`), so a prefix of one of these is refused too,
 * except for the real options in {@link PREFIX_OK}.
 */
const REFUSED_LONG: readonly string[] = [
  "output",
  "output-directory",
  "ext-diff",
  "textconv",
  "filters",
  "no-index",
  "contents",
  "open-files-in-pager",
  "exec",
  "upload-pack",
  "receive-pack",
  "git-dir",
  "work-tree",
  "paginate",
];

/** Real options that happen to be a prefix of a refused one: `--text` (diff), `--filter` (rev-list). */
const PREFIX_OK: readonly string[] = ["text", "filter"];

function refused(arg: string): boolean {
  if (/^-O/.test(arg)) return true; // grep: open in a pager; diff: an order file from anywhere
  if (!arg.startsWith("--")) return false;
  const name = arg.slice(2).split("=")[0]!;
  if (name === "" || PREFIX_OK.includes(name)) return false;
  return REFUSED_LONG.some((r) => r.startsWith(name));
}

/**
 * Throws unless `args` is a read-only git call: the first argument one of
 * {@link GIT_READ_ONLY}, and no option that writes, runs a program or reads
 * outside the repo (`--output`, `--ext-diff`, `--textconv`, `--filters`,
 * `--no-index`, `--contents`, `--open-files-in-pager`/`-O`, `--exec`,
 * `--upload-pack`, `--git-dir`, …). `rev-parse --git-path` and friends are
 * fine; they only print.
 */
export function assertReadOnlyGit(args: readonly string[]): void {
  const [sub, ...rest] = args;
  if (sub === undefined || !GIT_READ_ONLY.includes(sub)) {
    throw new Error(
      `git ${sub ?? ""} is not allowed here; read-only commands are: ${GIT_READ_ONLY.join(", ")}`,
    );
  }
  for (const a of rest) {
    if (typeof a !== "string") throw new Error("git arguments must be strings");
    if (a === "--") break;
    if (refused(a)) throw new Error(`git ${sub} ${a} is not allowed`);
  }
}

/** What {@link fakeInboxIO} answers from. */
export interface FakeInboxFiles {
  /** Files at the base tip, by path. */
  base?: Readonly<Record<string, string>>;
  /** Files at the head, by path. */
  head?: Readonly<Record<string, string>>;
  /** The unified diff; `diff(paths)` keeps only those files' sections. */
  diff?: string;
  /** What `revs` says; default `{ base: "base", head: "head" }`. */
  revs?: { base: string; head: string };
  /** Answers `git(args)` after the read-only check; default: throws "no git here". */
  git?: (args: readonly string[]) => string | Promise<string>;
}

/** An {@link InboxIO} test double: no clone, no processes. `git` still refuses what the real one refuses. */
export function fakeInboxIO(files: FakeInboxFiles = {}): InboxIO {
  return {
    revs: files.revs ?? { base: "base", head: "head" },
    readBaseFile: async (path) => files.base?.[path] ?? null,
    readHeadFile: async (path) => files.head?.[path] ?? null,
    diff: async (paths) => (paths ? filterDiff(files.diff ?? "", paths) : (files.diff ?? "")),
    git: async (args) => {
      assertReadOnlyGit(args);
      if (!files.git) throw new Error("no git here");
      return files.git(args);
    },
  };
}

/** Keeps the sections of a unified diff whose file is in `paths`. */
export function filterDiff(diff: string, paths: readonly string[]): string {
  const wanted = new Set(paths);
  const sections = diff.split(/^(?=diff --git )/m);
  return sections
    .filter((s) => {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(s);
      return m !== null && (wanted.has(m[1]!) || wanted.has(m[2]!));
    })
    .join("");
}

/** A context for tests: alice's PR #12 in acme/widgets, I am bob, no work of mine, I/O from `files`. */
export function testInboxContext(
  input: Partial<Omit<InboxInput, "pr">> & { pr?: Partial<PullRequestInfo> } = {},
  files: FakeInboxFiles = {},
): InboxContext {
  return createInboxContext(
    {
      pr: {
        repo: "acme/widgets",
        number: 12,
        title: "Add a thing",
        body: "",
        author: "alice",
        labels: [],
        base: "main",
        head_sha: "a".repeat(40),
        ...input.pr,
      },
      files: input.files ?? [],
      me: input.me ?? "bob",
      myWork: input.myWork ?? [],
      repoSummary: input.repoSummary ?? null,
    },
    fakeInboxIO(files),
  );
}
