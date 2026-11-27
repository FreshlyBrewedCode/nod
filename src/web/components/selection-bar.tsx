/**
 * r3's selection bar: the count, "Clear", and the way into the batch dialog.
 * On a phone it is a bar along the bottom edge, above the home indicator
 * (docs/design/m1 `a-select`); the list gets bottom padding so the last row
 * is not covered.
 */

import { idOf } from "../../shared/repo-key";
import { useDashboard } from "@/hooks/use-dashboard";
import { actWord } from "@/lib/wording";
import { Kbd } from "./bits";

export function SelectionBar() {
  const { selection, clearSelection, openBatch, snapshot } = useDashboard();
  if (selection.length === 0) return null;
  // Without an active key the selected rows ask for GitHub approvals (ADR 0006).
  const verb = actWord(snapshot.prs.filter((p) => selection.includes(idOf(p))));
  return (
    <section
      aria-label="Selection"
      className="bg-panel2 border-line2 shadow-float fixed bottom-[22px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border py-2 pr-2 pl-[18px] phone:inset-x-0 phone:bottom-0 phone:left-0 phone:translate-x-0 phone:gap-2 phone:rounded-none phone:border-x-0 phone:border-b-0 phone:bg-[#11141af2] phone:px-3 phone:pt-2.5 phone:pb-[calc(0.625rem+env(safe-area-inset-bottom))] phone:shadow-none phone:backdrop-blur-md"
    >
      <b className="font-semibold phone:pl-1">{selection.length} selected</b>
      <button
        type="button"
        onClick={clearSelection}
        className="text-tx2 hover:text-tx h-8 rounded-lg px-3.5 text-[13px] font-medium phone:h-11 phone:text-[15px]"
      >
        Clear
      </button>
      <span className="hidden phone:block phone:flex-1" />
      <button
        type="button"
        onClick={() => openBatch(selection)}
        className="bg-need border-need text-on-need inline-flex h-8 items-center gap-2 rounded-lg border px-3.5 text-[13px] font-semibold phone:h-[46px] phone:rounded-[11px] phone:px-4 phone:text-[15px]"
      >
        Review &amp; {verb} {selection.length}
        <Kbd className="text-on-need border-[#0003] bg-[#0002] phone:hidden">s</Kbd>
      </button>
    </section>
  );
}
