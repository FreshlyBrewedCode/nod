/**
 * A `stats` block: a few figures side by side, each a value (mono, its unit
 * quieter), a label and an optional hint. A tone is a small mark next to
 * the value, never the value's colour.
 */

import type { StatsBlock as Block } from "../../../shared/protocol";
import { formatNumber, toneColor } from "@/lib/insights";
import { BlockLabel, Swatch } from "./insight-bits";

export function StatsBlock({ block }: { block: Block }) {
  if (block.items.length === 0) return null;
  return (
    <figure className="m-0">
      {block.label && <BlockLabel>{block.label}</BlockLabel>}
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 phone:grid-cols-2">
        {block.items.map((s, i) => (
          <div
            key={`${s.label}:${i}`}
            className="border-line bg-bg min-w-0 rounded-[10px] border px-3 pt-2 pb-2.5"
          >
            <dt className="text-tx3 fs-note flex items-center gap-1.5 truncate">
              {s.tone && s.tone !== "neutral" && (
                <Swatch color={toneColor(s.tone)} className="size-1.5 rounded-full" />
              )}
              <span className="truncate">{s.label}</span>
            </dt>
            <dd className="m-0 mt-0.5">
              <span className="text-tx font-mono text-[19px] leading-[1.25] font-semibold tabular-nums [overflow-wrap:anywhere]">
                {typeof s.value === "number" ? formatNumber(s.value) : s.value}
              </span>
              {s.unit && (
                <span className="text-tx3 ml-0.5 text-[12px]">
                  {s.unit === "%" ? "%" : ` ${s.unit}`}
                </span>
              )}
              {s.hint && (
                <span className="text-tx3 block text-[11.5px] leading-[1.35] phone:text-[12px]">
                  {s.hint}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}
