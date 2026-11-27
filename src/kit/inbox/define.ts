/**
 * `defineInbox`, `defineAnalyzer` and `classifier`: how a user's `inbox.ts`
 * says what runs (ADR 0009 decision 2).
 *
 * Pure: imports nothing from Node.
 */
import { matchGlob } from "../classifiers/glob.ts";
import type {
  Analyzer,
  AnalyzerOutput,
  AttentionClassifier,
  AttentionMark,
  Inbox,
  InboxContext,
  InboxParts,
  Origin,
} from "./types.ts";

/** What an analyzer id looks like: lower case, digits and dashes, up to 40 characters. */
export const ANALYZER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What {@link defineAnalyzer} takes; `origin` is set for you. */
export interface AnalyzerSpec {
  /** Stable and unique: `[a-z0-9][a-z0-9-]*`, up to 40 characters. The cache key. */
  id: string;
  title: string;
  /** `poll`: after a poll, for PRs whose head changed (cheap). `open`: when the panel opens (expensive). */
  when: "poll" | "open";
  appliesTo?(ctx: InboxContext): boolean;
  cacheKey?(ctx: InboxContext): string;
  run(ctx: InboxContext): AnalyzerOutput | Promise<AnalyzerOutput>;
}

/**
 * Defines an analyzer:
 *
 * ```ts
 * export const testShare = defineAnalyzer({
 *   id: "test-share",
 *   title: "Tests",
 *   when: "poll",
 *   run({ files }) {
 *     const tests = files.filter((f) => f.path.includes(".test."));
 *     return stats([{ label: "test files", value: tests.length }]);
 *   },
 * });
 * ```
 *
 * Throws on an id that does not match {@link ANALYZER_ID}.
 */
export function defineAnalyzer(spec: AnalyzerSpec): Analyzer {
  return makeAnalyzer(spec, "yours");
}

/** The kit's own analyzers: like {@link defineAnalyzer}, labelled `default`. Not exported from the entry. */
export function builtinAnalyzer(spec: AnalyzerSpec): Analyzer {
  return makeAnalyzer(spec, "default");
}

function makeAnalyzer(spec: AnalyzerSpec, origin: Origin): Analyzer {
  if (!ANALYZER_ID.test(spec.id)) {
    throw new Error(`analyzer id "${spec.id}" must be lower case letters, digits and dashes`);
  }
  if (spec.when !== "poll" && spec.when !== "open") {
    throw new Error(`analyzer ${spec.id}: when must be "poll" or "open"`);
  }
  if (typeof spec.run !== "function") throw new Error(`analyzer ${spec.id} has no run()`);
  return { ...spec, origin };
}

/**
 * Names a classifier, for the marks' `classifier` and the panel's reasons:
 *
 * ```ts
 * classifier("wip", ({ pr }) =>
 *   /\bwip\b/i.test(pr.title) ? [{ attention: -1, detail: "work in progress" }] : []);
 * ```
 *
 * A plain function works too; it is then named after the function.
 */
export function classifier(
  name: string,
  fn: (ctx: InboxContext) => AttentionMark[] | Promise<AttentionMark[]>,
): AttentionClassifier {
  return Object.assign((ctx: InboxContext) => fn(ctx), { classifierName: name });
}

/** The kit's own classifiers: like {@link classifier}, labelled `default`. Not exported from the entry. */
export function builtinClassifier(
  name: string,
  fn: (ctx: InboxContext) => AttentionMark[] | Promise<AttentionMark[]>,
): AttentionClassifier {
  return Object.assign(classifier(name, fn), { origin: "default" as const });
}

/** A classifier's display name. */
export function classifierName(c: AttentionClassifier): string {
  return c.classifierName ?? (c.name || "classifier");
}

/**
 * Defines the personal inbox, the default export of `inbox.ts`:
 *
 * ```ts
 * const base = defaults();
 * export default defineInbox({
 *   classifiers: [...base.classifiers, watch("src/auth/**", { tag: "auth" })],
 *   analyzers: [...base.analyzers, testShare],
 *   repos: { "acme/billing": { classifiers: [mute({ authors: ["renovate[bot]"] })] } },
 * });
 * ```
 *
 * Exactly what it lists runs; leave out `defaults()` to drop the defaults.
 * Throws when an entry is not a classifier or an analyzer, or two analyzers
 * share an id (in one repo's resolved list).
 */
export function defineInbox(inbox: {
  classifiers?: readonly AttentionClassifier[];
  analyzers?: readonly Analyzer[];
  repos?: Readonly<Record<string, Partial<InboxParts>>>;
}): Inbox {
  const result: Inbox = {
    classifiers: inbox.classifiers ?? [],
    analyzers: inbox.analyzers ?? [],
    repos: inbox.repos ?? {},
  };
  checkParts(result, "inbox");
  for (const [key, parts] of Object.entries(result.repos)) {
    checkParts({ classifiers: parts.classifiers ?? [], analyzers: parts.analyzers ?? [] }, key);
    checkIds([...result.analyzers, ...(parts.analyzers ?? [])], key);
  }
  checkIds(result.analyzers, "inbox");
  return result;
}

function checkParts(parts: InboxParts, where: string): void {
  if (!Array.isArray(parts.classifiers) || !Array.isArray(parts.analyzers)) {
    throw new Error(`${where}: classifiers and analyzers must be lists`);
  }
  parts.classifiers.forEach((c, i) => {
    if (typeof c !== "function") throw new Error(`${where}: classifiers[${i}] is not a function`);
  });
  parts.analyzers.forEach((a, i) => {
    if (
      (typeof a !== "object" && typeof a !== "function") ||
      a === null ||
      typeof a.run !== "function" ||
      typeof a.id !== "string"
    ) {
      throw new Error(`${where}: analyzers[${i}] is not an analyzer (use defineAnalyzer)`);
    }
  });
}

function checkIds(analyzers: readonly Analyzer[], where: string): void {
  const seen = new Set<string>();
  for (const a of analyzers) {
    if (seen.has(a.id)) throw new Error(`${where}: two analyzers have the id "${a.id}"`);
    seen.add(a.id);
  }
}

/**
 * The classifiers and analyzers that run for one repo (`owner/name`): the
 * inbox's own, then those of every `repos` key that matches, in order. Keys
 * compare without case and may be globs (`acme/*`). When two matching keys
 * add an analyzer with the same id, the first one runs.
 */
export function inboxFor(inbox: Inbox, repo: string): InboxParts {
  const classifiers = [...inbox.classifiers];
  const analyzers = [...inbox.analyzers];
  const name = repo.toLowerCase();
  for (const [key, parts] of Object.entries(inbox.repos)) {
    if (!matchGlob(key.toLowerCase(), name)) continue;
    classifiers.push(...(parts.classifiers ?? []));
    for (const a of parts.analyzers ?? []) {
      if (!analyzers.some((b) => b.id === a.id)) analyzers.push(a);
    }
  }
  return { classifiers, analyzers };
}
