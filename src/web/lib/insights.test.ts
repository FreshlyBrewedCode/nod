import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { InsightState } from "../../shared/protocol";
import {
  barPath,
  breakdownParts,
  donutArcs,
  fileHref,
  filesMax,
  formatNumber,
  insightsEmptyLine,
  insightsSummary,
  isCompact,
  labelIndices,
  niceMax,
  partTone,
  prRefText,
  seriesLayout,
  sha256Hex,
  shownInsights,
  splitPath,
  toneColor,
  withUnit,
} from "./insights";

const base = { title: "T", origin: "default", when: "poll" } as const;
const ready = (id: string): InsightState => ({
  ...base,
  id,
  status: "ready",
  insight: { blocks: [] },
});

describe("which insights show", () => {
  const list: InsightState[] = [
    ready("a"),
    { ...base, id: "b", status: "empty" },
    { ...base, id: "c", status: "running" },
    { ...base, id: "d", status: "failed", error: "boom" },
  ];

  test("empty ones are hidden, the rest keep the inbox's order", () => {
    expect(shownInsights(list).map((i) => i.id)).toEqual(["a", "c", "d"]);
    expect(shownInsights(undefined)).toEqual([]);
  });

  test("the summary counts what shows, and what is running or failed", () => {
    expect(insightsSummary(list)).toBe("3 · 1 running · 1 failed");
    expect(insightsSummary([ready("a")])).toBe("1");
  });

  test("the empty line: nothing to say, not looked at yet, or no section", () => {
    expect(insightsEmptyLine(list, true)).toBeNull();
    expect(insightsEmptyLine([{ ...base, id: "b", status: "empty" }], true)).toMatch(
      /nothing to say/,
    );
    expect(insightsEmptyLine(undefined, true)).toMatch(/not looked at it yet/);
    expect(insightsEmptyLine([], false)).toBeNull();
  });
});

describe("tones are theme tokens, never the payload's", () => {
  test("a known tone maps to its token", () => {
    expect(toneColor("good")).toBe("var(--insight-good)");
    expect(toneColor("c3")).toBe("var(--insight-c3)");
  });

  test("anything else is the fallback, CSS never passes", () => {
    expect(toneColor(undefined)).toBe("var(--insight-neutral)");
    expect(toneColor("red; background:url(x)")).toBe("var(--insight-neutral)");
    expect(toneColor("#ff0000", "muted")).toBe("var(--insight-muted)");
    expect(toneColor("constructor")).toBe("var(--insight-neutral)");
  });

  test("parts without a tone take the series slots in order", () => {
    expect([0, 1, 5, 6].map((i) => partTone(undefined, i))).toEqual([
      "var(--insight-c1)",
      "var(--insight-c2)",
      "var(--insight-c6)",
      "var(--insight-c1)",
    ]);
    expect(partTone("warn", 0)).toBe("var(--insight-warn)");
  });
});

describe("numbers", () => {
  test("grouped below 10,000, compact above, one decimal at most", () => {
    expect(formatNumber(404)).toBe("404");
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(12_345)).toBe("12.3k");
    expect(formatNumber(3_400_000)).toBe("3.4M");
    expect(formatNumber(0.25)).toBe("0.3");
    expect(formatNumber(Number.NaN)).toBe("–");
  });

  test("units: a percent sticks to the number", () => {
    expect(withUnit(5, "%")).toBe("5%");
    expect(withUnit(404, "lines")).toBe("404 lines");
    expect(withUnit("n/a", undefined)).toBe("n/a");
  });
});

describe("breakdown", () => {
  test("shares add up to 100 in words, exact in proportions", () => {
    const { parts, total } = breakdownParts([
      { label: "code", value: 308, tone: "c1" },
      { label: "tests", value: 16, tone: "c2" },
      { label: "comments", value: 74, tone: "c3" },
      { label: "docs", value: 6, tone: "c4" },
    ]);
    expect(total).toBe(404);
    expect(parts.map((p) => p.shareText)).toEqual(["76%", "4%", "18%", "2%"]);
    expect(parts.reduce((s, p) => s + p.share, 0)).toBeCloseTo(100);
    expect(parts[0]!.color).toBe("var(--insight-c1)");
  });

  test("a tiny part says <1%; negative and non-finite parts are left out", () => {
    const { parts } = breakdownParts([
      { label: "a", value: 999 },
      { label: "b", value: 1 },
      { label: "c", value: -5 },
      { label: "d", value: Number.POSITIVE_INFINITY },
    ]);
    expect(parts.map((p) => [p.label, p.shareText])).toEqual([
      ["a", "100%"],
      ["b", "<1%"],
    ]);
  });

  test("nothing at all: no shares, no division by zero", () => {
    const { parts, total } = breakdownParts([{ label: "a", value: 0 }]);
    expect(total).toBe(0);
    expect(parts[0]!.shareText).toBe("0%");
    expect(donutArcs(parts)).toEqual([]);
  });

  test("donut arcs follow each other from the top, with a gap between", () => {
    const { parts } = breakdownParts([
      { label: "a", value: 75 },
      { label: "b", value: 25 },
    ]);
    expect(donutArcs(parts, 2)).toEqual([
      { color: "var(--insight-c1)", dash: "73 27", offset: -0 },
      { color: "var(--insight-c2)", dash: "23 77", offset: -75 },
    ]);
    // One part: a whole ring, no gap.
    const one = breakdownParts([{ label: "a", value: 3 }]).parts;
    expect(donutArcs(one)[0]!.dash).toBe("100 0");
  });
});

describe("series", () => {
  test("a round top for the axis", () => {
    expect([0, 1, 7, 8, 54, 120, 999].map(niceMax)).toEqual([1, 1, 10, 10, 100, 200, 1000]);
    expect(niceMax(23)).toBe(25);
  });

  test("bars: equal bands, at most 24 px wide, heights from 0 to the top", () => {
    const l = seriesLayout(
      [
        { x: "a", y: 5 },
        { x: "b", y: 10 },
      ],
      200,
      100,
    );
    expect(l.top).toBe(10);
    expect(l.band).toBe(100);
    expect(l.barWidth).toBe(24);
    expect(l.points.map((p) => [p.cx, p.h])).toEqual([
      [50, 50],
      [150, 100],
    ]);
    expect(l.line).toBe("M50 50 L150 0");
  });

  test("narrow bands keep 2 px of air; bad values sit at 0", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: String(i), y: i === 3 ? -1 : 1 }));
    const l = seriesLayout(pts, 100, 40);
    expect(l.barWidth).toBeLessThanOrEqual(l.band - 0);
    expect(l.barWidth).toBeGreaterThanOrEqual(1);
    expect(l.points[3]!.h).toBe(0);
    expect(seriesLayout([{ x: "a", y: Number.NaN }], 100, 40).points[0]!.h).toBe(0);
  });

  test("x labels thin out on a narrow chart, first and last always", () => {
    expect(labelIndices(8, 800, 60)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(labelIndices(12, 300, 60)).toEqual([0, 3, 6, 11]);
    expect(labelIndices(30, 280, 56)).toEqual([0, 6, 12, 18, 29]);
    expect(labelIndices(1, 100, 60)).toEqual([0]);
    expect(labelIndices(0, 100, 60)).toEqual([]);
  });

  test("a bar is rounded at its end only", () => {
    expect(barPath(10, 8, 20, 40)).toBe("M6 40V24Q6 20 10 20H10Q14 20 14 24V40Z");
    expect(barPath(10, 8, 0, 40)).toBe("");
  });
});

describe("files", () => {
  const pr = { url: "https://github.com/tallyho/fieldbook/pull/481", repo: "tallyho/fieldbook" };

  test("sha256 as GitHub's diff anchors use it", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // Two blocks, and UTF-8.
    expect(sha256Hex("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
    for (const s of ["ü/ä.ts", "x".repeat(55), "x".repeat(56), "docs/modules/billing.md"])
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });

  test("a file links to its diff in this PR", () => {
    expect(fileHref({ path: "core/tenant/context.ts" }, pr)).toBe(
      `${pr.url}/files#diff-${sha256Hex("core/tenant/context.ts")}`,
    );
  });

  test("a file of another PR links to that PR, on this PR's host", () => {
    expect(fileHref({ path: "x", pr: { number: 490 } }, pr)).toBe(
      "https://github.com/tallyho/fieldbook/pull/490",
    );
    expect(
      fileHref(
        { path: "x", pr: { repo: "finance/ledger", number: 57 } },
        {
          url: "https://acme.ghe.com/tallyho/fieldbook/pull/1",
          repo: "acme.ghe.com/tallyho/fieldbook",
        },
      ),
    ).toBe("https://acme.ghe.com/finance/ledger/pull/57");
  });

  test("anything that is not owner/name, or a PR URL that is not http(s), links nowhere", () => {
    expect(fileHref({ path: "x", pr: { repo: "../../evil", number: 1 } }, pr)).toBeNull();
    expect(fileHref({ path: "x", pr: { repo: "a/b/c", number: 1 } }, pr)).toBeNull();
    expect(fileHref({ path: "x", pr: { number: 1.5 } }, pr)).toBeNull();
    expect(fileHref({ path: "x" }, { url: "javascript:alert(1)", repo: "a/b" })).toBeNull();
    expect(fileHref({ path: "x" }, { url: "", repo: "a/b" })).toBeNull();
  });

  test("words for a PR reference, the path split, the largest value", () => {
    expect(prRefText({ number: 490 }, "tallyho/fieldbook")).toBe("#490");
    expect(prRefText({ repo: "tallyho/fieldbook", number: 490 }, "tallyho/fieldbook")).toBe("#490");
    expect(prRefText({ repo: "finance/ledger", number: 5 }, "tallyho/fieldbook")).toBe(
      "finance/ledger#5",
    );
    expect(splitPath("core/auth/session.ts")).toEqual({ dir: "core/auth/", name: "session.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
    expect(filesMax([{ value: 3 }, {}, { value: Number.NaN }])).toBe(3);
    expect(filesMax([])).toBe(0);
  });
});

describe("compact insights sit side by side on a wide panel", () => {
  const withBlocks = (blocks: unknown[]): InsightState =>
    ({ ...base, id: "x", status: "ready", insight: { blocks } }) as InsightState;
  test("figures, a donut, a line, a short text, running, failed", () => {
    expect(isCompact(withBlocks([{ type: "stats", items: [{ label: "a", value: 1 }] }]))).toBe(
      true,
    );
    expect(isCompact(withBlocks([{ type: "breakdown", style: "donut", items: [] }]))).toBe(true);
    expect(isCompact(withBlocks([{ type: "series", style: "line", points: [] }]))).toBe(true);
    expect(isCompact(withBlocks([{ type: "text", markdown: "short" }]))).toBe(true);
    expect(isCompact({ ...base, id: "r", status: "running" })).toBe(true);
    expect(isCompact({ ...base, id: "f", status: "failed", error: "e" })).toBe(true);
  });
  test("a bar, files, bars, long text, or many blocks take the whole width", () => {
    expect(isCompact(withBlocks([{ type: "breakdown", items: [] }]))).toBe(false);
    expect(isCompact(withBlocks([{ type: "files", items: [] }]))).toBe(false);
    expect(isCompact(withBlocks([{ type: "series", points: [] }]))).toBe(false);
    expect(isCompact(withBlocks([{ type: "text", markdown: "x".repeat(400) }]))).toBe(false);
    expect(isCompact(withBlocks([]))).toBe(false);
  });
});
