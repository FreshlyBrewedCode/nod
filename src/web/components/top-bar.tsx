/**
 * The top bar (r3): the product, the repo, the view switch List / Board,
 * the shortcuts, the signing lock chip with its countdown, and me.
 */

import { Lock, LockOpen } from "lucide-react";
import type * as React from "react";

import type { Person, SignerState } from "../../shared/protocol";
import { SECOND, useNow } from "@/hooks/use-clock";
import { countdown } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Avatar, Kbd } from "./bits";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function Logo() {
  return (
    <div className="flex items-center gap-2 text-sm font-bold">
      <i className="bg-need grid size-[18px] place-items-center rounded-[5px] text-xs font-extrabold text-[#111] not-italic">
        ✓
      </i>
      nod
    </div>
  );
}

export function TopBarShell({ children }: { children: React.ReactNode }) {
  return (
    <header className="border-line bg-bg sticky top-0 z-30 flex h-[52px] flex-none items-center gap-5 border-b px-5">
      {children}
    </header>
  );
}

/** A segmented switch, r3's `.seg`. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="border-line bg-panel2 flex rounded-lg border p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-[3px] text-[13px]",
            o.value === value
              ? "bg-bg text-tx font-semibold shadow-[0_0_0_1px_var(--line2)]"
              : "text-tx2 hover:text-tx",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LockChip({ signer, onLock }: { signer: SignerState | null; onLock: () => void }) {
  const now = useNow(SECOND);
  const base =
    "border-line2 text-tx2 flex h-[30px] items-center gap-2 rounded-lg border px-2.5 text-[13px]";
  if (signer?.state === "unlocked")
    return (
      <div
        className={cn(base, "border-ok bg-ok-bg text-ok")}
        title={signer.once ? "Unlocked for one batch" : "Signing locks on its own when this ends"}
      >
        <LockOpen className="size-3.5" />
        <span>Unlocked</span>
        <b className="font-mono font-medium tabular-nums">{countdown(signer.until, now)}</b>
        <button
          type="button"
          onClick={onLock}
          className="text-tx2 hover:text-tx border-line2 border-l pl-2"
        >
          Lock
        </button>
      </div>
    );
  if (signer?.state === "no-key")
    return (
      <div className={base} title="No signing key yet">
        <Lock className="size-3.5" />
        <span>No key</span>
      </div>
    );
  return (
    <div className={base} title="Signing is locked. You unlock it when you sign.">
      <Lock className="size-3.5" />
      <span>Locked</span>
    </div>
  );
}

const SHORTCUTS: ReadonlyArray<readonly [string[], string]> = [
  [["j", "k"], "next / previous row (or ↓ ↑)"],
  [["↵"], "open details; open or close a cluster"],
  [["esc"], "close details, then clear the selection"],
  [["x"], "select for signing"],
  [["s"], "sign the selection, or the focused row"],
  [["e"], "Got it, on an FYI"],
  [["g", "l"], "list by attention"],
  [["g", "c"], "list, chronological"],
  [["g", "b"], "board"],
  [["?"], "these shortcuts"],
];

export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger className="text-tx3 hover:text-tx2 flex items-center gap-1.5 text-[12.5px]">
        <Kbd>?</Kbd> shortcuts
      </PopoverTrigger>
      <PopoverContent className="w-[330px] px-4 py-3">
        <h6 className="text-tx3 m-0 mb-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
          Shortcuts
        </h6>
        <dl className="m-0 grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={what} className="contents">
              <dt className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd className="text-tx2 m-0">{what}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export function Me({ login, people }: { login: string; people: ReadonlyArray<Person> }) {
  return <Avatar login={login} people={people} large />;
}
