/**
 * `+312 −88` and the quiet 38 px bar (r3): length = size on a log scale to
 * 1,000 lines, split added/removed. `inline` is the panel's numbers-only form.
 */

import { diffBar, diffNumbers } from "@/lib/diff";
import { cn } from "@/lib/utils";

const ADDED = "text-[color-mix(in_srgb,var(--ok)_75%,var(--tx3))]";
const REMOVED = "text-[color-mix(in_srgb,var(--bad)_75%,var(--tx3))]";

export function DiffIndicator({
  added,
  removed,
  inline = false,
  className,
}: {
  added: number;
  removed: number;
  inline?: boolean;
  className?: string;
}) {
  const n = diffNumbers(added, removed);
  const numbers = (
    <span className={cn(!inline && "text-right")}>
      <span className={ADDED}>{n.added}</span> <span className={REMOVED}>{n.removed}</span>
    </span>
  );
  if (inline)
    return (
      <span className={cn("text-tx3 text-xs whitespace-nowrap tabular-nums", className)}>
        {numbers}
      </span>
    );
  const bar = diffBar(added, removed);
  return (
    <span
      className={cn(
        "text-tx3 grid grid-cols-[1fr_38px] items-center gap-2 text-xs whitespace-nowrap tabular-nums",
        className,
      )}
      title={`${added} added, ${removed} removed (lockfiles and generated files left out)`}
    >
      {numbers}
      <i className="bg-line2 flex h-[3px] overflow-hidden rounded-sm" aria-hidden>
        <b className="bg-ok block opacity-80" style={{ width: `${bar.added}%` }} />
        <u className="bg-bad block opacity-80" style={{ width: `${bar.removed}%` }} />
      </i>
    </span>
  );
}
