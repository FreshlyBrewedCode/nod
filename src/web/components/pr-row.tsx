/**
 * A row of the list, in the form its attention tier gives it (r3):
 *
 * - 1 prominent: title, one line of the brief, meta, diff, risk, the ask
 * - 2 normal: title, meta, diff, risk, the ask
 * - 3 one line: title and a reason (an FYI's reason to care, or who and age),
 *   diff, risk, "Got it" or the status
 * - 4 dim one-liner: a folded PR, shown inside its open cluster or alone
 *
 * In the chronological view a time column leads and the meta says what
 * happened last instead of the age. Checkboxes only on tiers 1 and 2.
 */

import type * as React from "react";

import type { ClusterItem, PrItem } from "../../shared/attention";
import { selectable } from "../../shared/attention";
import { MINUTE, useNow, useUtcOffset } from "@/hooks/use-clock";
import { useDashboard } from "@/hooks/use-dashboard";
import { clusterKey, prKey } from "@/lib/focus";
import { ago, whenText } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  checksTag,
  clusterStatus,
  dependencyHints,
  fyiWhy,
  rowTag,
  statusText,
  whoOf,
} from "@/lib/wording";
import { Avatar, RiskBars, Tag } from "./bits";
import { BriefText } from "./brief-text";
import { DiffIndicator } from "./diff-indicator";

const GRID = "grid grid-cols-[20px_minmax(0,1fr)_124px_16px_108px] items-center gap-[14px]";
const GRID_CHRONO =
  "grid grid-cols-[40px_20px_minmax(0,1fr)_124px_16px_108px] items-center gap-[14px]";

export const rowGrid = (chrono: boolean) => (chrono ? GRID_CHRONO : GRID);

/** The row's shell: focus bar, selection tint, the click that focuses and opens. */
function RowShell({
  rowKey,
  chrono,
  className,
  selected = false,
  inside = false,
  onActivate,
  label,
  children,
}: {
  rowKey: string;
  chrono: boolean;
  className?: string;
  selected?: boolean;
  inside?: boolean;
  onActivate: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const { focus } = useDashboard();
  const focused = focus === rowKey;
  return (
    // A multi-select listbox: focus moves with j/k, `x` selects (aria-selected). The row is
    // a CSS grid, so no native element fits.
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="option"
      tabIndex={focused ? 0 : -1}
      aria-label={label}
      aria-selected={selected}
      aria-current={focused || undefined}
      data-key={rowKey}
      onClick={(e) => {
        // The checkbox, the ask and "Got it" act on their own.
        if ((e.target as HTMLElement).closest("button, a, label, input")) return;
        onActivate();
      }}
      onKeyDown={(e) => {
        // Enter and the other keys are handled once, by the list's keymap.
        if (e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        rowGrid(chrono),
        "relative cursor-default px-[18px] outline-none",
        inside && "bg-bg",
        focused &&
          "bg-focus before:bg-need before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        // As in r3, the selection tint wins over the focus background (the bar stays).
        selected && "bg-need-bg",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Checkbox({ pr, checked }: { pr: number; checked: boolean }) {
  const { toggleSelected } = useDashboard();
  return (
    <label className="relative grid size-4 place-items-center" title="Select for signing (x)">
      <input
        type="checkbox"
        tabIndex={-1}
        checked={checked}
        aria-label={checked ? `Unselect #${pr}` : `Select #${pr} for signing`}
        onChange={() => toggleSelected(pr)}
        className="peer border-line2 hover:border-tx3 checked:bg-need checked:border-need absolute inset-0 m-0 cursor-pointer appearance-none rounded-[5px] border-[1.5px]"
      />
      <span className="pointer-events-none relative hidden h-1 w-2 translate-y-[-1px] -rotate-45 border-b-2 border-l-2 border-[#111] peer-checked:block" />
    </label>
  );
}

function Meta({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("text-tx3 mt-[3px] flex items-center gap-[7px] text-[12.5px]", className)}>
      {children}
    </div>
  );
}

/** The right-hand column: the ask, "Got it", or the status. */
function RightColumn({ item, small }: { item: PrItem; small: boolean }) {
  const { openBatch, ackFyi, people } = useDashboard();
  const pr = item.pr;
  const size = small ? "text-[12.5px]" : "text-[13px]";
  if (pr.ask)
    return (
      <button
        type="button"
        tabIndex={-1}
        title="Sign (s)"
        onClick={(e) => {
          e.stopPropagation();
          openBatch([pr.number]);
        }}
        className={cn(
          "text-need justify-self-end text-right font-semibold whitespace-nowrap hover:underline",
          size,
        )}
      >
        {pr.ask.label}
      </button>
    );
  if (pr.fyiForMe)
    return (
      <button
        type="button"
        tabIndex={-1}
        title="Got it (e)"
        onClick={(e) => {
          e.stopPropagation();
          ackFyi(pr.number);
        }}
        className={cn(
          "text-know justify-self-end text-right font-semibold whitespace-nowrap hover:underline",
          size,
        )}
      >
        Got it
      </button>
    );
  return (
    <span className="text-tx3 truncate text-right text-[12.5px] whitespace-nowrap">
      {statusText(pr, people)}
    </span>
  );
}

export function PrRow({
  item,
  chrono,
  inside = false,
}: {
  item: PrItem;
  chrono: boolean;
  inside?: boolean;
}) {
  const { people, selection, focusRow } = useDashboard();
  const now = useNow(MINUTE);
  const offset = useUtcOffset();
  const pr = item.pr;
  const form = item.form;
  const key = prKey(pr.number);
  const canSelect = selectable(pr);
  const selected = canSelect && selection.includes(pr.number);
  const who = whoOf(pr, people);
  const hints = dependencyHints(pr);
  const when = chrono ? (
    <span className="text-tx3 text-xs tabular-nums">
      {whenText(pr.lastActivity.at, now, offset)}
    </span>
  ) : null;
  const box = canSelect ? <Checkbox pr={pr.number} checked={selected} /> : <span />;
  const activate = () => focusRow(key, { open: true });

  if (form >= 3) {
    const reason = chrono
      ? pr.lastActivity.text
      : pr.fyiForMe && pr.fyi
        ? fyiWhy(pr.fyi)
        : `${who} · ${ago(pr.openedAt, now)}`;
    const checks = form === 3 ? checksTag(pr) : null;
    return (
      <RowShell
        rowKey={key}
        chrono={chrono}
        inside={inside}
        onActivate={activate}
        label={`#${pr.number} ${pr.title}`}
        className="py-2"
      >
        {when}
        {box}
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "min-w-0 truncate whitespace-nowrap",
              form === 3 ? "text-tx" : "text-tx3",
            )}
          >
            {pr.title}
          </span>
          <span className="text-tx3 block min-w-[70px] shrink-[1000] truncate text-[12.5px] whitespace-nowrap">
            <Avatar login={pr.prompter} people={people} className="mr-1.5 -mt-0.5 align-middle" />
            {reason}
            {hints.map((h) => (
              <span key={h}> · {h}</span>
            ))}
            {checks && <Tag tag={checks} className="ml-1.5" />}
          </span>
        </div>
        <DiffIndicator
          added={pr.diff.added}
          removed={pr.diff.removed}
          className={cn(form === 4 && "opacity-55")}
        />
        <RiskBars risk={pr.risk} />
        <RightColumn item={item} small />
      </RowShell>
    );
  }

  const tag = rowTag(pr);
  const meta = chrono ? `${who} · ${pr.lastActivity.text}` : `${who} · ${ago(pr.openedAt, now)}`;
  return (
    <RowShell
      rowKey={key}
      chrono={chrono}
      inside={inside}
      selected={selected}
      onActivate={activate}
      label={`#${pr.number} ${pr.title}`}
      className={form === 1 ? "py-[15px]" : "py-[13px]"}
    >
      {when}
      {box}
      <div className="min-w-0">
        <div
          className={cn(
            "truncate whitespace-nowrap",
            form === 1 ? "text-[14.5px] font-semibold" : "font-medium",
          )}
        >
          {pr.title}
        </div>
        {form === 1 && pr.brief && (
          <div className="text-tx2 mt-0.5 truncate whitespace-nowrap">
            <BriefText text={pr.brief.what} />
          </div>
        )}
        <Meta>
          <Avatar login={pr.prompter} people={people} />
          <span className="min-w-[3ch] truncate whitespace-nowrap">{meta}</span>
          {tag && <Tag tag={tag} />}
          {hints.length > 0 && (
            <span
              className="min-w-0 shrink-[1000] truncate whitespace-nowrap"
              title="From the brief and stacked branches"
            >
              {hints.join(" · ")}
            </span>
          )}
        </Meta>
      </div>
      <DiffIndicator added={pr.diff.added} removed={pr.diff.removed} />
      <RiskBars risk={pr.risk} />
      <RightColumn item={item} small={false} />
    </RowShell>
  );
}

/** "7 low-risk changes · 3 deps · 2 tier 1 · …", expanding in place to dim one-liners. */
export function ClusterRow({ cluster, chrono }: { cluster: ClusterItem; chrono: boolean }) {
  const { expanded, toggleCluster, focusRow } = useDashboard();
  const open = expanded.has(cluster.id);
  const key = clusterKey(cluster.id);
  return (
    <>
      <RowShell
        rowKey={key}
        chrono={chrono}
        inside={open}
        onActivate={() => {
          focusRow(key);
          toggleCluster(cluster.id);
        }}
        label={`${cluster.label}: ${cluster.subtitle}`}
        className="text-tx2 py-2"
      >
        {chrono && <span />}
        <span className="text-tx3 text-center text-[11px]" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <div className="flex min-w-0 items-center gap-2.5" aria-expanded={open}>
          <b className="text-tx2 font-medium whitespace-nowrap">{cluster.label}</b>
          <span className="text-tx3 block min-w-[70px] shrink-[1000] truncate text-[12.5px] whitespace-nowrap">
            {cluster.subtitle}
          </span>
        </div>
        <DiffIndicator added={cluster.added} removed={cluster.removed} />
        <span />
        <span className="text-tx3 justify-self-end text-right text-[12.5px] whitespace-nowrap">
          {clusterStatus(cluster)}
        </span>
      </RowShell>
      {open &&
        cluster.prs.map((pr) => (
          <PrRow
            key={pr.number}
            item={{ kind: "pr", pr, tier: 4, form: 4 }}
            chrono={chrono}
            inside
          />
        ))}
    </>
  );
}
