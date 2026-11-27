/**
 * The built-in attention classifiers (ADR 0009 decision 4): `overlapsMyWork`
 * (also an analyzer), `watch`, `mute` and `briefMismatch`. They say how much
 * of *my* attention a PR gets and never touch the repo's risk.
 *
 * Pure: imports nothing from Node.
 */
import { matchAny } from "../classifiers/glob.ts";
import { count, preview } from "../classifiers/paths.ts";
import { RISK_NAMES, type Risk } from "../classifiers/types.ts";
import { files, insight } from "./blocks.ts";
import { builtinAnalyzer, builtinClassifier, classifier } from "./define.ts";
import { hashKey } from "./run.ts";
import type {
  Analyzer,
  AttentionClassifier,
  AttentionMark,
  AttentionValue,
  InboxContext,
  MyPullRequest,
} from "./types.ts";

/** One of my other open PRs and the files this PR shares with it. */
export interface Overlap {
  pr: MyPullRequest;
  files: string[];
}

/**
 * My other open PRs in this PR's repo that change files this PR changes
 * too, most shared files first. This PR itself is left out.
 */
export function findOverlaps(ctx: InboxContext): Overlap[] {
  const touched = new Set(ctx.files.map((f) => f.path));
  const repo = ctx.pr.repo.toLowerCase();
  const out: Overlap[] = [];
  for (const mine of ctx.myWork) {
    if (mine.repo.toLowerCase() !== repo || mine.number === ctx.pr.number) continue;
    const shared = mine.files.filter((f) => touched.has(f));
    if (shared.length) out.push({ pr: mine, files: shared });
  }
  return out.sort((a, b) => b.files.length - a.files.length || a.pr.number - b.pr.number);
}

/** {@link overlapsMyWork}: a classifier and an analyzer in one, for both lists. */
export type OverlapsMyWork = AttentionClassifier & Analyzer;

/**
 * Files this PR shares with my other open PRs (ADR 0009 decision 10). One
 * value for both lists:
 *
 * - as a **classifier**: `+1` and the tag `my-work` when someone else's PR
 *   changes files one of my open PRs changes (a conflict or a dependency
 *   waiting to happen); my own PRs get no `+1`;
 * - as an **analyzer** (`poll`): the shared files, each with my PR.
 */
export function overlapsMyWork(options: { attention?: AttentionValue } = {}): OverlapsMyWork {
  const { attention = 1 } = options;
  const classify = builtinClassifier("overlapsMyWork", (ctx) => {
    if (ctx.pr.author.toLowerCase() === ctx.me.toLowerCase()) return [];
    const overlaps = findOverlaps(ctx);
    if (overlaps.length === 0) return [];
    const shared = [...new Set(overlaps.flatMap((o) => o.files))];
    const prs = overlaps.map((o) => `#${o.pr.number}`).join(", ");
    return [
      {
        attention,
        tag: "my-work",
        detail: `touches ${count(shared.length, "file")} of your ${prs}: ${preview(shared)}`,
      },
    ];
  });
  const analyzer = builtinAnalyzer({
    id: "overlaps-my-work",
    title: "Overlaps your work",
    when: "poll",
    cacheKey: (ctx) =>
      hashKey(
        ctx.myWork
          .filter((p) => p.repo.toLowerCase() === ctx.pr.repo.toLowerCase())
          .map((p) => `${p.number}:${[...p.files].sort().join(",")}`)
          .sort()
          .join(";"),
      ),
    run(ctx) {
      const overlaps = findOverlaps(ctx);
      if (overlaps.length === 0) return null;
      const items = overlaps.flatMap((o) =>
        o.files.map((path) => ({
          path,
          note: `#${o.pr.number} ${o.pr.title}`,
          pr: { repo: o.pr.repo, number: o.pr.number },
        })),
      );
      const result = insight(files(items));
      result.summary = `${count(new Set(items.map((i) => i.path)).size, "file")} shared with ${count(overlaps.length, "PR")} of yours`;
      return result;
    },
  });
  // Both lists accept it: a function with an analyzer's fields.
  return Object.assign(classify, analyzer);
}

/** Options for {@link watch}. */
export interface WatchOptions {
  /** Default `+1`; `-1` and `"mute"` work too. */
  attention?: AttentionValue;
  /** The quiet tag on the row, e.g. `auth` ("you: watching auth"). Default `watching`. */
  tag?: string;
  /** Worth knowing about even when it needs nothing from me. */
  fyi?: boolean;
}

/**
 * Watches paths: a PR that changes any file matching `globs` gets
 * `attention` (default `+1`) and `tag`. Globs as in the kit's `matchGlob`
 * (`src/auth/**`, `**\/*.sql`).
 *
 * ```ts
 * watch("src/auth/**", { tag: "auth" })
 * watch(["**\/*.sql", "migrations/**"], { tag: "db", fyi: true })
 * ```
 */
export function watch(
  globs: string | readonly string[],
  options: WatchOptions = {},
): AttentionClassifier {
  const list = typeof globs === "string" ? [globs] : [...globs];
  const { attention = 1, tag = "watching", fyi } = options;
  return classifier(`watch(${tag})`, ({ files: changed }) => {
    const hits = changed.filter((f) => matchAny(list, f.path)).map((f) => f.path);
    if (hits.length === 0) return [];
    const mark: AttentionMark = {
      attention,
      tag,
      detail: `${count(hits.length, "file")} you watch (${list.join(", ")}): ${preview(hits)}`,
    };
    if (fyi) mark.fyi = true;
    return [mark];
  });
}

/** Options for {@link mute}; any one that matches mutes the PR. */
export interface MuteOptions {
  /** Logins, without case; `renovate` also matches `renovate[bot]`. */
  authors?: readonly string[];
  /** Muted when **every** changed file matches one of these globs. */
  paths?: readonly string[];
  /** Labels, without case. */
  labels?: readonly string[];
}

const login = (name: string) => name.toLowerCase().replace(/\[bot\]$/, "");

/**
 * Mutes PRs: they fold into Background. A PR that needs my nod or approval
 * stays where the repo put it (ADR 0009 decision 1); mute only quiets the
 * rest.
 *
 * ```ts
 * mute({ authors: ["renovate", "dependabot"], paths: ["docs/**"] })
 * ```
 */
export function mute(options: MuteOptions): AttentionClassifier {
  const authors = new Set((options.authors ?? []).map(login));
  const paths = options.paths ?? [];
  const labels = new Set((options.labels ?? []).map((l) => l.toLowerCase()));
  return classifier("mute", ({ pr, files: changed }) => {
    if (authors.has(login(pr.author))) {
      return [{ attention: "mute", detail: `you mute PRs by ${pr.author}` }];
    }
    const label = pr.labels.find((l) => labels.has(l.toLowerCase()));
    if (label) return [{ attention: "mute", detail: `you mute the label ${label}` }];
    if (paths.length && changed.length && changed.every((f) => matchAny(paths, f.path))) {
      return [{ attention: "mute", detail: `every changed file is under ${paths.join(", ")}` }];
    }
    return [];
  });
}

/** Options for {@link briefMismatch}. */
export interface BriefMismatchOptions {
  /** How many levels below the repo's risk the declared risk must be for `+1` (default 2). */
  gap?: number;
}

const RISK_WORDS: Readonly<Record<string, Risk>> = { none: 0, low: 1, medium: 2, high: 3 };

/** The risk the brief declares (`Risk: low`, `**Risk:** high`, `## Risk` then `low`), or `null`. */
export function declaredRisk(body: string): Risk | null {
  const lines = body.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]!);
    const inline = /^risk\s*:\s*(none|low|medium|high|[0-3])\b/i.exec(line);
    if (inline) return riskOf(inline[1]!);
    if (/^#{1,6}\s*risk\s*$/i.test(lines[i]!.trim())) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      const word = next && /^(none|low|medium|high|[0-3])\b/i.exec(clean(next));
      if (word) return riskOf(word[1]!);
    }
  }
  return null;
}

const clean = (line: string) =>
  line
    .replace(/^[\s>*+-]+/, "")
    .replace(/\*\*|__/g, "")
    .trim();

const riskOf = (word: string): Risk =>
  /^[0-3]$/.test(word) ? (Number(word) as Risk) : RISK_WORDS[word.toLowerCase()]!;

/**
 * The paths the brief's "Look at" (or "Where to look", "Review focus")
 * section names in backticks, e.g. `` `src/auth/session.ts` ``. Only
 * backticked words with a `/` or a file extension count.
 */
export function lookAtPaths(body: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const heading = /^\s*#{1,6}\s/.test(raw);
    const line = clean(raw.replace(/^\s*#{1,6}\s*/, ""));
    const label = /^(?:look\s+at|where\s+to\s+look|review\s+focus)\s*:?\s*(.*)$/i.exec(line);
    if (label) {
      inside = true;
      collect(label[1]!, out);
      continue;
    }
    // Another heading or `Label:` line ends the section.
    if (heading || /^[A-Za-z][A-Za-z ]{1,30}:(?:\s|$)/.test(line)) inside = false;
    if (inside) collect(line, out);
  }
  return [...new Set(out)];
}

function collect(line: string, out: string[]): void {
  for (const m of line.matchAll(/`([^`\s]+)`/g)) {
    const word = m[1]!.replace(/^\.\//, "").replace(/[:#]\d+(?:-\d+)?$/, "");
    if (word.includes("/") || /\.[a-z0-9]{1,6}$/i.test(word)) out.push(word);
  }
}

/**
 * Compares the brief with the PR and the repo layer:
 *
 * - `+1`, tag `brief-mismatch`: the brief declares a risk at least `gap`
 *   (default 2) levels below what the repo layer says (`Risk: low` on a
 *   high-risk PR);
 * - tag `brief-mismatch` only: the brief's "Look at" names paths the PR
 *   changes none of (a path counts when it is a changed file or a folder
 *   holding one).
 */
export function briefMismatch(options: BriefMismatchOptions = {}): AttentionClassifier {
  const { gap = 2 } = options;
  return builtinClassifier("briefMismatch", ({ pr, files: changed, repoSummary }) => {
    const marks: AttentionMark[] = [];
    const declared = declaredRisk(pr.body);
    if (declared !== null && repoSummary && repoSummary.risk - declared >= gap) {
      marks.push({
        attention: 1,
        tag: "brief-mismatch",
        detail: `the brief says ${RISK_NAMES[declared]} risk, the repo says ${RISK_NAMES[repoSummary.risk]}`,
      });
    }
    const named = lookAtPaths(pr.body);
    const missing = named.filter(
      (p) => !changed.some((f) => f.path === p || f.path.startsWith(`${p.replace(/\/$/, "")}/`)),
    );
    if (named.length && missing.length === named.length) {
      marks.push({
        tag: "brief-mismatch",
        detail: `the brief says to look at ${preview(missing)}, which this PR does not change`,
      });
    }
    return marks;
  });
}
