/**
 * Under the top bar (r3): "By attention | Chronological", the repo filter (with more than
 * one repo) and the Details toggle. On a phone the switch is the full width, the filter
 * under it, and a tap on a row opens the details, so no toggle.
 */

import type * as React from "react";

import { cn } from "@/lib/utils";
import { Segmented } from "./top-bar";

function PanelIcon() {
  return (
    <i className="relative block h-[11px] w-3.5 rounded-[2px] border-[1.5px] border-current after:absolute after:inset-y-0 after:right-[3px] after:w-[1.5px] after:bg-current" />
  );
}

export function SubBar({
  view,
  onView,
  panelOpen,
  onTogglePanel,
  filter = null,
}: {
  view: "list" | "chrono";
  onView: (view: "list" | "chrono") => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** The repo filter (`repo-filter.tsx`), when there is more than one repo. */
  filter?: React.ReactNode;
}) {
  return (
    <div className="text-tx3 mx-auto flex max-w-[1000px] items-center gap-3.5 px-6 pt-[22px] text-[13px] phone:flex-wrap phone:gap-y-1.5 phone:px-3 phone:pt-2.5">
      <Segmented
        fill
        label="Order"
        value={view}
        options={[
          { value: "list", label: "By attention", title: "g l" },
          { value: "chrono", label: "Chronological", title: "g c" },
        ]}
        onChange={onView}
      />
      {filter}
      <span className="flex-1 phone:hidden" />
      <button
        type="button"
        aria-pressed={panelOpen}
        title={panelOpen ? "Close details (esc)" : "Open details (↵)"}
        onClick={onTogglePanel}
        className={cn(
          "border-line2 inline-flex h-7 items-center gap-[7px] rounded-lg border px-2.5 phone:hidden",
          panelOpen ? "text-tx bg-panel2" : "text-tx2 hover:text-tx",
        )}
      >
        <PanelIcon />
        Details
      </button>
    </div>
  );
}
