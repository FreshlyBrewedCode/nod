import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FAKE_RELEASES } from "../../server/update/fake-release-feed";
import { Markdown } from "../components/markdown";
import { MAX_MARKDOWN, parseInline, parseMarkdown, plainText, safeHref } from "./markdown";

const html = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));

describe("blocks", () => {
  test("semantic-release's notes: a heading, sections, lists", () => {
    const blocks = parseMarkdown(FAKE_RELEASES[2]!.notes);
    expect(blocks.map((b) => (b.t === "heading" ? `h${b.level}` : b.t))).toEqual([
      "h2",
      "h3",
      "list",
      "h3",
      "list",
    ]);
    const first = blocks[0]!;
    expect(first.t === "heading" && plainText(first.children)).toBe("0.3.0 (2026-11-25)");
    const list = blocks[2]!;
    expect(list.t === "list" && list.items).toHaveLength(2);
  });

  test("paragraphs join their lines; a blank line ends them", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { t: "paragraph", children: [{ t: "text", text: "one two" }] },
      { t: "paragraph", children: [{ t: "text", text: "three" }] },
    ]);
  });

  test("ordered lists, and an indented line continues its item", () => {
    expect(parseMarkdown("1. first\n   more\n2. second")).toEqual([
      {
        t: "list",
        ordered: true,
        items: [[{ t: "text", text: "first more" }], [{ t: "text", text: "second" }]],
      },
    ]);
  });

  test("a heading's closing hashes go; seven hashes are text", () => {
    expect(parseMarkdown("## Title ##")).toEqual([
      { t: "heading", level: 2, children: [{ t: "text", text: "Title" }] },
    ]);
    expect(parseMarkdown("####### seven")[0]!.t).toBe("paragraph");
  });

  test("the input is bounded", () => {
    const blocks = parseMarkdown(`${"a".repeat(MAX_MARKDOWN)}TAIL`);
    expect(plainText((blocks[0] as unknown as { children: never }).children)).not.toContain("TAIL");
  });
});

describe("inline", () => {
  test("code, bold, italic, links", () => {
    expect(
      parseInline("run `nod key test` **now**, *please*: [docs](https://nod.example.test/)"),
    ).toEqual([
      { t: "text", text: "run " },
      { t: "code", text: "nod key test" },
      { t: "text", text: " " },
      { t: "strong", children: [{ t: "text", text: "now" }] },
      { t: "text", text: ", " },
      { t: "em", children: [{ t: "text", text: "please" }] },
      { t: "text", text: ": " },
      { t: "link", href: "https://nod.example.test/", children: [{ t: "text", text: "docs" }] },
    ]);
  });

  test("snake_case and a lone star stay text", () => {
    expect(parseInline("a snake_case_name and 2 * 3")).toEqual([
      { t: "text", text: "a snake_case_name and 2 * 3" },
    ]);
    expect(parseInline("__bold__ and _it_")).toEqual([
      { t: "strong", children: [{ t: "text", text: "bold" }] },
      { t: "text", text: " and " },
      { t: "em", children: [{ t: "text", text: "it" }] },
    ]);
  });

  test("escapes, and marks inside code stay as written", () => {
    expect(parseInline("\\*not\\* `**x**`")).toEqual([
      { t: "text", text: "*not* " },
      { t: "code", text: "**x**" },
    ]);
  });

  test("a link around code, as semantic-release writes the commits", () => {
    expect(parseInline("([`abc1234`](https://github.com/o/r/commit/abc1234))")).toEqual([
      { t: "text", text: "(" },
      {
        t: "link",
        href: "https://github.com/o/r/commit/abc1234",
        children: [{ t: "code", text: "abc1234" }],
      },
      { t: "text", text: ")" },
    ]);
  });
});

describe("hostile input", () => {
  test("only absolute http(s) URLs are links", () => {
    expect(safeHref("https://github.com/x")).toBe("https://github.com/x");
    expect(safeHref("http://example.test/")).toBe("http://example.test/");
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "//evil.example.test/x",
      "/relative",
      "#top",
      "https://user:pass@evil.example.test/",
      "file:///etc/passwd",
    ])
      expect(safeHref(bad)).toBeNull();
  });

  test("a javascript: link is its text only", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ t: "text", text: "click" }]);
    const out = html("[click](javascript:alert(document.cookie)) and [x](JAVASCRIPT:void(0))");
    expect(out).not.toContain("href");
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  test("raw HTML is text, escaped by React", () => {
    const out = html(
      '<script>alert(1)</script> <img src=x onerror="alert(1)"> <a href="javascript:x">a</a>\n\n## <iframe src="https://evil.example.test">',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain('<a href="javascript');
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img src=x onerror=");
  });

  test("an attribute cannot be smuggled through a link's target or text", () => {
    const out = html('[x" onmouseover="alert(1)](https://ok.example.test/" onclick="alert(1))');
    expect(out).not.toMatch(/<a [^>]*onclick/);
    expect(out).not.toMatch(/<a [^>]*onmouseover/);
  });

  test("links open in a new tab without the opener or a referrer", () => {
    expect(html("[docs](https://nod.example.test/)")).toBe(
      '<div class="text-tx2 text-[13.5px] leading-[1.6]"><p class="m-0 mt-2 first:mt-0"><a href="https://nod.example.test/" target="_blank" rel="noreferrer noopener" class="text-tx underline decoration-line2 underline-offset-2 hover:decoration-tx3 [overflow-wrap:anywhere]">docs</a></p></div>',
    );
  });

  test("deep nesting stops, without blowing the stack", () => {
    const deep = `${"[".repeat(5000)}x${"](https://a.example.test/)".repeat(5000)}`;
    expect(() => parseMarkdown(deep)).not.toThrow();
    const stars = `${"*a ".repeat(3000)}`;
    expect(() => parseMarkdown(stars)).not.toThrow();
  });
});
