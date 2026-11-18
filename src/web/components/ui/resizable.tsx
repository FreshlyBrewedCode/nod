import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

/** shadcn Resizable, on react-resizable-panels v4 (Group / Panel / Separator). */
function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  );
}

function ResizablePanel(props: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

/**
 * r3's handle: 12 px wide, hairlines on both sides, a visible 4×44 px grip;
 * amber while it is dragged or focused (arrow keys resize it too).
 */
function ResizableHandle({ className, children, ...props }: ResizablePrimitive.SeparatorProps) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "group bg-bg border-line data-[separator=active]:bg-need-bg data-[separator=active]:border-need/40 data-[separator=focus]:bg-need-bg data-[separator=focus]:border-need/40 relative z-20 flex w-3 flex-none cursor-col-resize items-center justify-center border-x outline-none",
        className,
      )}
      {...props}
    >
      <i className="bg-line2 group-data-[separator=hover]:bg-tx3 group-data-[separator=active]:bg-need group-data-[separator=focus]:bg-need block h-11 w-1 rounded-sm" />
      {children}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
