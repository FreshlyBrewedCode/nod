/**
 * A `breakdown` block: parts of a whole as a stacked bar (the default) or,
 * with `style: "donut"`, a donut drawn here as inline SVG, with a legend of
 * label, value and share. The colours are theme tokens (`lib/insights.ts`);
 * the shapes come from the numbers, never from the payload.
 */

import type { BreakdownBlock as Block } from "../../../shared/protocol";
import { breakdownParts, donutArcs, formatNumber, withUnit, type Part } from "@/lib/insights";
import { cn } from "@/lib/utils";
import { BlockLabel, Swatch } from "./insight-bits";

export function BreakdownBlock({ block }: { block: Block }) {
  const { parts, total } = breakdownParts(block.items);
  if (parts.length === 0) return null;
  const donut = block.style === "donut";
  const label = block.label ?? (block.unit ? `${withUnit(total, block.unit)} in all` : undefined);
  return (
    <figure className="m-0">
      {label && <BlockLabel>{label}</BlockLabel>}
      {donut ? (
        <div className="flex items-center gap-5 phone:gap-4">
          <Donut parts={parts} total={total} unit={block.unit} />
          <Legend parts={parts} unit={block.unit} className="max-w-[300px] min-w-0 flex-1" />
        </div>
      ) : (
        <>
          <StackedBar parts={parts} unit={block.unit} />
          <Legend parts={parts} unit={block.unit} className="mt-2.5 max-w-[440px]" />
        </>
      )}
    </figure>
  );
}

/** The bar: one segment per part, 2 px of surface between them, rounded ends. */
function StackedBar({ parts, unit }: { parts: ReadonlyArray<Part>; unit: string | undefined }) {
  const drawn = parts.filter((p) => p.share > 0);
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a bar of spans, named as one picture
      role="img"
      aria-label={parts.map((p) => `${p.label} ${p.shareText}`).join(", ")}
      className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full"
    >
      {drawn.map((p) => (
        <span
          key={p.label}
          title={`${p.label}: ${withUnit(p.value, unit)} (${p.shareText})`}
          className="block h-full min-w-[3px]"
          style={{ flex: `${p.share} 1 0%`, background: p.color }}
        />
      ))}
    </div>
  );
}

const SIZE = 104;
const STROKE = 13;

/** The donut: arcs on a ring, from 12 o'clock clockwise, the total in its middle. */
function Donut({
  parts,
  total,
  unit,
}: {
  parts: ReadonlyArray<Part>;
  total: number;
  unit: string | undefined;
}) {
  const r = (SIZE - STROKE) / 2;
  return (
    <div className="relative flex-none" style={{ width: SIZE, height: SIZE }}>
      <svg
        role="img"
        aria-label={parts.map((p) => `${p.label} ${p.shareText}`).join(", ")}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="block -rotate-90"
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={STROKE}
        />
        {donutArcs(parts).map((a, i) => (
          <circle
            key={i}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={r}
            fill="none"
            stroke={a.color}
            strokeWidth={STROKE}
            pathLength={100}
            strokeDasharray={a.dash}
            strokeDashoffset={a.offset}
          />
        ))}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center leading-tight">
        <b className="font-mono text-[15px] font-semibold tabular-nums">{formatNumber(total)}</b>
        {unit && <span className="text-tx3 text-[11px]">{unit}</span>}
      </div>
    </div>
  );
}

/** The legend: a swatch, the label, the value, its share, and the note (`+224 −84`). */
function Legend({
  parts,
  unit,
  className,
}: {
  parts: ReadonlyArray<Part>;
  unit: string | undefined;
  className?: string;
}) {
  const notes = parts.some((p) => p.note);
  return (
    <ul
      className={cn(
        "m-0 grid list-none items-baseline gap-x-3 gap-y-1 p-0 text-[13px]",
        notes
          ? "grid-cols-[minmax(0,1fr)_auto_auto_auto] phone:gap-x-2.5"
          : "grid-cols-[minmax(0,1fr)_auto_auto]",
        className,
      )}
    >
      {parts.map((p) => (
        <li key={p.label} className="contents">
          <span className="flex min-w-0 items-center gap-2">
            <Swatch color={p.color} className="translate-y-[1px]" />
            <span className="text-tx2 truncate">{p.label}</span>
          </span>
          <span className="text-tx text-right font-mono text-xs tabular-nums" title={unit}>
            {formatNumber(p.value)}
          </span>
          <span className="text-tx3 w-[4ch] text-right font-mono text-xs tabular-nums">
            {p.shareText}
          </span>
          {notes && (
            <span className="text-tx3 text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums">
              {p.note ?? ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
