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
 *
 * On a phone (below 640 px, "Stacked rows", docs/design/m1) the same elements
 * are laid out again by `phone:` rules, with no second DOM: the content
 * wrapper becomes `display: contents` so the title, the brief and the meta
 * line are grid items of the row; the meta line takes the diff numbers and
 * the risk bars (their desktop columns are hidden), the ask sits at the right
 * of the meta line, the checkbox column is always there.
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
  localNeed,
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

/** A phone's rows (m1 A): a 46 px checkbox column, the content, the ask. */
const PHONE_BOX =
  "phone:grid-cols-[46px_minmax(0,1fr)_auto] phone:gap-0 phone:items-start phone:px-0 phone:py-0 phone:pt-[11px]";
/** A one-liner has no checkbox: its own padding, the ask or status at the right. */
const PHONE_ONE =
  "phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-0 phone:items-start phone:pr-0 phone:pl-4 phone:py-0 phone:pt-[11px] phone:pb-[9px]";
/** The checkbox (or its empty place) spans the rows of a tier 1 or 2 row. */
const PHONE_BOX_CELL =
  "phone:col-start-1 phone:row-start-1 phone:row-span-3 phone:justify-self-center";
/** Marks the focus or the selection by a bar on the left, as the mockup's `.ar.on`. */
const SELECT_BAR = "before:bg-need before:absolute before:inset-y-0 before:left-0 before:w-0.5";
const PHONE_SELECT_BAR =
  "phone:before:bg-need phone:before:absolute phone:before:inset-y-0 phone:before:left-0 phone:before:w-0.5 phone:before:block";
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
        // A phone's focus is where you last were: no tint, no bar, unless it is selected.
        focused && cn("bg-focus", SELECT_BAR, "phone:bg-transparent phone:before:hidden"),
        // As in r3, the selection tint wins over the focus background (the bar stays).
        // A phone marks a selected row as the mockup does: the focus tint and the bar.
        selected && cn("bg-need-bg phone:bg-focus", PHONE_SELECT_BAR),
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
    // On a phone the label is the 44 px target around a 22 px box.
    <label
      className={cn("relative grid size-4 place-items-center phone:size-11", PHONE_BOX_CELL)}
      title="Select for signing (x)"
    >
      <input
        type="checkbox"
        tabIndex={-1}
        checked={checked}
        aria-label={checked ? `Unselect #${pr}` : `Select #${pr} for signing`}
        onChange={() => toggleSelected(pr)}
        className="peer border-line2 hover:border-tx3 checked:bg-need checked:border-need absolute inset-0 m-0 cursor-pointer appearance-none rounded-[5px] border-[1.5px] phone:inset-auto phone:top-1/2 phone:left-1/2 phone:size-[22px] phone:-translate-x-1/2 phone:-translate-y-1/2 phone:rounded-[7px]"
      />
      <span className="pointer-events-none relative hidden h-1 w-2 translate-y-[-1px] -rotate-45 border-b-2 border-l-2 border-[#111] peer-checked:block phone:h-1.5 phone:w-3" />
    </label>
  );
}

function Meta({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("text-tx3 fs-note mt-[3px] flex items-center gap-[7px]", className)}>
      {children}
    </div>
  );
}

/**
 * The diff numbers and the risk bars as a phone's meta line has them: the
 * desktop columns are hidden there, and these two are hidden everywhere else.
 * No 38 px bar on a phone, the numbers say it; no bars at no risk.
 */
function PhoneStats({ pr }: { pr: PrItem["pr"] }) {
  return (
    <>
      <DiffIndicator
        inline
        added={pr.diff.added}
        removed={pr.diff.removed}
        className="hidden phone:inline phone:text-[13px]"
      />
      {pr.risk > 0 && <RiskBars risk={pr.risk} className="hidden phone:inline-flex" />}
    </>
  );
}

/**
 * What happened last, in the chronological view: on a phone its own line under
 * the meta (on a desktop it is part of the meta text).
 */
function PhoneActivity({ text }: { text: string }) {
  return <span className="hidden phone:block phone:basis-full">{text}</span>;
}

/**
 * The right-hand column: the ask, "Got it", or the status. On a phone the ask
 * is a 44 px-high word at the right of the meta line (`row`: which grid row
 * that is); on a one-liner it spans both lines and is centred.
 */
function RightColumn({
  item,
  small,
  phoneRow,
}: {
  item: PrItem;
  small: boolean;
  /** The classes that place it in a phone's grid. */
  phoneRow: string;
}) {
  const { openBatch, ackFyi, people, me } = useDashboard();
  const pr = item.pr;
  const size = small ? "text-[12.5px]" : "text-[13px]";
  const phoneAction = cn(
    "phone:flex phone:min-h-11 phone:items-center phone:pr-4 phone:pl-2.5 phone:text-sm phone:col-start-[-2]",
    phoneRow,
  );
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
          phoneAction,
        )}
      >
        {pr.ask.label}
      </button>
    );
  // The inbox step: needed from me, but nothing to sign here (the panel links to GitHub).
  const need = localNeed(pr, people, me);
  if (need)
    return (
      <span
        className={cn(
          "text-need justify-self-end text-right font-semibold whitespace-nowrap",
          size,
          phoneAction,
        )}
      >
        {need.row}
      </span>
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
          phoneAction,
        )}
      >
        Got it
      </button>
    );
  return (
    <span
      className={cn(
        "text-tx3 truncate text-right text-[12.5px] whitespace-nowrap",
        "phone:col-start-[-2] phone:pr-4 phone:pl-2.5 phone:text-[13px] phone:leading-5 phone:overflow-visible phone:whitespace-normal",
        phoneRow,
      )}
    >
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
  const whenStr = whenText(pr.lastActivity.at, now, offset);
  const when = chrono ? (
    <span className="text-tx3 text-xs tabular-nums phone:hidden">{whenStr}</span>
  ) : null;
  const box = canSelect ? (
    <Checkbox pr={pr.number} checked={selected} />
  ) : (
    <span className={cn(PHONE_BOX_CELL, "phone:hidden")} />
  );
  const activate = () => focusRow(key, { open: true });
  const hasAction = Boolean(pr.ask || pr.fyiForMe);

  if (form >= 3) {
    // Two texts, the desktop's whole and the phone's without the name (the avatar says who,
    // and in the chronological view the time leads): never one text cut in two, so a
    // desktop's text is laid out as it always was.
    const reason =
      pr.fyiForMe && pr.fyi && !chrono ? (
        fyiWhy(pr.fyi)
      ) : (
        <>
          <span className="phone:hidden">
            {chrono ? pr.lastActivity.text : `${who} · ${ago(pr.openedAt, now)}`}
          </span>
          <span className="hidden phone:inline">{chrono ? whenStr : ago(pr.openedAt, now)}</span>
        </>
      );
    const checks = form === 3 ? checksTag(pr) : null;
    return (
      <RowShell
        rowKey={key}
        chrono={chrono}
        inside={inside}
        onActivate={activate}
        label={`#${pr.number} ${pr.title}`}
        className={cn("py-2", PHONE_ONE)}
      >
        {when}
        {box}
        <div className="flex min-w-0 items-center gap-2.5 phone:contents">
          <span
            className={cn(
              "min-w-0 truncate whitespace-nowrap",
              "phone:row-start-1 phone:col-start-1 phone:text-[15px] phone:leading-[21px] phone:overflow-visible phone:whitespace-normal phone:[overflow-wrap:anywhere]",
              // Without an ask the status sits on the meta line, so the title takes the width.
              !hasAction && "phone:col-span-2 phone:pr-4",
              form === 3 ? "text-tx phone:font-[450]" : "text-tx3",
            )}
          >
            {pr.title}
          </span>
          <span className="text-tx3 fs-note block min-w-[70px] shrink-[1000] truncate whitespace-nowrap phone:col-start-1 phone:row-start-2 phone:flex phone:flex-wrap phone:items-center phone:gap-x-2 phone:gap-y-1 phone:overflow-visible phone:whitespace-normal phone:pt-1.5 phone:pb-2">
            <Avatar
              login={pr.prompter}
              people={people}
              className="mr-1.5 -mt-0.5 align-middle phone:mt-0 phone:mr-0"
            />
            {reason}
            {hints.map((h) => (
              <span key={h} className="phone:hidden">
                {" "}
                · {h}
              </span>
            ))}
            {checks && <Tag tag={checks} className="ml-1.5 phone:ml-0" />}
            <PhoneStats pr={pr} />
            {chrono && <PhoneActivity text={pr.lastActivity.text} />}
            {hints.length > 0 && (
              <span className="hidden phone:block phone:basis-full">{hints.join(" · ")}</span>
            )}
          </span>
        </div>
        <DiffIndicator
          added={pr.diff.added}
          removed={pr.diff.removed}
          className={cn("phone:hidden", form === 4 && "opacity-55")}
        />
        <RiskBars risk={pr.risk} className="phone:hidden" />
        <RightColumn
          item={item}
          small
          phoneRow={
            hasAction
              ? "phone:row-start-1 phone:row-span-2 phone:self-center"
              : "phone:row-start-2 phone:self-end"
          }
        />
      </RowShell>
    );
  }

  const tag = rowTag(pr);
  const brief = form === 1 && pr.brief;
  const metaRow = brief ? "phone:row-start-3" : "phone:row-start-2";
  return (
    <RowShell
      rowKey={key}
      chrono={chrono}
      inside={inside}
      selected={selected}
      onActivate={activate}
      label={`#${pr.number} ${pr.title}`}
      className={cn(form === 1 ? "py-[15px]" : "py-[13px]", PHONE_BOX)}
    >
      {when}
      {box}
      <div className="min-w-0 phone:contents">
        <div
          className={cn(
            "truncate whitespace-nowrap",
            "phone:col-[2/4] phone:row-start-1 phone:pr-4 phone:text-[15px] phone:leading-[21px] phone:overflow-visible phone:whitespace-normal phone:[overflow-wrap:anywhere]",
            form === 1 ? "text-[14.5px] font-semibold" : "font-medium",
          )}
        >
          {pr.title}
        </div>
        {brief && (
          <div className="text-tx2 mt-0.5 truncate whitespace-nowrap phone:col-[2/4] phone:row-start-2 phone:mt-0 phone:pt-[3px] phone:pr-4 phone:text-[13.5px] phone:leading-[19px] phone:line-clamp-2 phone:overflow-hidden phone:whitespace-normal">
            <BriefText text={pr.brief!.what} />
          </div>
        )}
        <Meta
          className={cn(
            "phone:col-start-2 phone:mt-0 phone:flex-wrap phone:gap-x-2 phone:gap-y-1 phone:self-center phone:pt-1.5 phone:pb-2",
            metaRow,
          )}
        >
          <Avatar login={pr.prompter} people={people} />
          <span className="min-w-[3ch] truncate whitespace-nowrap phone:overflow-visible phone:whitespace-normal">
            <span className="phone:hidden">
              {`${who} · ${chrono ? pr.lastActivity.text : ago(pr.openedAt, now)}`}
            </span>
            <span className="hidden phone:inline">{chrono ? whenStr : ago(pr.openedAt, now)}</span>
          </span>
          {tag && <Tag tag={tag} />}
          <PhoneStats pr={pr} />
          {chrono && <PhoneActivity text={pr.lastActivity.text} />}
          {hints.length > 0 && (
            <span
              className="min-w-0 shrink-[1000] truncate whitespace-nowrap phone:basis-full phone:overflow-visible phone:whitespace-normal"
              title="From the brief and stacked branches"
            >
              {hints.join(" · ")}
            </span>
          )}
        </Meta>
      </div>
      <DiffIndicator added={pr.diff.added} removed={pr.diff.removed} className="phone:hidden" />
      <RiskBars risk={pr.risk} className="phone:hidden" />
      <RightColumn item={item} small={false} phoneRow={cn(metaRow, "phone:self-end")} />
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
        className={cn("text-tx2 py-2", PHONE_ONE, "phone:grid-cols-1 phone:min-h-11 phone:pr-4")}
      >
        {chrono && <span className="phone:hidden" />}
        <span className="text-tx3 text-center text-[11px] phone:hidden" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <div className="flex min-w-0 items-center gap-2.5 phone:contents" aria-expanded={open}>
          <b className="text-tx2 font-medium whitespace-nowrap phone:text-[15px] phone:leading-[21px]">
            <span className="text-tx3 hidden phone:inline" aria-hidden>
              {open ? "▾" : "▸"}{" "}
            </span>
            {cluster.label}
          </b>
          <span className="text-tx3 fs-note block min-w-[70px] shrink-[1000] truncate whitespace-nowrap phone:min-w-0 phone:overflow-visible phone:whitespace-normal phone:pt-0.5">
            {cluster.subtitle}
          </span>
        </div>
        <DiffIndicator added={cluster.added} removed={cluster.removed} className="phone:hidden" />
        <span className="phone:hidden" />
        <span className="text-tx3 fs-note justify-self-end text-right whitespace-nowrap phone:justify-self-start phone:text-left">
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
