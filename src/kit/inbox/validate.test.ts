import { describe, expect, test } from "bun:test";

import {
  INSIGHT_LIMITS,
  breakdown,
  files,
  insight,
  series,
  stats,
  text,
  type Insight,
} from "./blocks.ts";
import { markdownToText, parseInline, parseMarkdown } from "./markdown.ts";
import {
  MAX_MARKS,
  cleanString,
  parseAttention,
  parseBlock,
  parseInsight,
  parseInsightState,
} from "./validate.ts";

describe("block constructors", () => {
  test("build plain JSON that survives the validator unchanged", () => {
    const value: Insight = insight(
      breakdown(
        [
          { label: "code", value: 120, tone: "c1", note: "+100 −20" },
          { label: "tests", value: 40, tone: "c2" },
        ],
        { unit: "lines", style: "donut" },
      ),
      stats([{ label: "files", value: 7, hint: "lockfiles left out" }]),
      series([3, 1, 4], { label: "per week", style: "line", tone: "info" }),
      files(["a.ts", { path: "b.ts", value: 3, pr: { repo: "acme/widgets", number: 14 } }]),
      text("**bold** and `code`"),
    );
    const wire = JSON.parse(JSON.stringify(value));
    expect(parseInsight(wire)).toEqual(value);
    expect(value.blocks[2]).toEqual({
      type: "series",
      label: "per week",
      style: "line",
      tone: "info",
      points: [
        { x: "1", y: 3 },
        { x: "2", y: 1 },
        { x: "3", y: 4 },
      ],
    });
  });
});

describe("parseInsight", () => {
  test("is null for anything that is not an insight with a surviving block", () => {
    for (const v of [null, 1, "x", [], {}, { blocks: "x" }, { blocks: [] }, { blocks: [{}] }]) {
      expect(parseInsight(v)).toBeNull();
    }
  });

  test("drops unknown block types, HTML-ish blocks and malformed blocks, keeps the rest", () => {
    const out = parseInsight({
      title: "T",
      blocks: [
        { type: "html", html: "<script>alert(1)</script>" },
        { type: "svg", svg: "<svg/>" },
        { type: "stats", items: [{ label: "ok", value: 1 }] },
        { type: "breakdown", items: [{ label: "neg", value: -1 }] },
        { type: "files", items: [{ note: "no path" }] },
        { type: "text", markdown: "   " },
      ],
    });
    expect(out).toEqual({
      title: "T",
      blocks: [{ type: "stats", items: [{ label: "ok", value: 1 }] }],
    });
  });

  test("drops unknown fields, CSS colours and non-finite numbers", () => {
    const block = parseBlock({
      type: "breakdown",
      onclick: "x",
      style: "pie",
      items: [
        { label: "a", value: 1, tone: "#ff0000", color: "red" },
        { label: "b", value: Number.NaN },
        { label: "c", value: Number.POSITIVE_INFINITY },
        { label: "d", value: 2, tone: "warn" },
      ],
    });
    expect(block).toEqual({
      type: "breakdown",
      items: [
        { label: "a", value: 1 },
        { label: "d", value: 2, tone: "warn" },
      ],
    });
  });

  test("caps counts and lengths", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}.ts` }));
    const out = parseInsight({
      title: "x".repeat(500),
      blocks: [
        ...Array.from({ length: 20 }, () => ({ type: "files", items: many })),
        { type: "text", markdown: "y".repeat(10_000) },
      ],
    })!;
    expect(out.blocks).toHaveLength(INSIGHT_LIMITS.blocks);
    expect(out.title!.length).toBe(INSIGHT_LIMITS.title);
    expect(out.title!.endsWith("…")).toBe(true);
    const first = out.blocks[0]!;
    expect(first.type === "files" && first.items.length).toBe(INSIGHT_LIMITS.files);
    const long = parseBlock({ type: "text", markdown: "y".repeat(10_000) })!;
    expect(long.type === "text" && long.markdown.length).toBe(INSIGHT_LIMITS.text);
  });

  test("a PR reference needs a positive integer and a plausible repo", () => {
    const block = parseBlock({
      type: "files",
      items: [
        { path: "a", pr: { number: 3, repo: "acme/widgets" } },
        { path: "b", pr: { number: 1.5 } },
        { path: "c", pr: { number: 4, repo: "javascript:alert(1)" } },
      ],
    });
    expect(block).toEqual({
      type: "files",
      items: [
        { path: "a", pr: { number: 3, repo: "acme/widgets" } },
        { path: "b" },
        { path: "c", pr: { number: 4 } },
      ],
    });
  });

  test("stats keep string values, series accept numeric x", () => {
    expect(parseBlock({ type: "stats", items: [{ label: "share", value: "3 of 7" }] })).toEqual({
      type: "stats",
      items: [{ label: "share", value: "3 of 7" }],
    });
    expect(parseBlock({ type: "series", points: [{ x: 2026, y: 1 }, { x: "w2" }] })).toEqual({
      type: "series",
      points: [{ x: "2026", y: 1 }],
    });
  });
});

describe("cleanString", () => {
  test("drops control and bidi characters, folds whitespace unless multiline", () => {
    expect(cleanString("a\u0000b‮c\u0007\n d", 50)).toBe("abc d");
    expect(cleanString("a\r\n\tb", 50, true)).toBe("a\n  b");
    expect(cleanString(5, 50)).toBeUndefined();
    expect(cleanString(" \u0000 ", 50)).toBeUndefined();
  });
});

describe("parseAttention", () => {
  test("keeps the fixed vocabulary only", () => {
    expect(
      parseAttention([
        { attention: 1, tag: "auth", detail: "watching auth", risk: 3 },
        { attention: 2, detail: "not a value" },
        { attention: "+1", detail: "a string" },
        { attention: -1, detail: "down" },
        { attention: "mute", detail: "muted" },
        { fyi: true, detail: "worth knowing" },
        { tag: "x" },
        "junk",
      ]),
    ).toEqual([
      { attention: 1, tag: "auth", detail: "watching auth" },
      { attention: -1, detail: "down" },
      { attention: "mute", detail: "muted" },
      { fyi: true, detail: "worth knowing" },
    ]);
  });

  test("is empty for anything but a list, and capped", () => {
    expect(parseAttention({ attention: 1, detail: "x" })).toEqual([]);
    const many = Array.from({ length: 100 }, () => ({ attention: 1, detail: "x" }));
    expect(parseAttention(many)).toHaveLength(MAX_MARKS);
  });
});

describe("parseInsightState", () => {
  const base = { id: "hotspots", title: "Hotspots", origin: "default", when: "poll" };
  test("each status", () => {
    expect(parseInsightState({ ...base, status: "running" })).toEqual({
      ...base,
      status: "running",
    } as never);
    expect(parseInsightState({ ...base, status: "failed", error: "boom\nstack", ms: 3 })).toEqual({
      ...base,
      status: "failed",
      error: "boom\nstack",
      ms: 3,
    } as never);
    expect(
      parseInsightState({
        ...base,
        status: "ready",
        insight: { blocks: [{ type: "text", markdown: "hi" }] },
      }),
    ).toEqual({
      ...base,
      status: "ready",
      insight: { blocks: [{ type: "text", markdown: "hi" }] },
    } as never);
  });
  test("a ready state whose insight does not survive is empty; junk is null", () => {
    expect(parseInsightState({ ...base, status: "ready", insight: { blocks: [] } })?.status).toBe(
      "empty",
    );
    expect(parseInsightState({ ...base, origin: "theirs", status: "empty" })).toBeNull();
    expect(parseInsightState({ ...base, status: "done" })).toBeNull();
    expect(parseInsightState({ ...base, when: "always", status: "empty" })).toBeNull();
  });
});

describe("limited markdown", () => {
  test("paragraphs, lists, headings and inline marks", () => {
    expect(
      parseMarkdown("# Title\n\nSome **bold** and *em*\nwrapped.\n\n- one `x`\n- two\n  more"),
    ).toEqual([
      { type: "paragraph", strong: true, content: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Some " },
          { type: "strong", text: "bold" },
          { type: "text", text: " and " },
          { type: "em", text: "em" },
          { type: "text", text: " wrapped." },
        ],
      },
      {
        type: "list",
        items: [
          [
            { type: "text", text: "one " },
            { type: "code", text: "x" },
          ],
          [{ type: "text", text: "two more" }],
        ],
      },
    ]);
  });

  test("links only to http(s); HTML stays text", () => {
    expect(parseInline("[ok](https://example.test/a) [bad](javascript:alert(1)) <b>x</b>")).toEqual(
      [
        { type: "link", text: "ok", href: "https://example.test/a" },
        { type: "text", text: " [bad](javascript:alert(1)) <b>x</b>" },
      ],
    );
  });

  test("snake_case words are not emphasis", () => {
    expect(parseInline("a snake_case_name here")).toEqual([
      { type: "text", text: "a snake_case_name here" },
    ]);
  });

  test("as plain text", () => {
    expect(markdownToText("**a** [b](https://example.test)\n\n- c")).toBe(
      "a b (https://example.test)\n\n- c",
    );
  });
});
