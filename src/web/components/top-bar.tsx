/**
 * The top bar (r3): the product, the repo, the view switch List / Board,
 * the shortcuts, the signing lock chip with its countdown, and me.
 */

import { useState } from "react";
import type * as React from "react";

import type { Person } from "../../shared/protocol";
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
  options: ReadonlyArray<{ value: T; label: string; title?: string; disabled?: boolean }>;
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
          aria-disabled={o.disabled || undefined}
          title={o.title}
          onClick={() => !o.disabled && onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-[3px] text-[13px]",
            o.value === value
              ? "bg-bg text-tx font-semibold shadow-[0_0_0_1px_var(--line2)]"
              : o.disabled
                ? "text-tx2 cursor-default"
                : "text-tx2 hover:text-tx",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SHORTCUTS: ReadonlyArray<readonly [string[], string]> = [
  [["j", "k"], "next / previous row or card (or ↓ ↑)"],
  [["h", "l"], "board: previous / next column (or ← →)"],
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

/**
 * Me, and the avatar menu: who `nod serve` is signed in as, and "Setup and
 * checks" to reopen onboarding (r3 shows no other place for it).
 */
export function Me({
  login,
  people,
  onSetup,
}: {
  login: string;
  people: ReadonlyArray<Person>;
  onSetup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const name = people.find((p) => p.login.toLowerCase() === login.toLowerCase())?.name;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="rounded-full" aria-label={`${login}: menu`}>
        <Avatar login={login} people={people} large />
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-1.5">
        <div className="px-2.5 pt-1.5 pb-2 text-[13px]">
          <b className="block font-semibold">{name ?? login}</b>
          <span className="text-tx3 text-[12.5px]">
            {name ? `${login} · ` : ""}through <code className="font-mono text-[11.5px]">gh</code>
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onSetup();
          }}
          className="text-tx2 hover:text-tx hover:bg-bg w-full rounded-lg px-2.5 py-2 text-left text-[13px]"
        >
          Setup and checks
          <span className="text-tx3 block text-[12px]">
            repository, signing key, test signature
          </span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
