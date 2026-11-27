/**
 * The personal layer as plain text, for a terminal (`nod inbox test`): the
 * same blocks the panel draws, one line per item.
 *
 * Pure: imports nothing from Node.
 */
import type { Block, Insight } from "./blocks.ts";
import { markdownToText } from "./markdown.ts";
import type { InsightState, PersonalAttention } from "./types.ts";

const ATTENTION_WORDS = { 1: "+1 (up a tier)", 0: "0", [-1]: "-1 (down a tier)", mute: "mute" };

/** The combined attention and each mark, as lines. */
export function formatAttention(a: PersonalAttention): string {
  const lines = [`attention: ${ATTENTION_WORDS[a.attention]}`];
  if (a.tags.length) lines.push(`tags: ${a.tags.join(", ")}`);
  if (a.fyi) lines.push("fyi: yes");
  for (const m of a.marks) {
    const what = [
      m.attention === undefined
        ? ""
        : m.attention === "mute"
          ? "mute"
          : m.attention > 0
            ? "+1"
            : "-1",
      m.tag ? `[${m.tag}]` : "",
      m.fyi ? "fyi" : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`  ${m.classifier}: ${what} ${m.detail}`.trimEnd());
  }
  for (const e of a.errors) lines.push(`  error: ${e}`);
  return lines.join("\n");
}

const indent = (text: string, by = "  ") =>
  text
    .split("\n")
    .map((l) => (l ? by + l : l))
    .join("\n");

/** One block as text. */
export function formatBlock(block: Block): string {
  const head = "label" in block && block.label ? `${block.label}\n` : "";
  switch (block.type) {
    case "breakdown": {
      const sum = block.items.reduce((s, i) => s + i.value, 0) || 1;
      return (
        head +
        block.items
          .map((i) => {
            const pct = Math.round((i.value / sum) * 100);
            const unit = block.unit ? ` ${block.unit}` : "";
            return `${i.label}: ${i.value}${unit} (${pct}%)${i.note ? `  ${i.note}` : ""}`;
          })
          .join("\n")
      );
    }
    case "stats":
      return (
        head +
        block.items
          .map(
            (s) =>
              `${s.label}: ${s.value}${s.unit ? ` ${s.unit}` : ""}${s.hint ? `  (${s.hint})` : ""}`,
          )
          .join("\n")
      );
    case "series": {
      const max = Math.max(...block.points.map((p) => Math.abs(p.y)), 1);
      return (
        head +
        block.points
          .map(
            (p) => `${p.x.padEnd(10)} ${"█".repeat(Math.round((Math.abs(p.y) / max) * 20))} ${p.y}`,
          )
          .join("\n")
      );
    }
    case "files":
      return (
        head +
        block.items
          .map((f) => {
            const parts = [f.path];
            if (f.value !== undefined) parts.push(String(f.value));
            if (f.note) parts.push(f.note);
            return parts.join("  ");
          })
          .join("\n")
      );
    case "text":
      return markdownToText(block.markdown);
  }
}

/** An insight's blocks as text, separated by blank lines. */
export function formatInsight(insight: Insight): string {
  return insight.blocks.map(formatBlock).join("\n\n");
}

/** An analyzer's state as text: its title, origin, status and blocks. */
export function formatInsightState(s: InsightState): string {
  const title = s.status === "ready" && s.insight.title ? s.insight.title : s.title;
  const head = `${title} (${s.id}, ${s.origin}, ${s.when})`;
  switch (s.status) {
    case "ready": {
      const summary = s.insight.summary ? `\n  ${s.insight.summary}` : "";
      return `${head}${summary}\n${indent(formatInsight(s.insight), "    ")}`;
    }
    case "empty":
      return `${head}: nothing to show`;
    case "running":
      return `${head}: running`;
    case "failed":
      return `${head}: failed: ${s.error}`;
  }
}
