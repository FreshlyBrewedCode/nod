/** Under the top bar (r3): "By attention | Chronological" and the Details toggle. */

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
}: {
  view: "list" | "chrono";
  onView: (view: "list" | "chrono") => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  return (
    <div className="text-tx3 mx-auto flex max-w-[1000px] items-center gap-3.5 px-6 pt-[22px] text-[13px]">
      <Segmented
        label="Order"
        value={view}
        options={[
          { value: "list", label: "By attention", title: "g l" },
          { value: "chrono", label: "Chronological", title: "g c" },
        ]}
        onChange={onView}
      />
      <span className="flex-1" />
      <button
        type="button"
        aria-pressed={panelOpen}
        title={panelOpen ? "Close details (esc)" : "Open details (↵)"}
        onClick={onTogglePanel}
        className={cn(
          "border-line2 inline-flex h-7 items-center gap-[7px] rounded-lg border px-2.5",
          panelOpen ? "text-tx bg-panel2" : "text-tx2 hover:text-tx",
        )}
      >
        <PanelIcon />
        Details
      </button>
    </div>
  );
}
