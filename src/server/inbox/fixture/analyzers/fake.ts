/** The fake scenario's analyzers (`../inbox.ts`): one per block type and state. */
import { breakdown, defineAnalyzer, series, stats, text } from "@frebreco/nod/kit/inbox";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (f: { added: number; removed: number }) => f.added + f.removed;
const isTest = (path: string) => /\.(test|spec)\.|(^|\/)tests?\//.test(path);

/** `stats`: files, lines, and how much of it is tests. */
export const size = defineAnalyzer({
  id: "size",
  title: "Size",
  when: "poll",
  run({ files }) {
    const total = files.reduce((s, f) => s + lines(f), 0);
    const tests = files.filter((f) => isTest(f.path)).reduce((s, f) => s + lines(f), 0);
    const share = total ? Math.round((tests / total) * 100) : 0;
    return stats([
      { label: "files", value: files.length },
      { label: "lines", value: total },
      {
        label: "tests",
        value: share,
        unit: "%",
        tone: share >= 25 ? "good" : "warn",
        hint: "of the changed lines",
      },
    ]);
  },
});

/** `series` as bars: the biggest files. */
export const linesByFile = defineAnalyzer({
  id: "lines-by-file",
  title: "Biggest files",
  when: "poll",
  run({ files }) {
    const top = [...files].sort((a, b) => lines(b) - lines(a)).slice(0, 8);
    if (top.length < 2) return null;
    return series(
      top.map((f) => ({ x: f.path.split("/").pop()!, y: lines(f) })),
      { label: "changed lines per file", unit: "lines", tone: "c2" },
    );
  },
});

/** `breakdown` as a donut: lines by top-level folder. */
export const areas = defineAnalyzer({
  id: "areas",
  title: "Where it changes",
  when: "poll",
  run({ files }) {
    const by = new Map<string, number>();
    for (const f of files)
      by.set(f.path.split("/")[0]!, (by.get(f.path.split("/")[0]!) ?? 0) + lines(f));
    const tones = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;
    return breakdown(
      [...by].map(([label, value], i) => ({ label, value, tone: tones[i % tones.length] })),
      { style: "donut", unit: "lines" },
    );
  },
});

/** `series` as a line: how often the touched files changed, week by week (`git log`, no contents). */
export const trend = defineAnalyzer({
  id: "trend",
  title: "Churn",
  when: "poll",
  async run(ctx) {
    const paths = ctx.files.map((f) => `:(literal)${f.path}`);
    const log = await ctx.git([
      "log",
      "--since=30.days.ago",
      "--name-only",
      "--format=%x00%H%x09%ae%x09%an%x09%as",
      ctx.revs.base,
      "--",
      ...paths,
    ]);
    const weeks = new Map<string, number>();
    for (const record of log.split("\0")) {
      const date = record.split("\n")[0]?.split("\t")[3];
      if (!date) continue;
      const day = new Date(`${date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - day.getUTCDay());
      const week = day.toISOString().slice(5, 10);
      weeks.set(week, (weeks.get(week) ?? 0) + 1);
    }
    if (weeks.size < 2) return null;
    return series(
      [...weeks].sort((a, b) => a[0].localeCompare(b[0])).map(([x, y]) => ({ x, y })),
      { style: "line", label: "commits to these files per week", tone: "info" },
    );
  },
});

/** `text`: limited markdown. */
export const notes = defineAnalyzer({
  id: "notes",
  title: "Notes",
  when: "poll",
  appliesTo: ({ pr }) => pr.number % 2 === 0,
  run: ({ pr, files }) =>
    text(
      [
        `**${files.length} files** in \`${pr.repo}\`.`,
        "",
        "- read the tests first",
        `- then the biggest file, *${files[0]?.path ?? "none"}*`,
        "",
        `[Open it on GitHub](https://github.com/${pr.repo}/pull/${pr.number})`,
      ].join("\n"),
    ),
});

/** `running` for 8 s after each load, on one PR. */
export const slow = defineAnalyzer({
  id: "slow",
  title: "Slow check",
  when: "poll",
  appliesTo: ({ pr }) => pr.number === 482,
  async run() {
    await sleep(8000);
    return stats([{ label: "took", value: 8, unit: "s" }]);
  },
});

/** `when: "open"`: runs when the panel opens, 15 s. */
export const waits = defineAnalyzer({
  id: "on-open",
  title: "When opened",
  when: "open",
  appliesTo: ({ pr }) => pr.number === 482,
  async run() {
    await sleep(15_000);
    return text("This ran because you **opened** the pull request.");
  },
});

/** `failed`: it throws. */
export const coverage = defineAnalyzer({
  id: "coverage",
  title: "Coverage",
  when: "poll",
  appliesTo: ({ pr }) => pr.number === 485,
  run() {
    throw new Error("no coverage report for this head; run `bun test --coverage` in CI first");
  },
});

/** A timeout: it never yields, so the runner kills its process and starts a new one. */
export const spin = defineAnalyzer({
  id: "spin",
  title: "Stuck analyzer",
  when: "poll",
  appliesTo: ({ pr }) => pr.number === 490,
  run() {
    for (;;) {
      // on purpose
    }
  },
});
