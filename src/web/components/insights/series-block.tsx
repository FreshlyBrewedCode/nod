/**
 * A `series` block: values over something ordered, as bars (the default)
 * or a line, drawn here as inline SVG in real pixels (the width is measured,
 * so text never stretches). A minimal axis: the baseline, a hairline at a
 * round top and its value; x labels thinned to fit. Pointing at (or tapping)
 * a band shows its value above the chart, where a phone can read it too.
 */

import { useState } from "react";

import type { SeriesBlock as Block } from "../../../shared/protocol";
import { useWidth } from "@/hooks/use-width";
import {
  barPath,
  formatNumber,
  labelIndices,
  seriesLayout,
  toneColor,
  withUnit,
} from "@/lib/insights";
import { cn } from "@/lib/utils";

const HEIGHT = 92;
const GUTTER = 34;
const LABELS = 18;
const TOP_PAD = 6;

/** An x label, cut to `max` characters with an ellipsis. */
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function SeriesBlock({ block }: { block: Block }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const points = block.points;
  if (points.length === 0) return null;
  const line = block.style === "line";
  const color = toneColor(block.tone, line ? "info" : "c1");
  const plot = Math.max(0, width - GUTTER);
  const layout = seriesLayout(points, plot, HEIGHT);
  const maxChars = Math.max(...points.map((p) => p.x.length));
  const chars = Math.min(14, maxChars);
  const labelWidth = chars * 6.6 + 18;
  const shown = new Set(labelIndices(points.length, plot, labelWidth));
  const at = active === null ? null : (layout.points[active] ?? null);
  const peak = layout.points.reduce((m, p) => Math.max(m, p.y), 0);
  const readout = at
    ? `${at.x}: ${withUnit(at.y, block.unit)}`
    : line
      ? `last ${withUnit(layout.points[layout.points.length - 1]!.y, block.unit)}`
      : `most ${withUnit(peak, block.unit)}`;

  const pick = (clientX: number, target: SVGSVGElement) => {
    const x = clientX - target.getBoundingClientRect().left - GUTTER;
    if (x < 0 || layout.band <= 0) return setActive(null);
    setActive(Math.min(points.length - 1, Math.max(0, Math.floor(x / layout.band))));
  };

  return (
    <figure className="m-0">
      <div className="text-tx3 fs-note mb-2 flex items-baseline gap-3 leading-[1.45]">
        <span className="min-w-0 truncate">{block.label}</span>
        <span
          className={cn("ml-auto flex-none font-mono text-[11.5px] tabular-nums", at && "text-tx")}
          aria-live="polite"
        >
          {readout}
        </span>
      </div>
      <div ref={box} className="w-full">
        {width > 0 && (
          <svg
            role="img"
            aria-label={`${block.label ?? "series"}: ${points.map((p) => `${p.x} ${p.y}`).join(", ")}`}
            width={width}
            height={HEIGHT + TOP_PAD + LABELS}
            className="block touch-pan-y select-none"
            onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
            onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
            onPointerLeave={() => setActive(null)}
          >
            <g transform={`translate(0 ${TOP_PAD})`}>
              {/* The axis: a hairline at the round top, its value, the baseline. */}
              <line x1={GUTTER} x2={width} y1={0} y2={0} stroke="var(--line)" strokeWidth={1} />
              <line
                x1={GUTTER}
                x2={width}
                y1={HEIGHT + 0.5}
                y2={HEIGHT + 0.5}
                stroke="var(--line2)"
                strokeWidth={1}
              />
              <text
                x={GUTTER - 6}
                y={4}
                textAnchor="end"
                className="fill-tx3 font-mono text-[10.5px]"
              >
                {formatNumber(layout.top)}
              </text>
              <text
                x={GUTTER - 6}
                y={HEIGHT + 3}
                textAnchor="end"
                className="fill-tx3 font-mono text-[10.5px]"
              >
                0
              </text>
              <g transform={`translate(${GUTTER} 0)`}>
                {at && (
                  <rect
                    x={at.cx - layout.band / 2}
                    y={0}
                    width={layout.band}
                    height={HEIGHT}
                    fill="var(--panel2)"
                    opacity={0.6}
                  />
                )}
                {line ? (
                  <>
                    {layout.line && (
                      <>
                        <path
                          d={`${layout.line} L${layout.points[layout.points.length - 1]!.cx} ${HEIGHT} L${layout.points[0]!.cx} ${HEIGHT} Z`}
                          fill={color}
                          opacity={0.1}
                        />
                        <path
                          d={layout.line}
                          fill="none"
                          stroke={color}
                          strokeWidth={2}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </>
                    )}
                    {layout.points.map((p, i) =>
                      i === active || i === points.length - 1 || points.length <= 24 ? (
                        <circle
                          key={i}
                          cx={p.cx}
                          cy={HEIGHT - p.h}
                          r={i === active ? 4.5 : 3.5}
                          fill={color}
                          stroke="var(--panel)"
                          strokeWidth={2}
                        />
                      ) : null,
                    )}
                  </>
                ) : (
                  layout.points.map((p, i) => (
                    <path
                      key={i}
                      d={barPath(p.cx, layout.barWidth, p.h, HEIGHT)}
                      fill={color}
                      opacity={active === null || active === i ? 1 : 0.55}
                    />
                  ))
                )}
                {layout.points.map((p, i) => {
                  if (!shown.has(i)) return null;
                  // The first and the last label keep inside the chart.
                  const half = (cut(p.x, chars).length * 6.6) / 2;
                  const anchor = p.cx - half < 0 ? "start" : p.cx + half > plot ? "end" : "middle";
                  const x = anchor === "start" ? 0 : anchor === "end" ? plot : p.cx;
                  return (
                    <text
                      key={i}
                      x={x}
                      y={HEIGHT + 14}
                      textAnchor={anchor}
                      className={cn(
                        "font-mono text-[10.5px]",
                        i === active ? "fill-tx" : "fill-tx3",
                      )}
                    >
                      {cut(p.x, chars)}
                    </text>
                  );
                })}
              </g>
            </g>
          </svg>
        )}
      </div>
    </figure>
  );
}
