/** The settings page's shared pieces (r3): the section heading, the card, the lines, code. */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const CARD = "border-line bg-panel mb-4 rounded-xl border px-5 pt-4 pb-5 phone:px-4";
export const H2 = "m-0 mb-1.5 text-[15px] font-bold";
export const LINE = "text-tx2 m-0 text-[13.5px] leading-[1.55]";
export const NOTE = "text-tx3 fs-note m-0 leading-[1.55]";
export const QUIET =
  "text-tx3 hover:text-tx2 inline-flex h-8 flex-none items-center justify-center rounded-lg px-2.5 text-[13px] phone:h-11";
/** A button that removes or stops something. */
export const DANGER =
  "border-bad text-bad hover:bg-bad-bg inline-flex h-8 items-center justify-center rounded-lg border px-3.5 text-[13px] font-semibold disabled:opacity-50 phone:h-11";

export function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1 id="settings-title" className="m-0 mb-1.5 text-[22px] font-bold tracking-[-0.01em]">
        {title}
      </h1>
      <p className="text-tx2 m-0 mb-[22px] leading-[1.55]">{children}</p>
    </>
  );
}

export const Code = ({ children }: { children: ReactNode }) => (
  <code className="font-mono fs-code whitespace-nowrap">{children}</code>
);

/** Code that may be long (a path, a command, a host): it breaks anywhere instead of overflowing. */
export const LongCode = ({ children }: { children: ReactNode }) => (
  <code className="font-mono fs-code [overflow-wrap:anywhere]">{children}</code>
);

/** A label and its value, in a card's facts list. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 phone:grid-cols-1 phone:gap-0.5">
      <dt className="text-tx3 fs-note leading-[1.55]">{label}</dt>
      <dd className="text-tx2 m-0 min-w-0 text-[13px] leading-[1.55] [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("m-0 mt-2", className)}>{children}</dl>;
}
