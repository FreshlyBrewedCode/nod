/**
 * `@frebreco/nod/kit/inbox`: the personal layer (ADR 0009). Your own
 * attention classifiers and analyzers, run only by your `nod serve`, never
 * changing a repo's risk or requirement. A user's `inbox.ts` imports this:
 *
 * ```ts
 * import { defaults, defineAnalyzer, defineInbox, mute, stats, watch } from "@frebreco/nod/kit/inbox";
 *
 * const testFiles = defineAnalyzer({
 *   id: "test-files",
 *   title: "Tests",
 *   when: "poll",
 *   run: ({ files }) =>
 *     stats([{ label: "test files", value: files.filter((f) => f.path.includes(".test.")).length }]),
 * });
 *
 * const base = defaults();
 * export default defineInbox({
 *   classifiers: [...base.classifiers, watch("src/auth/**", { tag: "auth" }), mute({ authors: ["renovate"] })],
 *   analyzers: [...base.analyzers, testFiles],
 * });
 * ```
 *
 * - the inbox: {@link defineInbox}, {@link defineAnalyzer}, {@link classifier}, {@link defaults},
 *   {@link inboxFor}
 * - attention classifiers: {@link overlapsMyWork}, {@link watch}, {@link mute}, {@link briefMismatch}
 * - analyzers: {@link diffComposition}, {@link hotspots}, {@link familiarity} (off by default)
 * - insights: {@link insight}, {@link breakdown}, {@link stats}, {@link series}, {@link files},
 *   {@link text}; validated by {@link parseInsight}, {@link parseAttention}, {@link parseInsightState}
 * - the context: {@link createInboxContext}, {@link gitInboxIO} (a git clone), {@link fakeInboxIO}
 *   and {@link testInboxContext} (tests)
 * - running: {@link evaluateAttention}, {@link runAnalyzer}, {@link runInbox}, {@link insightCacheKey}
 * - text: {@link parseMarkdown}, {@link formatInsightState}, {@link formatAttention}
 *
 * Zero dependencies. Every module but `git-io.ts` is pure (no Node imports),
 * so the web app can import the types and validators by path.
 */

/** Version of the inbox API surface. */
export const INBOX_VERSION = 1;

export * from "./blocks.ts";
export * from "./classifiers.ts";
export * from "./composition.ts";
export * from "./context.ts";
export * from "./defaults.ts";
export {
  ANALYZER_ID,
  classifier,
  classifierName,
  defineAnalyzer,
  defineInbox,
  inboxFor,
} from "./define.ts";
export type { AnalyzerSpec } from "./define.ts";
export * from "./format.ts";
export * from "./git-io.ts";
export * from "./history.ts";
export * from "./markdown.ts";
export * from "./run.ts";
export * from "./types.ts";
export * from "./validate.ts";
