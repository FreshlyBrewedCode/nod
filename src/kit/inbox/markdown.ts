/**
 * The limited markdown of a `text` block (ADR 0009 decision 5), parsed into
 * a small tree so a renderer draws nodes and never sets a string as HTML.
 *
 * Supported: paragraphs (separated by a blank line), `-`/`*` lists, a
 * `#` heading line (shown as a bold paragraph), `**bold**`, `*italic*` or
 * `_italic_`, `` `code` ``, and `[text](https://…)` links to `http` and
 * `https` only. Everything else, HTML included, is plain text.
 *
 * Pure: imports nothing from Node.
 */

/** A run of inline content. Nodes never nest. */
export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

/** A paragraph or a list; a heading is a paragraph with `strong` set. */
export type MdBlock =
  | { type: "paragraph"; strong?: true; content: MdInline[] }
  | { type: "list"; items: MdInline[][] };

/** Parses limited markdown; see the module comment for what is supported. */
export function parseMarkdown(markdown: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (paragraph.length)
      blocks.push({ type: "paragraph", content: parseInline(paragraph.join(" ")) });
    paragraph = [];
    if (list) blocks.push({ type: "list", items: list.map(parseInline) });
    list = null;
  };
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "paragraph", strong: true, content: parseInline(heading[1]!) });
      continue;
    }
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) flush();
      (list ??= []).push(item[1]!);
      continue;
    }
    if (list) {
      // A line under a list item continues it.
      list[list.length - 1] += ` ${line}`;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE =
  /`([^`]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Parses one line of inline markdown. A link that is not `http(s)` stays text. */
export function parseInline(line: string): MdInline[] {
  const out: MdInline[] = [];
  const push = (node: MdInline) => {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else if (node.text !== "") out.push(node);
  };
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    push({ type: "text", text: line.slice(at, m.index) });
    at = m.index + m[0].length;
    if (m[1] !== undefined) push({ type: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined)
      push({ type: "strong", text: m[2] ?? m[3]! });
    else if (m[4] !== undefined || m[5] !== undefined) push({ type: "em", text: m[4] ?? m[5]! });
    else if (/^https?:\/\/[^\s]+$/i.test(m[7]!)) push({ type: "link", text: m[6]!, href: m[7]! });
    else push({ type: "text", text: m[0] });
  }
  push({ type: "text", text: line.slice(at) });
  return out;
}

/** The markdown as plain text: emphasis dropped, links as `text (url)`. For terminals. */
export function markdownToText(markdown: string): string {
  const inline = (nodes: MdInline[]) =>
    nodes.map((n) => (n.type === "link" ? `${n.text} (${n.href})` : n.text)).join("");
  return parseMarkdown(markdown)
    .map((b) =>
      b.type === "paragraph" ? inline(b.content) : b.items.map((i) => `- ${inline(i)}`).join("\n"),
    )
    .join("\n\n");
}
