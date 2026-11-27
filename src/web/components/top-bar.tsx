/**
 * The top bar (r3): the product, the repo, the view switch List / Board,
 * the shortcuts, the signing lock chip with its countdown, and me. On a
 * phone it is the logo, the repo, the lock chip and the avatar menu (docs/design/m1).
 */

import { useState } from "react";
import type * as React from "react";

import type { Person } from "../../shared/protocol";
import type { Rung } from "@/lib/onboarding";
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

export function TopBarShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "border-line bg-bg sticky top-0 z-30 flex h-[52px] flex-none items-center gap-5 border-b px-5 phone:gap-2",
        className,
      )}
    >
      {children}
    </header>
  );
}

/** A segmented switch, r3's `.seg`. `fill`: the full width, taller segments, on a phone. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  fill = false,
  className,
}: {
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string; title?: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  label: string;
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "border-line bg-panel2 flex rounded-lg border p-0.5",
        fill && "phone:w-full phone:rounded-xl phone:p-[3px]",
        className,
      )}
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
            fill && "phone:min-h-[38px] phone:flex-1 phone:rounded-[9px] phone:text-sm",
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
      <PopoverTrigger className="text-tx3 hover:text-tx2 flex items-center gap-1.5 text-[12.5px] phone:hidden">
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

/** A step of the ladder offered in the avatar menu (`offersOf`, `offerWords`). */
export interface MenuOffer {
  readonly rung: Rung;
  readonly title: string;
  readonly line: string;
  /** The repo it is about, by key: named only when there are several (ADR 0007, 11). */
  readonly repo?: string;
}

/**
 * Me, and the avatar menu: who `nod serve` is signed in as, the steps of the
 * ladder offered to me (each opens the setup page on it, dismissed or not),
 * and "Settings" (`#/settings`: the repositories, and from each its ladder). On a phone
 * the menu also holds what the top bar has no room for: "How this list works"
 * (the legend, where a desktop has the `?` key) and the fake-data note. On
 * the named host's page it offers "Open links from GitHub here", the way to
 * the hosted UI's confirmation (ADR 0005 §7).
 */
export function Me({
  login,
  people,
  offers = [],
  onSetup,
  onSettings,
  onLegend,
  fake = false,
  linksHere = null,
}: {
  login: string;
  people: ReadonlyArray<Person>;
  /** The ladder's steps offered to me, in order. */
  offers?: ReadonlyArray<MenuOffer>;
  /** Opens the setup page on an offer's step (of a repo). */
  onSetup: (rung?: Rung, repo?: string) => void;
  /** Opens the settings page. */
  onSettings: () => void;
  /** Shows the legend again (phone only). */
  onLegend?: () => void;
  /** `nod serve --fake`: said in the menu on a phone, where the top bar has no room. */
  fake?: boolean;
  /** The hosted UI's `#/forward?to=<this origin>` (`forwardSetupUrl`); null hides the item. */
  linksHere?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const name = people.find((p) => p.login.toLowerCase() === login.toLowerCase())?.name;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="rounded-full phone:grid phone:size-11 phone:place-items-center"
        aria-label={`${login}: menu`}
      >
        <Avatar login={login} people={people} large />
      </PopoverTrigger>
      <PopoverContent className="w-[264px] p-1.5 phone:w-[min(300px,calc(100vw-16px))]">
        <div className="px-2.5 pt-1.5 pb-2 text-[13px]">
          <b className="block font-semibold">{name ?? login}</b>
          <span className="text-tx3 text-[12.5px]">
            {name ? `${login} · ` : ""}through <code className="font-mono text-[11.5px]">gh</code>
          </span>
        </div>
        {offers.length > 0 && (
          <div className="border-line mb-1 border-y py-1">
            <p className="text-tx3 m-0 px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-[0.08em] uppercase">
              Next steps
            </p>
            {offers.map((o) => (
              <button
                key={`${o.repo ?? ""}:${o.rung}`}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSetup(o.rung, o.repo);
                }}
                className="text-tx2 hover:text-tx hover:bg-bg w-full rounded-lg px-2.5 py-2 text-left text-[13px] phone:min-h-11"
              >
                {o.title}
                <span className="text-tx3 fs-code block [overflow-wrap:anywhere]">
                  {o.repo ? `${o.repo} · ${o.line}` : o.line}
                </span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onSettings();
          }}
          className="text-tx2 hover:text-tx hover:bg-bg w-full rounded-lg px-2.5 py-2 text-left text-[13px] phone:min-h-11"
        >
          Settings
          <span className="text-tx3 fs-code block">repositories, and each one’s ladder</span>
        </button>
        {onLegend && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onLegend();
            }}
            className="text-tx2 hover:text-tx hover:bg-bg hidden min-h-11 w-full rounded-lg px-2.5 py-2 text-left text-[13px] phone:block"
          >
            How this list works
            <span className="text-tx3 fs-code block">sizes, lanes, risk, the numbers</span>
          </button>
        )}
        {linksHere && (
          <a
            href={linksHere}
            referrerPolicy="no-referrer"
            className="text-tx2 hover:text-tx hover:bg-bg block w-full rounded-lg px-2.5 py-2 text-left text-[13px] phone:min-h-11"
          >
            Open links from GitHub here
            <span className="text-tx3 fs-code block">
              so links in comments and notifications open here
            </span>
          </a>
        )}
        {fake && (
          <p className="text-tx3 fs-note m-0 hidden px-2.5 pt-1.5 pb-1 phone:block">
            Fake data: <code className="font-mono fs-code">nod serve --fake</code>
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
