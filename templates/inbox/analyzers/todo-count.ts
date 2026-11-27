/**
 * An example analyzer: the TODO and FIXME lines a pull request adds, as a
 * `stats` block in the panel. Copy it, rename it (the id is the cache key),
 * and add it to `analyzers` in ../inbox.ts.
 *
 * An analyzer gets the pull request, its files, its diff, read-only git in
 * nod's clone, and returns blocks: never HTML. `when: "poll"` runs after a
 * poll, for pull requests whose content changed; `when: "open"` when you
 * open the panel on one (for slow ones).
 */
import { defineAnalyzer, stats } from "@frebreco/nod/kit/inbox";

const MARKER = /\b(TODO|FIXME)\b/;

export const todoCount = defineAnalyzer({
  id: "todo-count",
  title: "TODOs added",
  when: "poll",
  async run(ctx) {
    // Only text files: the diff of a binary file says nothing here.
    const paths = ctx.files.filter((f) => !f.binary && f.added > 0).map((f) => f.path);
    if (paths.length === 0) return null;
    let todo = 0;
    let fixme = 0;
    for (const line of (await ctx.diff(paths)).split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const hit = MARKER.exec(line)?.[1];
      if (hit === "TODO") todo++;
      else if (hit === "FIXME") fixme++;
    }
    // Nothing to say: return nothing, and the panel leaves it out.
    if (todo + fixme === 0) return null;
    return stats([
      { label: "TODO", value: todo },
      { label: "FIXME", value: fixme, tone: fixme > 0 ? "warn" : "neutral" },
    ]);
  },
});
