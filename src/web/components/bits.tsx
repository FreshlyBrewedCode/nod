/**
 * The small r3 marks used everywhere: keys, avatars, the risk bars, tags.
 */

import type * as React from "react";

import type { Person, Risk } from "../../shared/protocol";
import { shortName } from "../../shared/attention";
import { cn } from "@/lib/utils";
import type { TagText } from "@/lib/wording";

/** A key cap, as in r3's buttons and hints. */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "border-line2 bg-panel2 text-tx2 inline-block h-[18px] min-w-[18px] rounded-[4px] border border-b-2 px-[5px] text-center font-mono text-[10.5px] leading-[15px] font-normal",
        className,
      )}
      {...props}
    />
  );
}

/** Hues for the team, in the order the snapshot lists people. */
const HUES = [28, 205, 285, 150, 340, 95, 180, 55];

export function hueOf(login: string, people: ReadonlyArray<Person>): number {
  const i = people.findIndex((p) => p.login.toLowerCase() === login.toLowerCase());
  if (i >= 0) return HUES[i % HUES.length]!;
  let h = 0;
  for (const c of login.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({
  login,
  people,
  large = false,
  className,
}: {
  login: string;
  people: ReadonlyArray<Person>;
  large?: boolean;
  className?: string;
}) {
  const person = people.find((p) => p.login.toLowerCase() === login.toLowerCase());
  return (
    <span
      className={cn(
        "inline-grid flex-none place-items-center rounded-full font-bold text-white",
        large ? "size-[26px] text-xs" : "size-[18px] text-[10px]",
        className,
      )}
      style={{ background: `hsl(${hueOf(login, people)} 45% 45%)` }}
      title={person?.name ?? login}
    >
      {(shortName(login, people)[0] ?? "?").toUpperCase()}
    </span>
  );
}

const RISK_NAMES = ["none", "low", "medium", "high"] as const;

/** Three small bars; amber, red when high; invisible (but in place) at none. */
export function RiskBars({
  risk,
  label = false,
  className,
}: {
  risk: Risk;
  /** Say the risk in words next to the bars on a phone, where there is no tooltip. */
  label?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-end gap-0.5", risk === 0 && "invisible", className)}
      title={`risk ${RISK_NAMES[risk]}`}
      aria-label={`risk ${RISK_NAMES[risk]}`}
    >
      {[1, 2, 3].map((i) => (
        <i
          key={i}
          className={cn(
            "block h-[11px] w-1 rounded-[1px]",
            i > risk ? "bg-line2" : risk >= 3 ? "bg-bad" : "bg-need",
          )}
        />
      ))}
      {label && (
        <span
          aria-hidden
          className="ml-1.5 hidden self-center text-[13px] leading-none phone:inline"
        >
          {RISK_NAMES[risk]} risk
        </span>
      )}
    </span>
  );
}

export function Tag({ tag, className }: { tag: TagText; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[19px] flex-none items-center rounded-[5px] px-[7px] text-[11.5px] whitespace-nowrap",
        tag.tone === "bad" ? "bg-bad-bg text-bad" : "bg-panel2 text-tx2",
        className,
      )}
    >
      {tag.text}
    </span>
  );
}

/**
 * The repo chip (ADR 0007, 1): which repo a row is of, once there is more
 * than one. Outlined, so it never reads as a classifier's tag; the whole
 * repo key on hover. Nothing with one repo (`chips` is empty then).
 */
export function RepoChip({
  repo,
  chips,
  className,
}: {
  repo: string;
  chips: ReadonlyMap<string, string>;
  className?: string;
}) {
  const label = chips.get(repo);
  if (!label) return null;
  return (
    <span
      title={repo}
      className={cn(
        "border-line2 text-tx3 inline-flex h-[19px] max-w-[160px] min-w-0 flex-none items-center truncate rounded-[5px] border px-[6px] font-mono text-[11px] whitespace-nowrap",
        className,
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
