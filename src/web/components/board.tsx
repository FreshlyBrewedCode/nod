/**
 * The board (r3 `09`): columns grouped by Waiting on (or by State, r2 `05`),
 * cards sized by the same four tiers as the list. Tiers 1–2 are cards with
 * the diff, risk and signature pips (tier 1 adds a line of the brief) and a
 * checkbox; tier 3 is a one-line card; tier-4 PRs fold into a dashed
 * "N low-risk" card at the end of a column that opens in place. The columns
 * come from `shared/attention.ts`; nothing is grouped here.
 */

import type * as React from "react";

import type { ClusterItem, Item, PrItem } from "../../shared/attention";
import { kindNames, selectable } from "../../shared/attention";
import type { PrId } from "../../shared/protocol";
import { idOf } from "../../shared/repo-key";
import { MINUTE, useNow } from "@/hooks/use-clock";
import { useDashboard } from "@/hooks/use-dashboard";
import { clusterKey, prKey } from "@/lib/focus";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { checksTag, signaturePips, type Pip } from "@/lib/wording";
import { Avatar, RepoChip, RiskBars, Tag } from "./bits";
import { BriefText } from "./brief-text";
import { DiffIndicator } from "./diff-indicator";
import { Segmented } from "./top-bar";

export type GroupBy = "wait" | "state";

export interface BoardColumnView {
  readonly id: string;
  readonly title: string;
  /** Muted, after the title: "key not enrolled" on my column when my key cannot sign. */
  readonly note?: string | null;
  readonly count: number;
  /** The column that waits on me and I can act on: amber outline, and wider. */
  readonly you: boolean;
  /** Right of the title: "Sign…", "1 day", "last 24h". */
  readonly aside: React.ReactNode;
  readonly items: ReadonlyArray<Item>;
  /** Under the cards: "also #485, after you". */
  readonly footer: string | null;
  /** One quiet sentence when the column is empty. */
  readonly empty: string;
}

export function BoardBar({
  group,
  onGroup,
}: {
  group: GroupBy;
  onGroup: (group: GroupBy) => void;
}) {
  return (
    <div className="text-tx3 flex items-center gap-3 px-5 pt-4 pb-1 text-[13px]">
      Group by
      <Segmented
        label="Group by"
        value={group}
        options={[
          { value: "wait", label: "Waiting on" },
          { value: "state", label: "State" },
          {
            value: "epic",
            label: "Epic",
            title: "Later: epics come with the GitHub issues view (concept decision 15)",
            disabled: true,
          },
        ]}
        onChange={(v) => v !== "epic" && onGroup(v)}
      />
      <span className="flex-1" />
      <span>card size follows attention · pips = signatures needed</span>
    </div>
  );
}

export function Board({
  columns,
  onBackground,
}: {
  columns: ReadonlyArray<BoardColumnView>;
  /** A click on the board between cards (closes the drawer). */
  onBackground: () => void;
}) {
  const template = columns
    .map((c) => (c.you ? "minmax(300px,1.35fr)" : "minmax(236px,1fr)"))
    .join(" ");
  return (
    // A click between cards closes the drawer (the keyboard has Esc).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="min-h-0 flex-1 overflow-auto"
      id="board-scroll"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-key], button, a, label")) onBackground();
      }}
    >
      <div
        className="grid min-w-min items-start gap-3 px-5 pt-3 pb-[110px]"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((c) => (
          <BoardColumn key={c.id} column={c} />
        ))}
      </div>
    </div>
  );
}

function BoardColumn({ column }: { column: BoardColumnView }) {
  return (
    <section
      aria-label={column.note ? `${column.title} · ${column.note}` : column.title}
      className={cn(
        "bg-panel min-h-[120px] min-w-0 rounded-xl border px-2 pb-2",
        column.you ? "border-need-line" : "border-line",
      )}
    >
      <div className="flex h-[46px] items-center gap-2 px-1.5">
        <h3 className="m-0 text-[13px] font-semibold">
          {column.title}
          {column.note && <span className="text-tx3 font-normal"> · {column.note}</span>}
        </h3>
        <span className="text-tx3">{column.count}</span>
        <span className="text-tx3 ml-auto text-xs">{column.aside}</span>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div role="listbox" aria-label={column.title} aria-multiselectable>
        {column.items.map((item) =>
          item.kind === "pr" ? (
            <Card key={idOf(item.pr)} item={item} />
          ) : (
            <ClusterCard key={item.id} cluster={item} />
          ),
        )}
      </div>
      {column.items.length === 0 && (
        <div className="text-tx3 px-1.5 pb-1 text-[12.5px]">{column.empty}</div>
      )}
      {column.footer && <div className="text-tx3 px-1.5 py-1 text-[12.5px]">{column.footer}</div>}
    </section>
  );
}

function Pips({ pips }: { pips: ReadonlyArray<Pip> }) {
  return (
    <>
      {pips.map((p, i) => (
        <span
          key={i}
          title={p.title}
          className={cn(
            "grid size-[17px] flex-none place-items-center rounded-full text-[9px] font-bold",
            p.tone === "ok"
              ? "bg-ok text-[#06140d]"
              : p.tone === "stale"
                ? "border-bad text-bad border-[1.5px]"
                : p.tone === "me"
                  ? "border-need text-need border-[1.5px]"
                  : "border-line2 text-tx3 border-[1.5px] border-dashed",
          )}
        >
          {p.label}
        </span>
      ))}
    </>
  );
}

/** The card's shell: focus, selection, the click that focuses and opens the drawer. */
function CardShell({
  rowKey,
  label,
  selected = false,
  strong = false,
  className,
  onActivate,
  children,
}: {
  rowKey: string;
  label: string;
  selected?: boolean;
  /** Tier 1: a slightly stronger border. */
  strong?: boolean;
  className?: string;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  const { focus } = useDashboard();
  const focused = focus === rowKey;
  return (
    // A multi-select listbox per column, as in the list: focus moves with h/j/k/l.
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="option"
      tabIndex={focused ? 0 : -1}
      aria-label={label}
      aria-selected={selected}
      aria-current={focused || undefined}
      data-key={rowKey}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, label, input")) return;
        onActivate();
      }}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group/card border-line relative mb-1.5 cursor-default rounded-[9px] border outline-none",
        selected && "bg-need-bg",
        className,
        focused ? "border-need" : strong ? "border-line2" : null,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The card's first footer slot: the prompter's avatar, and in its place the
 * checkbox while the card is hovered or focused, selected, or anything is
 * selected. So an idle board looks like r3 `09`, and selecting never moves
 * a thing.
 */
function AvatarOrCheckbox({
  pr,
  number,
  login,
  checked,
}: {
  pr: PrId;
  number: number;
  login: string;
  checked: boolean;
}) {
  const { toggleSelected, selection, people } = useDashboard();
  const shown = checked || selection.length > 0;
  return (
    <span className="relative grid size-[18px] flex-none place-items-center">
      <Avatar
        login={login}
        people={people}
        className={cn(shown ? "invisible" : "group-hover/card:invisible")}
      />
      <label
        className={cn(
          "absolute inset-px grid place-items-center",
          shown ? "visible" : "invisible group-hover/card:visible",
        )}
        title="Select for signing (x)"
      >
        <input
          type="checkbox"
          tabIndex={-1}
          checked={checked}
          aria-label={checked ? `Unselect #${number}` : `Select #${number} for signing`}
          onChange={() => toggleSelected(pr)}
          className="peer border-line2 hover:border-tx3 checked:bg-need checked:border-need bg-panel2 absolute inset-0 m-0 cursor-pointer appearance-none rounded-[5px] border-[1.5px]"
        />
        <span className="pointer-events-none relative hidden h-1 w-2 translate-y-[-1px] -rotate-45 border-b-2 border-l-2 border-[#111] peer-checked:block" />
      </label>
    </span>
  );
}

export function Card({ item, inside = false }: { item: PrItem; inside?: boolean }) {
  const { people, me, selection, focusRow, chips } = useDashboard();
  const now = useNow(MINUTE);
  const pr = item.pr;
  const id = idOf(pr);
  const key = prKey(id);
  const label = `#${pr.number} ${pr.title}`;
  const activate = () => focusRow(key, { open: true });
  const pips = signaturePips(pr, me, people);

  if (item.form >= 3 || inside) {
    const dim = item.form === 4 || inside;
    const checks = checksTag(pr);
    const right =
      pr.fyiForMe && !dim ? (
        <Tag tag={{ text: "FYI", tone: "plain" }} className="bg-know-bg text-know" />
      ) : checks && !dim ? (
        <Tag tag={checks} />
      ) : (
        <Pips pips={pips} />
      );
    return (
      <CardShell
        rowKey={key}
        label={label}
        onActivate={activate}
        className={cn(
          "flex min-w-0 items-center gap-2 overflow-hidden px-2.5 py-1.5 text-[12.5px]",
          dim ? "text-tx3 bg-transparent" : "bg-panel2",
        )}
      >
        <span className="min-w-0 truncate whitespace-nowrap">{pr.title}</span>
        <span className="ml-auto flex flex-none items-center gap-[3px]">{right}</span>
      </CardShell>
    );
  }

  const canSelect = selectable(pr);
  const selected = canSelect && selection.includes(id);
  return (
    <CardShell
      rowKey={key}
      label={label}
      selected={selected}
      onActivate={activate}
      className={cn("px-[11px] py-[9px]", !selected && "bg-panel2")}
      strong={item.form === 1}
    >
      <div className="line-clamp-2 text-[13px] leading-[1.35] font-medium">{pr.title}</div>
      {item.form === 1 && pr.brief && (
        <div className="text-tx2 mt-1 line-clamp-2 text-[12.5px] leading-[1.5]">
          <BriefText text={pr.brief.what} />
        </div>
      )}
      <div className="text-tx3 mt-[7px] flex items-center gap-[7px] text-xs">
        {canSelect ? (
          <AvatarOrCheckbox pr={id} number={pr.number} login={pr.prompter} checked={selected} />
        ) : (
          <Avatar login={pr.prompter} people={people} />
        )}
        <span>{ago(pr.openedAt, now)}</span>
        <RepoChip repo={pr.repo} chips={chips} />
        <DiffIndicator inline added={pr.diff.added} removed={pr.diff.removed} />
        {pr.ask?.kind === "re-attest" && <Tag tag={{ text: "changed", tone: "bad" }} />}
        <span className="ml-auto flex items-center gap-[3px]" title={pr.ask?.label}>
          <RiskBars risk={pr.risk} className="mr-1" />
          <Pips pips={pips} />
        </span>
      </div>
    </CardShell>
  );
}

/** "▸ 2 low-risk · tier 1, signed by you", opening in place to dim one-line cards. */
function ClusterCard({ cluster }: { cluster: ClusterItem }) {
  const { expanded, toggleCluster, focusRow } = useDashboard();
  const open = expanded.has(cluster.id);
  const key = clusterKey(cluster.id);
  const text = `${cluster.prs.length} low-risk · ${kindNames(cluster.kinds, false).join(", ")}`;
  return (
    <>
      <CardShell
        rowKey={key}
        label={`${cluster.label}: ${cluster.subtitle}`}
        onActivate={() => {
          focusRow(key);
          toggleCluster(cluster.id);
        }}
        className="text-tx3 truncate border-dashed bg-transparent px-2.5 py-[7px] text-[12.5px] whitespace-nowrap"
      >
        <span aria-expanded={open}>
          {open ? "▾" : "▸"} {text}
        </span>
      </CardShell>
      {open &&
        cluster.prs.map((pr) => (
          <Card key={idOf(pr)} item={{ kind: "pr", pr, tier: 4, form: 4 }} inside />
        ))}
    </>
  );
}
