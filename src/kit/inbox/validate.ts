/**
 * Runtime validators for everything the personal layer sends across a
 * process boundary (ADR 0009 decision 5): each rebuilds the value from
 * `unknown`, keeps only the known fields, drops what does not fit and caps
 * sizes to {@link INSIGHT_LIMITS}. They never throw.
 *
 * Pure: imports nothing from Node.
 */
import {
  INSIGHT_LIMITS,
  TONES,
  type Block,
  type BreakdownItem,
  type FileItem,
  type Insight,
  type PrRef,
  type SeriesPoint,
  type Stat,
  type Tone,
} from "./blocks.ts";
import type { AttentionMark, AttentionValue, InsightState, Origin } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether a character is dropped: C0 controls and DEL except newline and
 * tab, and the bidi overrides and isolates, which could reorder what a row
 * shows.
 */
function dropped(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a && code !== 0x09) ||
    code === 0x7f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

const stripControls = (s: string) => [...s].filter((c) => !dropped(c.codePointAt(0)!)).join("");

/**
 * A string with control characters removed and newlines folded (unless
 * `multiline`), trimmed and cut to `max` characters with `…`. `undefined`
 * when it is not a string or ends up empty.
 */
export function cleanString(v: unknown, max: number, multiline = false): string | undefined {
  if (typeof v !== "string") return undefined;
  let s = stripControls(v.replace(/\r\n?/g, "\n"));
  s = multiline ? s.replace(/\t/g, "  ") : s.replace(/\s+/g, " ");
  s = s.trim();
  if (s === "") return undefined;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const tone = (v: unknown): Tone | undefined =>
  typeof v === "string" && (TONES as readonly string[]).includes(v) ? (v as Tone) : undefined;

/** Sets `key` only when the value is defined, so the result has no `undefined` fields. */
function put<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function list<T>(v: unknown, max: number, item: (x: unknown) => T | undefined): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    if (out.length >= max) break;
    const parsed = item(x);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

const L = INSIGHT_LIMITS;

function prRef(v: unknown): PrRef | undefined {
  if (!isObj(v)) return undefined;
  const number = num(v.number);
  if (number === undefined || !Number.isInteger(number) || number < 1) return undefined;
  const ref: PrRef = { number };
  const repo = cleanString(v.repo, 200);
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) ref.repo = repo;
  return ref;
}

function breakdownItem(v: unknown): BreakdownItem | undefined {
  if (!isObj(v)) return undefined;
  const label = cleanString(v.label, L.label);
  const value = num(v.value);
  if (!label || value === undefined || value < 0) return undefined;
  const item: BreakdownItem = { label, value };
  put(item, "tone", tone(v.tone));
  put(item, "note", cleanString(v.note, L.note));
  return item;
}

function stat(v: unknown): Stat | undefined {
  if (!isObj(v)) return undefined;
  const label = cleanString(v.label, L.label);
  const value = num(v.value) ?? cleanString(v.value, L.label);
  if (!label || value === undefined) return undefined;
  const item: Stat = { label, value };
  put(item, "unit", cleanString(v.unit, 20));
  put(item, "tone", tone(v.tone));
  put(item, "hint", cleanString(v.hint, L.note));
  return item;
}

function point(v: unknown): SeriesPoint | undefined {
  if (!isObj(v)) return undefined;
  const x = cleanString(typeof v.x === "number" ? String(v.x) : v.x, 40);
  const y = num(v.y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function fileItem(v: unknown): FileItem | undefined {
  if (!isObj(v)) return undefined;
  const path = cleanString(v.path, L.path);
  if (!path) return undefined;
  const item: FileItem = { path };
  put(item, "note", cleanString(v.note, L.note));
  put(item, "value", num(v.value));
  put(item, "tone", tone(v.tone));
  put(item, "pr", prRef(v.pr));
  return item;
}

/** One block, or `undefined` when its type is unknown or it is malformed or empty. */
export function parseBlock(v: unknown): Block | undefined {
  if (!isObj(v)) return undefined;
  const label = cleanString(v.label, L.label);
  switch (v.type) {
    case "breakdown": {
      const items = list(v.items, L.breakdownItems, breakdownItem);
      if (items.length === 0) return undefined;
      const block: Block = { type: "breakdown", items };
      put(block, "label", label);
      put(block, "unit", cleanString(v.unit, 20));
      if (v.style === "bar" || v.style === "donut") block.style = v.style;
      return block;
    }
    case "stats": {
      const items = list(v.items, L.stats, stat);
      if (items.length === 0) return undefined;
      const block: Block = { type: "stats", items };
      put(block, "label", label);
      return block;
    }
    case "series": {
      const points = list(v.points, L.seriesPoints, point);
      if (points.length === 0) return undefined;
      const block: Block = { type: "series", points };
      put(block, "label", label);
      put(block, "unit", cleanString(v.unit, 20));
      put(block, "tone", tone(v.tone));
      if (v.style === "bars" || v.style === "line") block.style = v.style;
      return block;
    }
    case "files": {
      const items = list(v.items, L.files, fileItem);
      if (items.length === 0) return undefined;
      const block: Block = { type: "files", items };
      put(block, "label", label);
      return block;
    }
    case "text": {
      const markdown = cleanString(v.markdown, L.text, true);
      return markdown ? { type: "text", markdown } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * An insight from anything an analyzer returned or a subprocess sent:
 * unknown and malformed blocks dropped, sizes capped. `null` when it is not
 * an object with a `blocks` list, or no block survives.
 */
export function parseInsight(v: unknown): Insight | null {
  if (!isObj(v) || !Array.isArray(v.blocks)) return null;
  const blocks = list(v.blocks, L.blocks, parseBlock);
  if (blocks.length === 0) return null;
  const out: Insight = { blocks };
  put(out, "title", cleanString(v.title, L.title));
  put(out, "summary", cleanString(v.summary, L.summary));
  return out;
}

/** Most marks one classifier may give one PR. */
export const MAX_MARKS = 20;

function attentionValue(v: unknown): AttentionValue | undefined {
  return v === 1 || v === -1 || v === "mute" ? v : undefined;
}

/** One mark, or `undefined` when it says nothing (no attention, tag or fyi) or has no detail. */
export function parseMark(v: unknown): AttentionMark | undefined {
  if (!isObj(v)) return undefined;
  const detail = cleanString(v.detail, 200);
  const attention = attentionValue(v.attention);
  const tag = cleanString(v.tag, 40);
  const fyi = v.fyi === true ? true : undefined;
  if (!detail || (attention === undefined && !tag && !fyi)) return undefined;
  const mark: AttentionMark = { detail };
  put(mark, "classifier", cleanString(v.classifier, 40));
  put(mark, "attention", attention);
  put(mark, "tag", tag);
  put(mark, "fyi", fyi);
  return mark;
}

/** A classifier's marks from anything: a list of marks, capped at {@link MAX_MARKS}; anything else is `[]`. */
export function parseAttention(v: unknown): AttentionMark[] {
  return list(v, MAX_MARKS, parseMark);
}

const ORIGINS: readonly Origin[] = ["default", "yours"];

/** An {@link InsightState} from the wire or a subprocess, or `null` when it is malformed. */
export function parseInsightState(v: unknown): InsightState | null {
  if (!isObj(v)) return null;
  const id = cleanString(v.id, 40);
  const title = cleanString(v.title, L.title);
  const origin = ORIGINS.find((o) => o === v.origin);
  const when: "poll" | "open" | undefined =
    v.when === "poll" || v.when === "open" ? v.when : undefined;
  if (!id || !title || !origin || !when) return null;
  const base: { id: string; title: string; origin: Origin; when: "poll" | "open" } = {
    id,
    title,
    origin,
    when,
  };
  const ms = num(v.ms);
  const timing = ms === undefined ? {} : { ms };
  switch (v.status) {
    case "ready": {
      const insight = parseInsight(v.insight);
      return insight
        ? { ...base, status: "ready", insight, ...timing }
        : { ...base, status: "empty", ...timing };
    }
    case "empty":
      return { ...base, status: "empty", ...timing };
    case "running":
      return { ...base, status: "running" };
    case "failed":
      return {
        ...base,
        status: "failed",
        error: cleanString(v.error, 500, true) ?? "failed",
        ...timing,
      };
    default:
      return null;
  }
}
