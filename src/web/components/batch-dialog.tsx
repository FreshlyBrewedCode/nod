/**
 * THE SEAM for the batch dialog (the next task). Every way to sign goes
 * through one function, `openBatch(prNumbers)`: the selection bar's "Review
 * & sign", `s`, the row's ask, the panel's "Sign". For now it opens a
 * placeholder that lists what would be signed; the real dialog (review,
 * unlock in place, signed) replaces `BatchPlaceholder` and keeps the API.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { PrView } from "../../shared/protocol";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export interface Batch {
  /** Open the batch dialog for these PRs (one or many). */
  openBatch(prNumbers: ReadonlyArray<number>): void;
}

const BatchContext = createContext<Batch | null>(null);

export function BatchProvider({
  prs,
  children,
}: {
  prs: ReadonlyArray<PrView>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<ReadonlyArray<number> | null>(null);
  const openBatch = useCallback((prNumbers: ReadonlyArray<number>) => {
    if (prNumbers.length) setOpen([...prNumbers]);
  }, []);
  const value = useMemo(() => ({ openBatch }), [openBatch]);
  return (
    <BatchContext.Provider value={value}>
      {children}
      <BatchPlaceholder numbers={open} prs={prs} onClose={() => setOpen(null)} />
    </BatchContext.Provider>
  );
}

export function useBatch(): Batch {
  const batch = useContext(BatchContext);
  if (!batch) throw new Error("useBatch needs a BatchProvider above it");
  return batch;
}

function BatchPlaceholder({
  numbers,
  prs,
  onClose,
}: {
  numbers: ReadonlyArray<number> | null;
  prs: ReadonlyArray<PrView>;
  onClose: () => void;
}) {
  const rows = (numbers ?? []).map((n) => prs.find((p) => p.number === n)).filter(Boolean);
  const count = numbers?.length ?? 0;
  return (
    <Dialog open={numbers !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby="batch-placeholder-note">
        <div className="px-[30px] pt-[26px] pb-1.5">
          <DialogTitle>
            Sign {count} pull request{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription id="batch-placeholder-note">
            The batch dialog (review, unlock and sign in one place) comes next. Nothing is signed
            here.
          </DialogDescription>
        </div>
        <div className="overflow-auto px-[30px] pt-2.5 pb-2">
          {rows.map((p) => (
            <div
              key={p!.number}
              className="border-line grid grid-cols-[1fr_auto] items-center gap-3 border-t py-2.5"
            >
              <span className="truncate">{p!.title}</span>
              <span className="text-tx3 font-mono text-xs">#{p!.number}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2.5 px-[30px] pt-[18px] pb-6">
          <DialogClose className="border-line2 bg-panel2 text-tx h-8 rounded-lg border px-3.5 text-[13px] font-semibold">
            Close
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
