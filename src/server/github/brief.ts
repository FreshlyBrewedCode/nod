/**
 * The agent's brief, read from a PR body (concept decision 8): `What`,
 * `Why`, `Risk`, `Verified` and `Look at`, as headings (`## What`), bold
 * labels (`**What**`, `**Risk:**`) or plain labels (`What: …`); plus the
 * lines that link PRs and epics (`Epic: #n`, `Depends on #n`) and the agent's
 * name where the body names it.
 *
 * The body is written by the author (or their agent), so nothing here
 * decides anything: the verifier's summary does. This is only what a row
 * and the panel show.
 */

import type { Brief } from "../../shared/protocol";

export interface ParsedBody {
  /** null for an empty body. */
  readonly brief: Brief | null;
  readonly epic: number | null;
  readonly dependsOn: ReadonlyArray<number>;
  readonly agent: string | null;
}

type Field = "what" | "why" | "risk" | "verified" | "lookAt";

const LABELS: ReadonlyArray<readonly [RegExp, Field]> = [
  [/^what(?:\s+(?:it|this)\s+(?:does|changes))?$/i, "what"],
  [/^(?:summary|changes?)$/i, "what"],
  [/^why$/i, "why"],
  [/^(?:risks?|risk\s+level)$/i, "risk"],
  [
    /^(?:verified|verification|how\s+(?:it\s+was\s+|this\s+was\s+)?(?:verified|tested)|tested|testing|test\s+plan)$/i,
    "verified",
  ],
  [/^(?:look\s+at|where\s+to\s+look|review\s+focus|look\s+here)$/i, "lookAt"],
];

const fieldOf = (label: string): Field | null =>
  LABELS.find(([re]) => re.test(label.trim()))?.[1] ?? null;

/** Lines that are links or trailers, never part of the brief's text. */
const META: ReadonlyArray<RegExp> = [
  /^epic\s*:/i,
  /^depends\s+on\b/i,
  /^fyi\b/i,
  /^agent\s*:/i,
  /^_?opened by .+ \(agent\)/i,
  /^co-authored-by\s*:/i,
  /^(?:🤖\s*)?generated with\b/i,
  /^signed-off-by\s*:/i,
  /^closes\s+#\d+/i,
  /^fixes\s+#\d+/i,
];

const KNOWN_AGENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude\s*code/i, "Claude Code"],
  [/\bclaude\b/i, "Claude Code"],
  [/\bcodex\b/i, "Codex"],
  [/\bcopilot\b/i, "Copilot"],
  [/\bcursor\b/i, "Cursor"],
  [/\bdevin\b/i, "Devin"],
  [/\baider\b/i, "Aider"],
  [/\bgemini\b/i, "Gemini"],
  [/\bjules\b/i, "Jules"],
];

const BOTS: Record<string, string> = {
  "renovate[bot]": "Renovate",
  renovate: "Renovate",
  "dependabot[bot]": "Dependabot",
  dependabot: "Dependabot",
  "github-actions[bot]": "GitHub Actions",
};

/** Markdown to the protocol's plain text: no emphasis, links as their text, `code` kept. */
export function plain(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** A label at the start of a line: `## What`, `**What**`, `**Risk:**`, `What:`, `- **Why:**`. */
function labelOf(line: string): { field: Field; rest: string } | null {
  const heading = /^#{1,6}\s+(.+?)\s*:?\s*#*\s*$/.exec(line);
  if (heading) {
    const field = fieldOf(plain(heading[1]!));
    return field ? { field, rest: "" } : null;
  }
  const s = line.replace(/^[-*+]\s+/, "");
  const bold = /^(?:\*\*|__)([^*_]+?)\s*:?\s*(?:\*\*|__)\s*:?\s*(.*)$/.exec(s);
  if (bold) {
    const field = fieldOf(bold[1]!);
    return field ? { field, rest: bold[2]! } : null;
  }
  const colon = /^([A-Za-z][A-Za-z ]{1,30}?)\s*:\s*(.*)$/.exec(s);
  if (colon) {
    const field = fieldOf(colon[1]!);
    return field ? { field, rest: colon[2]! } : null;
  }
  return null;
}

const isMeta = (line: string) => {
  const s = plain(line.replace(/^[-*+>]\s+/, ""));
  return META.some((re) => re.test(s));
};

/** Parse a PR body. `author` names a bot author (Renovate, Dependabot). */
export function parseBody(
  body: string | null | undefined,
  author: string | null = null,
): ParsedBody {
  const text = (body ?? "").replace(/\r/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split("\n");
  return {
    brief: briefOf(lines),
    epic: epicOf(lines),
    dependsOn: dependsOnOf(lines),
    agent: agentOf(lines, author),
  };
}

function briefOf(lines: readonly string[]): Brief | null {
  const sections = new Map<Field, string[]>();
  let current: Field | null = null;
  /** Under a heading a blank line only separates; after an inline label it ends the field. */
  let heading = false;
  let inCode = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const label = labelOf(line.trim());
    if (label) {
      current = label.field;
      heading = /^#{1,6}\s/.test(line.trim());
      const list = sections.get(current) ?? [];
      if (label.rest.trim()) list.push(label.rest.trim());
      sections.set(current, list);
      continue;
    }
    if (/^#{1,6}\s/.test(line.trim())) {
      current = null; // another heading ends the section
      continue;
    }
    if (isMeta(line.trim())) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const list = sections.get(current)!;
    if (line.trim() === "") {
      if (!heading) {
        if (list.length) current = null;
      } else if (list.length && list[list.length - 1] !== "") list.push("");
      continue;
    }
    list.push(line.trim());
  }

  if (sections.size === 0) {
    // No brief: the first paragraph that is not a trailer is the "what".
    const paragraph: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (/^(```|~~~)/.test(line)) break;
      if (!line || /^#{1,6}\s/.test(line) || isMeta(line)) {
        if (paragraph.length) break;
        continue;
      }
      paragraph.push(line);
    }
    const what = plain(paragraph.join(" "));
    return what ? { what, why: "", risk: "", verified: "", lookAt: [] } : null;
  }

  const textOf = (field: Field) =>
    plain(
      (sections.get(field) ?? [])
        .join("\n")
        .split(/\n{2,}/)
        .map((p) => p.replace(/^[-*+]\s+/gm, "").replace(/\n/g, " "))
        .join(" "),
    );
  const lookAt = (sections.get("lookAt") ?? [])
    .filter((l) => l !== "")
    .map((l) => plain(l.replace(/^(?:[-*+]|\d+[.)])\s+/, "")))
    .filter(Boolean);
  return {
    what: textOf("what"),
    why: textOf("why"),
    risk: textOf("risk"),
    verified: textOf("verified"),
    lookAt,
  };
}

function cleaned(lines: readonly string[]): string[] {
  return lines.map((raw) =>
    plain(raw.replace(/^[\s>*+-]+/, ""))
      .replace(/^_+|_+$/g, "")
      .trim(),
  );
}

function epicOf(lines: readonly string[]): number | null {
  for (const line of cleaned(lines)) {
    const m = /^epic\s*:\s*#(\d+)\b/i.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

function dependsOnOf(lines: readonly string[]): number[] {
  const out = new Set<number>();
  for (const line of cleaned(lines)) {
    const m = /^depends\s+on\s*:?\s*((?:#\d+[\s,]*(?:and\s+)?)+)/i.exec(line);
    if (m) for (const n of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return [...out];
}

function agentOf(lines: readonly string[], author: string | null): string | null {
  if (author && BOTS[author.toLowerCase()]) return BOTS[author.toLowerCase()]!;
  const all = cleaned(lines);
  for (const line of all) {
    const m = /^agent\s*:\s*(.+)$/i.exec(line);
    if (m) return m[1]!.trim().slice(0, 40) || null;
  }
  for (const line of all) {
    const m = /^opened by\s+(.+?)\s+\(agent\)/i.exec(line);
    if (m) return m[1]!.trim().slice(0, 40) || null;
  }
  for (const line of all) {
    if (!/^(?:co-authored-by\s*:|(?:🤖\s*)?generated with\b)/i.test(line)) continue;
    const known = KNOWN_AGENTS.find(([re]) => re.test(line));
    if (known) return known[1];
  }
  return null;
}
