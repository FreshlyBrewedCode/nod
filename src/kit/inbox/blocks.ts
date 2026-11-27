/**
 * Insights and their blocks (ADR 0009 decision 5): what an analyzer returns,
 * as plain JSON. Never HTML or SVG; colours are semantic slots the web app
 * maps to its theme tokens.
 *
 * Pure: imports nothing from Node, so the web app can import it by path.
 */

/**
 * A colour, by meaning, never as CSS. `neutral`, `muted`, `info`, `good`,
 * `warn` and `bad` say something; `c1`…`c6` are series slots for parts that
 * only need to be told apart. The web app maps each to a theme token.
 */
export type Tone =
  | "neutral"
  | "muted"
  | "info"
  | "good"
  | "warn"
  | "bad"
  | "c1"
  | "c2"
  | "c3"
  | "c4"
  | "c5"
  | "c6";

/** Every {@link Tone}, in order. */
export const TONES: readonly Tone[] = [
  "neutral",
  "muted",
  "info",
  "good",
  "warn",
  "bad",
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
];

/** A pull request a block can point at; `repo` (`owner/name`) defaults to the PR's own. */
export interface PrRef {
  repo?: string;
  number: number;
}

/** One part of a {@link BreakdownBlock}. */
export interface BreakdownItem {
  label: string;
  /** Not negative. Parts are drawn in proportion to their share of the sum. */
  value: number;
  tone?: Tone;
  /** Shown next to the value, e.g. `+120 −30`. */
  note?: string;
}

/** Parts of a whole: a stacked bar (the default) or a donut. */
export interface BreakdownBlock {
  type: "breakdown";
  label?: string;
  /** What the values count, e.g. `lines`. */
  unit?: string;
  style?: "bar" | "donut";
  items: BreakdownItem[];
}

/** One number of a {@link StatsBlock}. */
export interface Stat {
  label: string;
  value: number | string;
  unit?: string;
  tone?: Tone;
  /** A short explanation, shown quietly. */
  hint?: string;
}

/** A few numbers side by side. */
export interface StatsBlock {
  type: "stats";
  label?: string;
  items: Stat[];
}

/** One point of a {@link SeriesBlock}. */
export interface SeriesPoint {
  /** The x label, e.g. a week. */
  x: string;
  y: number;
}

/** Values over something ordered (usually time): bars (the default) or a line. */
export interface SeriesBlock {
  type: "series";
  label?: string;
  unit?: string;
  style?: "bars" | "line";
  tone?: Tone;
  points: SeriesPoint[];
}

/** One file of a {@link FilesBlock}. */
export interface FileItem {
  path: string;
  note?: string;
  /** A number to show and sort by, e.g. how often it changed. */
  value?: number;
  tone?: Tone;
  /** A pull request this file relates to, e.g. my PR that touches it too. */
  pr?: PrRef;
}

/** A list of files, each with an optional note, value and PR. */
export interface FilesBlock {
  type: "files";
  label?: string;
  items: FileItem[];
}

/** Limited markdown (see {@link parseMarkdown}); HTML is shown as text. */
export interface TextBlock {
  type: "text";
  markdown: string;
}

/** Every block an insight can hold. */
export type Block = BreakdownBlock | StatsBlock | SeriesBlock | FilesBlock | TextBlock;

/** The block types, for validators and renderers. */
export const BLOCK_TYPES: readonly Block["type"][] = [
  "breakdown",
  "stats",
  "series",
  "files",
  "text",
];

/** What an analyzer shows: blocks under a title. */
export interface Insight {
  /** Defaults to the analyzer's title. */
  title?: string;
  /** One line for a folded insight, e.g. `72% code, 20% tests`. */
  summary?: string;
  blocks: Block[];
}

/**
 * Size caps every insight is cut to by {@link parseInsight}, so a buggy
 * analyzer cannot flood the panel or the wire.
 */
export const INSIGHT_LIMITS = Object.freeze({
  blocks: 8,
  breakdownItems: 12,
  stats: 8,
  seriesPoints: 120,
  files: 50,
  /** Characters of a `text` block. */
  text: 4000,
  /** Characters of a title, label, path or note. */
  title: 80,
  label: 80,
  note: 120,
  path: 300,
  summary: 160,
});

/** An insight from blocks: `insight(stats([...]), files([...]))`. */
export function insight(...blocks: Block[]): Insight {
  return { blocks };
}

/** A breakdown block: `breakdown([{ label: "code", value: 120 }], { unit: "lines" })`. */
export function breakdown(
  items: BreakdownItem[],
  options: Omit<BreakdownBlock, "type" | "items"> = {},
): BreakdownBlock {
  return { type: "breakdown", ...options, items };
}

/** A stats block: `stats([{ label: "files", value: 7 }])`. */
export function stats(items: Stat[], options: Omit<StatsBlock, "type" | "items"> = {}): StatsBlock {
  return { type: "stats", ...options, items };
}

/** A series block from points, or from plain numbers (x is then `1`, `2`, …). */
export function series(
  points: readonly SeriesPoint[] | readonly number[],
  options: Omit<SeriesBlock, "type" | "points"> = {},
): SeriesBlock {
  const list = points.map((p, i) => (typeof p === "number" ? { x: String(i + 1), y: p } : p));
  return { type: "series", ...options, points: list };
}

/** A files block from items, or from plain paths. */
export function files(
  items: readonly (FileItem | string)[],
  options: Omit<FilesBlock, "type" | "items"> = {},
): FilesBlock {
  return {
    type: "files",
    ...options,
    items: items.map((f) => (typeof f === "string" ? { path: f } : f)),
  };
}

/** A text block in limited markdown. */
export function text(markdown: string): TextBlock {
  return { type: "text", markdown };
}
