/** The small pieces the insight blocks share: a block's label and a colour swatch. */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A block's own label ("changed most in the last 30 days"), quiet, above it. */
export function BlockLabel({ children }: { children: ReactNode }) {
  return <p className="text-tx3 fs-note m-0 mb-2 leading-[1.45]">{children}</p>;
}

/** A part's colour, beside its label: the mark carries the colour, the text never does. */
export function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <i
      aria-hidden
      className={cn("inline-block size-2 flex-none rounded-[2px]", className)}
      style={{ background: color }}
    />
  );
}
