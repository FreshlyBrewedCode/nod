/**
 * Release notes on screen: the tree `lib/markdown.ts` parses, drawn as React
 * elements, so every piece of text is escaped by React and nothing is HTML.
 * Links open in a new tab, without the opener or a referrer, and only
 * `http(s)` ones exist (the parser drops the rest to text).
 */

import { Fragment, type ReactNode } from "react";

import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { cn } from "@/lib/utils";

function inline(nodes: ReadonlyArray<Inline>): ReactNode {
  return nodes.map((node, i) => {
    switch (node.t) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "code":
        return (
          <code key={i} className="text-tx font-mono text-[0.9em] [overflow-wrap:anywhere]">
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="text-tx font-semibold">
            {inline(node.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{inline(node.children)}</em>;
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-tx underline decoration-line2 underline-offset-2 hover:decoration-tx3 [overflow-wrap:anywhere]"
          >
            {inline(node.children)}
          </a>
        );
    }
  });
}

function block(node: Block, i: number): ReactNode {
  switch (node.t) {
    case "heading":
      // A release's own title (`#`, `##`) and its sections (`###`): two sizes are enough.
      return node.level <= 2 ? (
        <h3 key={i} className="text-tx m-0 mt-4 mb-1 text-[14px] font-bold first:mt-0">
          {inline(node.children)}
        </h3>
      ) : (
        <h4
          key={i}
          className="text-tx3 m-0 mt-3.5 mb-1 text-[11px] font-semibold tracking-[0.08em] uppercase first:mt-0"
        >
          {inline(node.children)}
        </h4>
      );
    case "paragraph":
      return (
        <p key={i} className="m-0 mt-2 first:mt-0">
          {inline(node.children)}
        </p>
      );
    case "list": {
      const List = node.ordered ? "ol" : "ul";
      return (
        <List
          key={i}
          className={cn("m-0 mt-1 pl-5 first:mt-0", node.ordered ? "list-decimal" : "list-disc")}
        >
          {node.items.map((item, j) => (
            <li key={j} className="mt-1 pl-0.5 marker:text-tx3">
              {inline(item)}
            </li>
          ))}
        </List>
      );
    }
  }
}

/** Markdown as calm text: `source` is parsed here, never inserted as HTML. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn("text-tx2 text-[13.5px] leading-[1.6]", className)}>
      {parseMarkdown(source).map(block)}
    </div>
  );
}
