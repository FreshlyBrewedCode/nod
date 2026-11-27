/**
 * What a diff is made of (ADR 0009 decision 10): changed lines as code,
 * tests, docs, comments, config and generated. Files are sorted by path;
 * comments are found line by line in code and test files from the unified
 * diff, by per-language rules. No parser: a line with code and a trailing
 * comment is code.
 *
 * Pure: imports nothing from Node.
 */
import { DIFF_SIZE_IGNORE } from "../classifiers/diff-size.ts";
import { matchAny } from "../classifiers/glob.ts";
import type { ChangedFile } from "../patch-id.ts";
import { breakdown, insight, type Tone } from "./blocks.ts";
import { builtinAnalyzer } from "./define.ts";
import type { Analyzer } from "./types.ts";

/** The parts of a diff. */
export type CompositionPart = "code" | "tests" | "docs" | "comments" | "config" | "generated";

/** The parts in display order. */
export const COMPOSITION_PARTS: readonly CompositionPart[] = [
  "code",
  "tests",
  "comments",
  "docs",
  "config",
  "generated",
];

/** Lines of one part. */
export interface LineCount {
  added: number;
  removed: number;
}

/** Changed lines per part. */
export type Composition = Record<CompositionPart, LineCount>;

/** Test files: by folder or by name. */
export const TEST_GLOBS: readonly string[] = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/spec/**",
  "**/*.{test,spec}.*",
  "**/*_test.*",
  "**/test_*.py",
  "**/*Test.{java,kt,cs,swift}",
  "**/*Tests.{java,kt,cs,swift}",
  "**/testdata/**",
  "**/fixtures/**",
];

/** Documentation: prose files and docs folders. */
export const DOCS_GLOBS: readonly string[] = [
  "**/*.{md,mdx,markdown,rst,adoc,txt}",
  "docs/**",
  "doc/**",
  "**/LICENSE*",
  "**/CHANGELOG*",
  "**/AUTHORS*",
];

/** Configuration: data formats, CI, dot files and build files. */
export const CONFIG_GLOBS: readonly string[] = [
  "**/*.{json,jsonc,json5,yaml,yml,toml,ini,cfg,conf,properties,env,xml,plist,editorconfig}",
  "**/.*",
  "**/.github/**",
  "**/Dockerfile*",
  "**/Makefile",
  "**/*.mk",
  "**/CODEOWNERS",
  "**/*.{nix,tf,tfvars,hcl}",
  "**/*.config.{js,ts,mjs,cjs,mts,cts}",
];

/** Options for {@link fileKind} and {@link composeDiff}. */
export interface CompositionOptions {
  generated?: readonly string[];
  tests?: readonly string[];
  docs?: readonly string[];
  config?: readonly string[];
}

/**
 * Which part a whole file counts as, by path: generated (the kit's
 * `DIFF_SIZE_IGNORE`: lockfiles and build output), then tests, docs,
 * config, else code. Comments are found inside code and test files.
 */
export function fileKind(
  path: string,
  options: CompositionOptions = {},
): Exclude<CompositionPart, "comments"> {
  if (matchAny(options.generated ?? DIFF_SIZE_IGNORE, path)) return "generated";
  if (matchAny(options.tests ?? TEST_GLOBS, path)) return "tests";
  if (matchAny(options.docs ?? DOCS_GLOBS, path)) return "docs";
  if (matchAny(options.config ?? CONFIG_GLOBS, path)) return "config";
  return "code";
}

/** How a language writes comments. */
export interface CommentRules {
  /** Line comment markers, e.g. `//` and `#`. */
  line: readonly string[];
  /** Block comments as `[open, close]`, e.g. `["/*", "*\/"]`. */
  block: readonly (readonly [string, string])[];
}

const C: CommentRules = { line: ["//"], block: [["/*", "*/"]] };
const HASH: CommentRules = { line: ["#"], block: [] };
const PY: CommentRules = {
  line: ["#"],
  block: [
    ['"""', '"""'],
    ["'''", "'''"],
  ],
};
const DASH: CommentRules = { line: ["--"], block: [] };
const HTML: CommentRules = { line: [], block: [["<!--", "-->"]] };

const BY_EXT: Readonly<Record<string, CommentRules>> = {
  ...Object.fromEntries(
    "js jsx ts tsx mjs cjs mts cts c h cc cpp cxx hpp hh m mm java kt kts scala go rs swift cs fs dart groovy gradle zig proto sol v"
      .split(" ")
      .map((e) => [e, C]),
  ),
  php: { line: ["//", "#"], block: [["/*", "*/"]] },
  css: { line: [], block: [["/*", "*/"]] },
  scss: C,
  less: C,
  ...Object.fromEntries(
    "sh bash zsh fish rb pl pm r ex exs cmake ps1 tcl awk yaml yml toml conf"
      .split(" ")
      .map((e) => [e, HASH]),
  ),
  py: PY,
  pyi: PY,
  nix: { line: ["#"], block: [["/*", "*/"]] },
  tf: { line: ["#", "//"], block: [["/*", "*/"]] },
  hcl: { line: ["#", "//"], block: [["/*", "*/"]] },
  sql: { line: ["--"], block: [["/*", "*/"]] },
  lua: { line: ["--"], block: [["--[[", "]]"]] },
  hs: { line: ["--"], block: [["{-", "-}"]] },
  elm: { line: ["--"], block: [["{-", "-}"]] },
  ada: DASH,
  clj: { line: [";"], block: [] },
  cljs: { line: [";"], block: [] },
  el: { line: [";"], block: [] },
  lisp: { line: [";"], block: [] },
  scm: { line: [";"], block: [] },
  asm: { line: [";", "#"], block: [] },
  ini: { line: [";", "#"], block: [] },
  tex: { line: ["%"], block: [] },
  erl: { line: ["%"], block: [] },
  m4: { line: ["dnl", "#"], block: [] },
  vim: { line: ['"'], block: [] },
  html: HTML,
  htm: HTML,
  xml: HTML,
  svg: HTML,
  md: HTML,
  vue: {
    line: ["//"],
    block: [
      ["/*", "*/"],
      ["<!--", "-->"],
    ],
  },
  svelte: {
    line: ["//"],
    block: [
      ["/*", "*/"],
      ["<!--", "-->"],
    ],
  },
  astro: {
    line: ["//"],
    block: [
      ["/*", "*/"],
      ["<!--", "-->"],
    ],
  },
};

const BY_NAME: Readonly<Record<string, CommentRules>> = {
  Makefile: HASH,
  Dockerfile: HASH,
  Rakefile: HASH,
  Gemfile: HASH,
  Justfile: HASH,
  justfile: HASH,
  CMakeLists: HASH,
};

/** The comment rules for a path, by extension or file name; `null` when unknown. */
export function commentRules(path: string): CommentRules | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const base = name.replace(/\.txt$/, "");
  if (BY_NAME[base]) return BY_NAME[base]!;
  if (name.startsWith("Dockerfile")) return HASH;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Follows comments through the lines of one side of a hunk. */
export class CommentTracker {
  /** The close marker of the block comment the side is in, or `null`. */
  private open: string | null = null;

  constructor(private readonly rules: CommentRules) {}

  /** Whether `line` is a comment (or inside one), and moves the state past it. */
  next(line: string): boolean {
    const t = line.trim();
    if (this.open !== null) {
      const close = this.open;
      const at = t.indexOf(close);
      if (at < 0) return true;
      this.open = null;
      // `*/ code()`: code after the close makes the line code.
      const after = t.slice(at + close.length).trim();
      return after === "" || this.starts(after);
    }
    if (this.starts(t)) return true;
    // A hunk can start inside a block comment: ` * text` is a guess, but a good one.
    return this.rules.block.some(([o]) => o === "/*") && /^\*(?:\s|\/|$)/.test(t);
  }

  /** Whether `t` (trimmed) starts a comment that fills the rest of the line. */
  private starts(t: string): boolean {
    for (const [open, close] of this.rules.block) {
      if (!t.startsWith(open)) continue;
      const rest = t.slice(open.length);
      const end = rest.indexOf(close);
      if (end < 0) {
        this.open = close;
        return true;
      }
      // `/* x */ code()` is code; `/* x */ // y` is a comment.
      const after = rest.slice(end + close.length).trim();
      return after === "" || this.starts(after);
    }
    return this.rules.line.some((marker) => t.startsWith(marker));
  }
}

/** One file's section of a unified diff. */
export interface DiffFile {
  path: string;
  /** Lines as they appear, each starting with `+`, `-` or ` `. Hunk headers left out; a `@@` line resets block state. */
  lines: string[];
}

/** Unquotes a path git printed in C-style quotes (`core.quotePath`). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const s = raw.slice(1, -1);
  const esc: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    "\\": 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const n = s[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Splits a unified diff (`git diff`, no renames) into files. Binary files have no lines. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: "", lines: [] };
      out.push(current);
      inHunk = false;
      // A fallback for files without ---/+++ lines (binary, mode-only).
      const m = /^diff --git (?:"a\/(.+)"|a\/(\S+)) /.exec(line);
      if (m) current.path = m[1] !== undefined ? unquoteGitPath(`"${m[1]}"`) : m[2]!;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      const minus = /^--- (?:a\/(.+)|"a\/(.+)")$/.exec(line);
      if (minus) current.path = minus[1] ?? unquoteGitPath(`"${minus[2]}`);
      const plus = /^\+\+\+ (?:b\/(.+)|"b\/(.+)")$/.exec(line);
      if (plus) current.path = plus[1] ?? unquoteGitPath(`"${plus[2]}`);
      if (line.startsWith("@@")) {
        inHunk = true;
        current.lines.push("@@");
      }
      continue;
    }
    if (line.startsWith("@@")) current.lines.push("@@");
    else if (line[0] === "+" || line[0] === "-" || line[0] === " ") current.lines.push(line);
    // `\ No newline at end of file` and the empty last line are skipped.
  }
  return out;
}

/** Counts a diff file's changed lines as code (or tests) and comments; blank lines are not counted. */
export function countLines(
  file: DiffFile,
  kind: "code" | "tests",
): { [K in "code" | "tests" | "comments"]?: LineCount } {
  const rules = commentRules(file.path);
  const result: Record<string, LineCount> = {};
  const add = (part: string, side: "added" | "removed") => {
    (result[part] ??= { added: 0, removed: 0 })[side]++;
  };
  let oldSide = rules && new CommentTracker(rules);
  let newSide = rules && new CommentTracker(rules);
  for (const line of file.lines) {
    if (line === "@@") {
      oldSide = rules && new CommentTracker(rules);
      newSide = rules && new CommentTracker(rules);
      continue;
    }
    const sign = line[0];
    const body = line.slice(1);
    const blank = body.trim() === "";
    if (sign === " ") {
      oldSide?.next(body);
      newSide?.next(body);
      continue;
    }
    const tracker = sign === "+" ? newSide : oldSide;
    const comment = tracker ? tracker.next(body) : false;
    if (blank) continue;
    add(comment ? "comments" : kind, sign === "+" ? "added" : "removed");
  }
  return result;
}

/** An empty {@link Composition}. */
export function emptyComposition(): Composition {
  return Object.fromEntries(
    COMPOSITION_PARTS.map((p) => [p, { added: 0, removed: 0 }]),
  ) as Composition;
}

/** Which changed files {@link composeDiff} needs the diff of: the code and test files that are not binary. */
export function filesToDiff(
  files: readonly ChangedFile[],
  options: CompositionOptions = {},
): string[] {
  return files
    .filter((f) => !f.binary && (f.added || f.removed))
    .filter((f) => {
      const kind = fileKind(f.path, options);
      return (kind === "code" || kind === "tests") && commentRules(f.path) !== null;
    })
    .map((f) => f.path);
}

/**
 * The composition of a PR. Docs, config, generated files and code in a
 * language without comment rules are counted from `files` (the numstat), so
 * `diff` only needs the files {@link filesToDiff} names; a file missing
 * from `diff` falls back to its numstat too.
 */
export function composeDiff(
  files: readonly ChangedFile[],
  diff: string,
  options: CompositionOptions = {},
): Composition {
  const total = emptyComposition();
  const parsed = new Map(parseUnifiedDiff(diff).map((f) => [f.path, f]));
  for (const f of files) {
    const kind = fileKind(f.path, options);
    const section = parsed.get(f.path);
    if ((kind === "code" || kind === "tests") && section && commentRules(f.path)) {
      for (const [part, n] of Object.entries(countLines(section, kind))) {
        total[part as CompositionPart].added += n.added;
        total[part as CompositionPart].removed += n.removed;
      }
      continue;
    }
    total[kind].added += f.added;
    total[kind].removed += f.removed;
  }
  return total;
}

/** The series slot each part is drawn in. */
export const COMPOSITION_TONES: Readonly<Record<CompositionPart, Tone>> = {
  code: "c1",
  tests: "c2",
  comments: "c3",
  docs: "c4",
  config: "c5",
  generated: "muted",
};

/**
 * What the PR's changed lines are (ADR 0009 decision 10), as a breakdown:
 * code, tests, comments, docs, config, generated. `poll`; reads the diff of
 * code and test files only.
 */
export function diffComposition(
  options: CompositionOptions & { style?: "bar" | "donut" } = {},
): Analyzer {
  const { style, ...kinds } = options;
  return builtinAnalyzer({
    id: "diff-composition",
    title: "What changed",
    when: "poll",
    async run(ctx) {
      const paths = filesToDiff(ctx.files, kinds);
      const diff = paths.length ? await ctx.diff(paths) : "";
      const c = composeDiff(ctx.files, diff, kinds);
      const items = COMPOSITION_PARTS.map((part) => ({
        label: part,
        value: c[part].added + c[part].removed,
        tone: COMPOSITION_TONES[part],
        note: `+${c[part].added} −${c[part].removed}`,
      })).filter((i) => i.value > 0);
      if (items.length === 0) return null;
      const sum = items.reduce((s, i) => s + i.value, 0);
      const result = insight(breakdown(items, { unit: "lines", ...(style ? { style } : {}) }));
      result.summary = items
        .slice()
        .sort((a, b) => b.value - a.value)
        .slice(0, 2)
        .map((i) => `${Math.round((i.value / sum) * 100)}% ${i.label}`)
        .join(", ");
      return result;
    },
  });
}
