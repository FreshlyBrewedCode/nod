/** r3's selection bar: the count, "Clear", and the way into the batch dialog. */

import { useDashboard } from "@/hooks/use-dashboard";
import { Kbd } from "./bits";

export function SelectionBar() {
  const { selection, clearSelection, openBatch } = useDashboard();
  if (selection.length === 0) return null;
  return (
    <section
      aria-label="Selection"
      className="bg-panel2 border-line2 shadow-float fixed bottom-[22px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border py-2 pr-2 pl-[18px]"
    >
      <b className="font-semibold">{selection.length} selected</b>
      <button
        type="button"
        onClick={clearSelection}
        className="text-tx2 hover:text-tx h-8 rounded-lg px-3.5 text-[13px] font-medium"
      >
        Clear
      </button>
      <button
        type="button"
        onClick={() => openBatch(selection)}
        className="bg-need border-need text-on-need inline-flex h-8 items-center gap-2 rounded-lg border px-3.5 text-[13px] font-semibold"
      >
        Review &amp; sign {selection.length}
        <Kbd className="text-on-need border-[#0003] bg-[#0002]">s</Kbd>
      </button>
    </section>
  );
}
