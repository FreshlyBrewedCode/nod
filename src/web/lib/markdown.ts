/**
 * Limited markdown, for release notes (ADR 0008 §9): parsed into a small
 * tree that `components/markdown.tsx` draws as React elements. Nothing is
 * ever HTML: raw HTML in the source stays text (React escapes it), and only
 * `http(s)` links become links.
 *
 * - Blocks: headings (`#` to `######`), lists (`*`, `-`, `+`, or `1.`; one
 *   level, an indented item joins the list), paragraphs (lines up to a blank
 *   one). Anything else (quotes, tables, fences) reads as a paragraph.
 * - Inline: `code`, **bold** / __bold__, *italic* / _italic_ (an underscore
 *   only at a word's edge, so `snake_case` stays), [links](https://…), and
 *   backslash escapes. A link whose target is not `http:` or `https:` is its
 *   text alone.
 * - Bounded: the input is cut at `MAX_MARKDOWN` characters and nesting stops
 *   at `MAX_DEPTH`, so a hostile string cannot make it work hard.
 *
 * Epic B's `parseMarkdown` (`src/kit/inbox/`) may replace this later.
 */

export type Inline =
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "code"; readonly text: string }
  | { readonly t: "strong"; readonly children: ReadonlyArray<Inline> }
  | { readonly t: "em"; readonly children: ReadonlyArray<Inline> }
  | { readonly t: "link"; readonly href: string; readonly children: ReadonlyArray<Inline> };

export type Block =
  | { readonly t: "heading"; readonly level: number; readonly children: ReadonlyArray<Inline> }
  | { readonly t: "paragraph"; readonly children: ReadonlyArray<Inline> }
  | {
      readonly t: "list";
      readonly ordered: boolean;
      readonly items: ReadonlyArray<ReadonlyArray<Inline>>;
    };

export const MAX_MARKDOWN = 20_000;
const MAX_DEPTH = 6;

/** The link's target when it may be one: an absolute `http:` or `https:` URL; else null. */
export function safeHref(target: string): string | null {
  const trimmed = target.trim();
  // Only absolute URLs that say so: no relative paths, no protocol-relative `//host`.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BULLET = /^[ \t]*[*+-][ \t]+(.*)$/;
const NUMBERED = /^[ \t]*\d{1,9}[.)][ \t]+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.slice(0, MAX_MARKDOWN).replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const endParagraph = () => {
    if (paragraph.length)
      blocks.push({ t: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const endList = () => {
    if (list)
      blocks.push({
        t: "list",
        ordered: list.ordered,
        items: list.items.map((i) => parseInline(i)),
      });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim()) {
      endParagraph();
      endList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      endList();
      blocks.push({ t: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      endParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered && !/^\s/.test(line)) endList();
      list ??= { ordered, items: [] };
      list.items.push(item[1]!);
      continue;
    }
    // A line under an item continues it; otherwise it is a paragraph's.
    if (list && /^\s/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    endList();
    paragraph.push(line.trim());
  }
  endParagraph();
  endList();
  return blocks;
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The index of the `]` that closes the `[` at `open`, minding nesting and escapes; -1 if none. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** The `)` that closes the `(` at `open`, minding nested parentheses (`f(x)` in a URL); -1 if none. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Where the emphasis opened at `at` with `mark` closes; -1 if it does not. */
function closingMark(text: string, at: number, mark: string): number {
  const underscore = mark[0] === "_";
  for (let i = at + mark.length; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (!text.startsWith(mark, i)) continue;
    // `**` does not close a `*`.
    if (mark.length === 1 && text[i + 1] === mark) {
      i++;
      continue;
    }
    if (i === at + mark.length || /\s/.test(text[i - 1]!)) continue;
    if (underscore && isWordChar(text[i + mark.length])) continue;
    return i;
  }
  return -1;
}

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ t: "text", text: buffer });
    buffer = "";
  };
  if (depth >= MAX_DEPTH) return text ? [{ t: "text", text }] : [];

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1]!)) {
      buffer += text[++i];
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", text: text.slice(i + 1, end) });
        i = end;
        continue;
      }
    }
    if (c === "[") {
      const close = closingBracket(text, i);
      if (close !== -1 && text[close + 1] === "(") {
        const end = closingParen(text, close + 1);
        const target = end === -1 ? null : text.slice(close + 2, end);
        if (target !== null && !/\s/.test(target.trim())) {
          flush();
          const children = parseInline(text.slice(i + 1, close), depth + 1);
          const href = safeHref(target);
          if (href) out.push({ t: "link", href, children });
          else out.push(...children);
          i = end;
          continue;
        }
      }
    }
    if (c === "*" || c === "_") {
      const double = text[i + 1] === c;
      const mark = double ? c + c : c;
      const opensWord = !/\s/.test(text[i + mark.length] ?? " ");
      const leftOk = c === "*" || !isWordChar(text[i - 1]);
      if (opensWord && leftOk) {
        const close = closingMark(text, i, mark);
        if (close !== -1) {
          flush();
          const children = parseInline(text.slice(i + mark.length, close), depth + 1);
          out.push(double ? { t: "strong", children } : { t: "em", children });
          i = close + mark.length - 1;
          continue;
        }
      }
    }
    buffer += c;
  }
  flush();
  return out;
}

/** The text of inline nodes, without marks (for a label). */
export function plainText(nodes: ReadonlyArray<Inline>): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.text : plainText(n.children)))
    .join("");
}
