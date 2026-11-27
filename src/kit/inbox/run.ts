/**
 * Running the personal layer on one PR, in process: combining attention
 * marks, running an analyzer into an {@link InsightState}, and the cache key
 * (ADR 0009 decisions 4 and 7). The runner (`nod serve`) calls these inside
 * its subprocess and validates the results again on its side.
 *
 * Pure: imports nothing from Node.
 */
import type { Block, Insight } from "./blocks.ts";
import { classifierName } from "./define.ts";
import { parseAttention, parseInsight } from "./validate.ts";
import type {
  Analyzer,
  AnalyzerOutput,
  AttentionClassifier,
  InboxContext,
  InboxParts,
  InsightState,
  NamedMark,
  PersonalAttention,
} from "./types.ts";

/**
 * Combines marks (ADR 0009 decision 4): `mute` wins; otherwise the `+1`s
 * and `-1`s add up, clamped to one tier either way. Tags once each, `fyi`
 * if any mark says so.
 */
export function combineAttention(
  marks: readonly NamedMark[],
  errors: readonly string[] = [],
): PersonalAttention {
  let sum = 0;
  let mute = false;
  let fyi = false;
  const tags: string[] = [];
  for (const m of marks) {
    if (m.attention === "mute") mute = true;
    else if (m.attention !== undefined) sum += m.attention;
    if (m.fyi) fyi = true;
    if (m.tag && !tags.includes(m.tag)) tags.push(m.tag);
  }
  return {
    attention: mute ? "mute" : sum > 0 ? 1 : sum < 0 ? -1 : 0,
    tags,
    fyi,
    marks: [...marks],
    errors: [...errors],
  };
}

/**
 * Runs every classifier on the PR and combines their marks. A classifier
 * that throws or returns junk adds an error or nothing; it never raises
 * attention (ADR 0009 decision 4).
 */
export async function evaluateAttention(
  classifiers: readonly AttentionClassifier[],
  ctx: InboxContext,
): Promise<PersonalAttention> {
  const marks: NamedMark[] = [];
  const errors: string[] = [];
  for (const c of classifiers) {
    const name = classifierName(c);
    try {
      const out = await c(ctx);
      for (const m of parseAttention(out)) marks.push({ ...m, classifier: m.classifier ?? name });
    } catch (e) {
      errors.push(`${name}: ${errorMessage(e)}`);
    }
  }
  return combineAttention(marks, errors);
}

/** What an analyzer returned, as an insight before validation. */
export function toInsight(out: AnalyzerOutput): Insight | null {
  if (out === null || out === undefined) return null;
  if (Array.isArray(out)) return { blocks: [...(out as readonly Block[])] };
  if (typeof out === "object" && "type" in out) return { blocks: [out as Block] };
  return out as Insight;
}

/** Default timeouts per `when` (ADR 0009 decision 8), in milliseconds. */
export const ANALYZER_TIMEOUT_MS = Object.freeze({ poll: 10_000, open: 60_000 });

/**
 * Runs one analyzer: `ready` with the validated insight, `empty` when it
 * returned nothing (or nothing that survived {@link parseInsight}),
 * `failed` when it threw or did not finish within `timeoutMs` (default
 * {@link ANALYZER_TIMEOUT_MS} for its `when`). Never throws.
 *
 * The timeout only catches an analyzer that awaits forever; one stuck in a
 * loop blocks its process, which is why the runner runs analyzers in a
 * subprocess it can kill.
 */
export async function runAnalyzer(
  analyzer: Analyzer,
  ctx: InboxContext,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<InsightState> {
  const { timeoutMs = ANALYZER_TIMEOUT_MS[analyzer.when], now = Date.now } = options;
  const base = {
    id: analyzer.id,
    title: analyzer.title,
    origin: analyzer.origin,
    when: analyzer.when,
  };
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => analyzer.run(ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out after ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    const ms = now() - started;
    const insight = parseInsight(toInsight(out));
    return insight ? { ...base, status: "ready", insight, ms } : { ...base, status: "empty", ms };
  } catch (e) {
    return { ...base, status: "failed", error: errorMessage(e), ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the analyzer runs on this PR: its `appliesTo`, if any. An
 * `appliesTo` that throws counts as "no".
 */
export function analyzerApplies(analyzer: Analyzer, ctx: InboxContext): boolean {
  try {
    return analyzer.appliesTo ? analyzer.appliesTo(ctx) !== false : true;
  } catch {
    return false;
  }
}

/**
 * The cache key of an analyzer's result (ADR 0009 decision 7): its id, the
 * PR's patch-id, and whatever its `cacheKey(ctx)` adds. A rebase that keeps
 * the patch-id keeps the result. A `cacheKey` that throws gives a key that
 * never matches, so the analyzer runs again.
 */
export function insightCacheKey(analyzer: Analyzer, patchId: string, ctx: InboxContext): string {
  let extra = "";
  try {
    extra = analyzer.cacheKey ? analyzer.cacheKey(ctx) : "";
  } catch {
    extra = `error:${Math.random()}`;
  }
  return extra ? `${analyzer.id}:${patchId}:${extra}` : `${analyzer.id}:${patchId}`;
}

/** A short, stable hash of a string (FNV-1a, 32 bit, hex), for cache keys. */
export function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** An error's message, one line, without a stack. */
export function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n")[0]!.slice(0, 500) || "error";
}

/** What {@link runInbox} returns for one PR. */
export interface InboxResult {
  attention: PersonalAttention;
  /** One state per analyzer that applies, in the inbox's order. */
  insights: InsightState[];
}

/**
 * Runs an inbox's classifiers and the analyzers of the given `when` (default
 * both) on one PR, one after the other, as `nod inbox test` shows them.
 * Never throws.
 */
export async function runInbox(
  parts: InboxParts,
  ctx: InboxContext,
  options: { when?: "poll" | "open"; timeoutMs?: number } = {},
): Promise<InboxResult> {
  const attention = await evaluateAttention(parts.classifiers, ctx);
  const insights: InsightState[] = [];
  for (const a of parts.analyzers) {
    if (options.when && a.when !== options.when) continue;
    if (!analyzerApplies(a, ctx)) continue;
    insights.push(
      await runAnalyzer(a, ctx, options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    );
  }
  return { attention, insights };
}
