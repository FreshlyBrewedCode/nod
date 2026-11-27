/**
 * Analyzers over the base branch's history (ADR 0009 decision 10):
 * `hotspots` (on by default) and `familiarity` (off). Both read
 * `git log --name-only`, which needs commits and trees only, so a blobless
 * clone answers without fetching anything.
 *
 * Pure: the git calls go through `ctx.git`.
 */
import { DIFF_SIZE_IGNORE } from "../classifiers/diff-size.ts";
import { matchAny } from "../classifiers/glob.ts";
import { count } from "../classifiers/paths.ts";
import { files, insight, stats, type FileItem } from "./blocks.ts";
import { builtinAnalyzer } from "./define.ts";
import type { Analyzer, InboxContext } from "./types.ts";

/** Most paths one `git log` is asked about. */
export const MAX_HISTORY_PATHS = 200;

/** One commit of {@link historyOf}. */
export interface HistoryCommit {
  sha: string;
  email: string;
  name: string;
  /** `YYYY-MM-DD`, the author date. */
  date: string;
  files: string[];
}

/**
 * The base branch's commits of the last `days` days that touched `paths`,
 * newest first (`git log --since --name-only --no-renames`, paths as literal
 * pathspecs). At most {@link MAX_HISTORY_PATHS} paths are asked about.
 */
export async function historyOf(
  ctx: InboxContext,
  paths: readonly string[],
  days: number,
): Promise<HistoryCommit[]> {
  if (paths.length === 0) return [];
  const out = await ctx.git([
    "log",
    `--since=${Math.max(1, Math.round(days))}.days.ago`,
    "--no-renames",
    "--name-only",
    "--format=%x00%H%x09%ae%x09%an%x09%as",
    ctx.revs.base,
    "--",
    ...paths.slice(0, MAX_HISTORY_PATHS).map((p) => `:(literal)${p}`),
  ]);
  const commits: HistoryCommit[] = [];
  for (const record of out.split("\0")) {
    const [header, ...names] = record.split("\n");
    if (!header) continue;
    const [sha = "", email = "", name = "", date = ""] = header.split("\t");
    commits.push({ sha, email, name, date, files: names.filter((n) => n.trim() !== "") });
  }
  return commits;
}

/** Changed files with a history on the base: not added by this PR, not generated. */
function knownFiles(ctx: InboxContext): string[] {
  return ctx.files
    .filter((f) => f.status !== "added" && !matchAny(DIFF_SIZE_IGNORE, f.path))
    .map((f) => f.path);
}

/** Options for {@link hotspots}. */
export interface HotspotsOptions {
  /** How far back (default 30 days). */
  days?: number;
  /** How many files to show (default 10). */
  limit?: number;
  /** Fewest changes that make a file a hotspot (default 2). */
  min?: number;
}

/**
 * Which files this PR touches changed most often on the base in the last
 * `days` (default 30), as a `files` block: busy files are where PRs
 * collide and where a change needs more context. `poll`; hidden when no
 * touched file changed `min` (default 2) times.
 */
export function hotspots(options: HotspotsOptions = {}): Analyzer {
  const { days = 30, limit = 10, min = 2 } = options;
  return builtinAnalyzer({
    id: "hotspots",
    title: "Hotspots",
    when: "poll",
    async run(ctx) {
      const paths = knownFiles(ctx);
      const touched = new Set(paths);
      const counts = new Map<string, number>();
      for (const c of await historyOf(ctx, paths, days)) {
        for (const f of c.files) if (touched.has(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      const hot = [...counts]
        .filter(([, n]) => n >= min)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (hot.length === 0) return null;
      const items: FileItem[] = hot
        .slice(0, limit)
        .map(([path, n]) => ({ path, value: n, note: `${count(n, "change")} in ${days} days` }));
      const result = insight(files(items, { label: `changed most in the last ${days} days` }));
      result.summary = `${count(hot.length, "busy file")}, ${hot[0]![0]} most (${hot[0]![1]})`;
      return result;
    },
  });
}

/** Options for {@link familiarity}. */
export interface FamiliarityOptions {
  /** How far back (default 365 days). */
  days?: number;
  /**
   * My git author emails. My GitHub noreply address (`<id>+<login>@users.noreply.github.com`)
   * and an author name equal to my login always count.
   */
  emails?: readonly string[];
}

/** Whether a commit's author is me: one of `emails`, my noreply address, or my login as the name. */
export function isMe(
  commit: Pick<HistoryCommit, "email" | "name">,
  me: string,
  emails: readonly string[],
): boolean {
  const email = commit.email.toLowerCase();
  const login = me.toLowerCase();
  if (emails.some((e) => e.toLowerCase() === email)) return true;
  if (email === `${login}@users.noreply.github.com`) return true;
  if (
    new RegExp(
      `^\\d+\\+${login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@users\\.noreply\\.github\\.com$`,
    ).test(email)
  )
    return true;
  return commit.name.toLowerCase() === login;
}

/**
 * Which files this PR touches I changed before on the base, in the last
 * `days` (default 365). `open`; **off by default** (not in `defaults()`),
 * because a GitHub login matches git authors only by a guess: list your
 * emails in `emails`.
 */
export function familiarity(options: FamiliarityOptions = {}): Analyzer {
  const { days = 365, emails = [] } = options;
  return builtinAnalyzer({
    id: "familiarity",
    title: "Your history here",
    when: "open",
    async run(ctx) {
      const paths = knownFiles(ctx);
      if (paths.length === 0) return null;
      const touched = new Set(paths);
      const mine = new Map<string, { n: number; last: string }>();
      for (const c of await historyOf(ctx, paths, days)) {
        if (!isMe(c, ctx.me, emails)) continue;
        for (const f of c.files) {
          if (!touched.has(f)) continue;
          const seen = mine.get(f);
          // Newest first: the first commit seen is the last change.
          mine.set(f, { n: (seen?.n ?? 0) + 1, last: seen?.last ?? c.date });
        }
      }
      const known = paths.filter((p) => mine.has(p));
      const result = insight(
        stats([{ label: "files you changed before", value: `${known.length} of ${paths.length}` }]),
      );
      if (known.length) {
        result.blocks.push(
          files(
            known.map((path) => {
              const m = mine.get(path)!;
              return { path, value: m.n, note: `${count(m.n, "change")}, last ${m.last}` };
            }),
          ),
        );
      }
      result.summary =
        known.length === 0
          ? "new ground for you"
          : `you changed ${known.length} of ${count(paths.length, "file")} before`;
      return result;
    },
  });
}
