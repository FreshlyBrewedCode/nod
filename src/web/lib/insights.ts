/**
 * Insights in the panel (ADR 0009 decision 5), the pure part: which ones
 * show, what the section says about them, the tones as theme tokens, the
 * numbers, the breakdown's shares, the donut's arcs, a series' geometry, and
 * where a file of a `files` block links to. `components/insights/` draws
 * them; nothing here touches the DOM, and nothing from the payload ever
 * becomes a colour, a URL or markup without passing through here.
 *
 * The blocks arrive validated (`parseInsight` on the server), but this side
 * does not lean on that: an unknown tone is `neutral`, a non-finite number
 * is left out, a PR reference that is not `owner/name` links nowhere.
 */

import type {
  BreakdownItem,
  FileItem,
  InsightState,
  SeriesPoint,
  Tone,
} from "../../shared/protocol";

// ---------------------------------------------------------------------------
// which insights show

/** The insights the panel shows, in the inbox's order: an `empty` one has nothing to say. */
export function shownInsights(
  insights: ReadonlyArray<InsightState> | null | undefined,
): ReadonlyArray<InsightState> {
  return (insights ?? []).filter((i) => i.status !== "empty");
}

/**
 * Whether an insight fits half a wide panel (two side by side, from 600 px):
 * a few figures, a donut, a line, a short text, or one that is running or
 * failed. A bar with its legend, a file list or bars take the whole width.
 */
export function isCompact(state: InsightState): boolean {
  if (state.status !== "ready") return true;
  const blocks = state.insight.blocks;
  if (blocks.length === 0 || blocks.length > 2) return false;
  return blocks.every((b) => {
    switch (b.type) {
      case "stats":
        return b.items.length <= 4;
      case "breakdown":
        return b.style === "donut" && b.items.length <= 6;
      case "series":
        return b.style === "line" && b.points.length <= 16;
      case "text":
        return b.markdown.length <= 280;
      default:
        return false;
    }
  });
}

/** The section's quiet line next to its heading: "6 · 1 running · 1 failed". */
export function insightsSummary(insights: ReadonlyArray<InsightState>): string {
  const shown = shownInsights(insights);
  const running = shown.filter((i) => i.status === "running").length;
  const failed = shown.filter((i) => i.status === "failed").length;
  return [
    String(shown.length),
    running ? `${running} running` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What the section says when it shows no insight: null when it has some to
 * show, or when it should not be there at all (no inbox, or a PR that is
 * merged or closed and has none: the runner looks at open PRs only).
 */
export function insightsEmptyLine(
  insights: ReadonlyArray<InsightState> | null | undefined,
  open: boolean,
): string | null {
  if (shownInsights(insights).length > 0) return null;
  if ((insights ?? []).length > 0) return "Your inbox’s analyzers have nothing to say about it.";
  return open ? "Your inbox has not looked at it yet." : null;
}

// ---------------------------------------------------------------------------
// tones

/** Every tone, as the theme token it is drawn with (`styles.css`, `--insight-*`). */
export const TONE_TOKENS: Readonly<Record<Tone, string>> = {
  neutral: "var(--insight-neutral)",
  muted: "var(--insight-muted)",
  info: "var(--insight-info)",
  good: "var(--insight-good)",
  warn: "var(--insight-warn)",
  bad: "var(--insight-bad)",
  c1: "var(--insight-c1)",
  c2: "var(--insight-c2)",
  c3: "var(--insight-c3)",
  c4: "var(--insight-c4)",
  c5: "var(--insight-c5)",
  c6: "var(--insight-c6)",
};

const SLOTS = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;

/**
 * The colour of a tone: always one of the theme's tokens, never what the
 * payload says. No tone (or one this build does not know): `fallback`.
 */
export function toneColor(tone: string | undefined, fallback: Tone = "neutral"): string {
  return tone !== undefined && Object.hasOwn(TONE_TOKENS, tone)
    ? TONE_TOKENS[tone as Tone]
    : TONE_TOKENS[fallback];
}

/**
 * The tone a part is drawn in: its own, else the series slot of its place
 * (`c1` for the first, in the fixed order), so parts without a tone are
 * still told apart. Past six they start over; the legend names every part.
 */
export function partTone(tone: string | undefined, index: number): string {
  if (tone !== undefined && Object.hasOwn(TONE_TOKENS, tone)) return TONE_TOKENS[tone as Tone];
  return TONE_TOKENS[SLOTS[index % SLOTS.length]!];
}

// ---------------------------------------------------------------------------
// numbers

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * A number as the panel shows it: grouped in full below 10,000 (`1,234`),
 * compact from there (`12k`, `3.4M`); at most one decimal.
 */
export function formatNumber(n: number): string {
  if (!finite(n)) return "–";
  const abs = Math.abs(n);
  const one = (x: number) => (Math.round(x * 10) / 10).toLocaleString("en-US");
  if (abs >= 1e6) return `${one(n / 1e6)}M`;
  if (abs >= 1e4) return `${one(n / 1e3)}k`;
  return one(n);
}

/** A value with its unit: `404 lines`, `5%`, `8 s` (a `%` sticks to the number). */
export function withUnit(value: number | string, unit: string | undefined): string {
  const text = typeof value === "number" ? formatNumber(value) : value;
  if (!unit) return text;
  return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

// ---------------------------------------------------------------------------
// breakdown

/** A breakdown part, ready to draw: its share of the whole in percent, as a number and in words. */
export interface Part {
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly note: string | undefined;
  /** 0–100, exact: the bar's and the donut's proportions. */
  readonly share: number;
  /** "72%", "<1%"; the shown shares of the parts add up to 100%. */
  readonly shareText: string;
}

/**
 * The parts of a breakdown with their shares. Negative and non-finite
 * values are left out. The shown percentages are rounded so they add up to
 * 100 (largest remainder); a part above zero that rounds to 0 says `<1%`.
 */
export function breakdownParts(items: ReadonlyArray<BreakdownItem>): {
  parts: ReadonlyArray<Part>;
  total: number;
} {
  const kept = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => finite(item.value) && item.value >= 0);
  const total = kept.reduce((s, { item }) => s + item.value, 0);
  const exact = kept.map(({ item }) => (total > 0 ? (item.value / total) * 100 : 0));
  const floors = exact.map(Math.floor);
  let left = total > 0 ? 100 - floors.reduce((s, f) => s + f, 0) : 0;
  const order = exact
    .map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  const rounded = [...floors];
  for (const { i } of order) {
    if (left <= 0) break;
    rounded[i]! += 1;
    left -= 1;
  }
  const parts = kept.map(({ item, index }, i) => ({
    label: item.label,
    value: item.value,
    color: partTone(item.tone, index),
    note: item.note,
    share: exact[i]!,
    shareText: item.value > 0 && rounded[i] === 0 ? "<1%" : `${rounded[i]}%`,
  }));
  return { parts, total };
}

/** One arc of the donut, on a circle whose length is 100 (`pathLength`): its dash and where it starts. */
export interface Arc {
  readonly color: string;
  /** `stroke-dasharray`: the arc, then the rest of the circle. */
  readonly dash: string;
  /** `stroke-dashoffset`, so the arcs follow each other clockwise from the top. */
  readonly offset: number;
}

/**
 * The donut's arcs: one per part above zero, in order, with `gap` (in
 * hundredths of the circle) of surface between neighbours. A part too small
 * for its gap is still a sliver, never nothing.
 */
export function donutArcs(parts: ReadonlyArray<Part>, gap = 1.2): ReadonlyArray<Arc> {
  const drawn = parts.filter((p) => p.share > 0);
  const g = drawn.length > 1 ? gap : 0;
  let at = 0;
  return drawn.map((p) => {
    const length = Math.max(0.4, p.share - g);
    // Starts at 12 o'clock: the circle is rotated by -90° where it is drawn.
    const arc = {
      color: p.color,
      dash: `${round2(length)} ${round2(100 - length)}`,
      offset: round2(-at),
    };
    at += p.share;
    return arc;
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// series

/** A round top for the axis: 1, 2 or 5 times a power of ten, at least `max`. */
export function niceMax(max: number): number {
  if (!finite(max) || max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * Which x labels to show: every `stride`-th, the first and the last always,
 * so labels about `labelWidth` px wide do not touch on a chart `width` px wide.
 */
export function labelIndices(
  count: number,
  width: number,
  labelWidth: number,
): ReadonlyArray<number> {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const room = Math.max(1, Math.floor(width / Math.max(1, labelWidth)));
  const stride = Math.max(1, Math.ceil(count / room));
  const picked: number[] = [];
  for (let i = 0; i < count; i += stride) picked.push(i);
  const last = count - 1;
  // The last label replaces a neighbour that would touch it.
  if (picked[picked.length - 1] !== last) {
    if (last - picked[picked.length - 1]! < stride && picked.length > 1) picked.pop();
    picked.push(last);
  }
  return picked;
}

/** A series laid out in a `width` × `height` px plot area (the axis labels are outside it). */
export interface SeriesLayout {
  /** The axis' top value (a round number); the baseline is 0. */
  readonly top: number;
  readonly points: ReadonlyArray<{
    readonly x: string;
    readonly y: number;
    /** The centre of its band. */
    readonly cx: number;
    /** The value's height above the baseline, px. */
    readonly h: number;
  }>;
  /** Each band's width, px; a bar is narrower (`barWidth`). */
  readonly band: number;
  readonly barWidth: number;
  /** The line through the points (`style: "line"`), an SVG path; empty with fewer than two. */
  readonly line: string;
}

/**
 * Bars or a line over the points, in px: bands of equal width, bars at
 * most 24 px and 2 px apart at least, values from a 0 baseline to a round
 * top. Points with a non-finite or negative `y` are drawn at 0.
 */
export function seriesLayout(
  points: ReadonlyArray<SeriesPoint>,
  width: number,
  height: number,
): SeriesLayout {
  const ys = points.map((p) => (finite(p.y) && p.y > 0 ? p.y : 0));
  const top = niceMax(Math.max(0, ...ys));
  const n = Math.max(1, points.length);
  const band = width / n;
  const barWidth = Math.max(1, Math.min(24, band - 2, band * 0.7));
  const laid = points.map((p, i) => ({
    x: p.x,
    y: ys[i]!,
    cx: round2(band * i + band / 2),
    h: round2((ys[i]! / top) * height),
  }));
  const line =
    laid.length > 1
      ? laid.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx} ${round2(height - p.h)}`).join(" ")
      : "";
  return { top, points: laid, band, barWidth, line };
}

/** A bar's path: square at the baseline, 4 px rounded at its end (or less, for a short one). */
export function barPath(cx: number, w: number, h: number, height: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  const x0 = round2(cx - w / 2);
  const x1 = round2(cx + w / 2);
  const y = round2(height - h);
  return `M${x0} ${height}V${round2(y + r)}Q${x0} ${y} ${round2(x0 + r)} ${y}H${round2(x1 - r)}Q${x1} ${y} ${x1} ${round2(y + r)}V${height}Z`;
}

// ---------------------------------------------------------------------------
// files

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Where a file of a `files` block links to, built here, never taken from the
 * payload: the PR the item names (`pr`, on the same host as this PR; its
 * `repo` defaults to this PR's), else this file in this PR's diff on GitHub
 * (`/files#diff-<sha256 of the path>`, GitHub's anchor). null when the item
 * names a repo that is not `owner/name`, or the PR's URL does not parse.
 */
export function fileHref(
  item: Pick<FileItem, "path" | "pr">,
  pr: { readonly url: string; readonly repo: string },
): string | null {
  let origin: string;
  try {
    const url = new URL(pr.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    origin = url.origin;
  } catch {
    return null;
  }
  if (item.pr) {
    const repo = item.pr.repo ?? ownerName(pr.repo);
    if (!repo || !REPO.test(repo) || !Number.isInteger(item.pr.number) || item.pr.number <= 0)
      return null;
    return `${origin}/${repo}/pull/${item.pr.number}`;
  }
  return `${pr.url.replace(/\/+$/, "")}/files#diff-${sha256Hex(item.path)}`;
}

/** A PR reference's words: `#490`, or `owner/name#490` for another repo. */
export function prRefText(ref: NonNullable<FileItem["pr"]>, repo: string): string {
  const own = ownerName(repo);
  return ref.repo && ref.repo !== own ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}

/** `owner/name` of a repo key (`host/owner/name` off github.com). */
function ownerName(repo: string): string {
  return repo.split("/").slice(-2).join("/");
}

/** Path and file name, for a list that shows the name in full and the folder quietly. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

// SHA-256 (FIPS 180-4) of a string's UTF-8 bytes, as hex: GitHub's diff anchors.
// Synchronous and small, so a link is a plain href (`crypto.subtle` is async).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The SHA-256 of `text` (UTF-8), lowercase hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bits = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = h[0]! + a!;
    h[1] = h[1]! + b!;
    h[2] = h[2]! + c!;
    h[3] = h[3]! + d!;
    h[4] = h[4]! + e!;
    h[5] = h[5]! + f!;
    h[6] = h[6]! + g!;
    h[7] = h[7]! + hh!;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** The largest value of a files block's items, for their small bars; 0 when none has one. */
export function filesMax(items: ReadonlyArray<Pick<FileItem, "value">>): number {
  return Math.max(0, ...items.map((i) => (finite(i.value) ? i.value : 0)));
}
