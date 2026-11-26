/**
 * The PR detail panel (r3 `02`, `03`), in r3's order: what is needed from
 * me with the sign buttons, the brief, the journey, then folded sections
 * (why this needs you, signatures, FYI, files). Narrow: a vertical journey
 * and the sections closed. From 620 px: "Look at", a horizontal journey and
 * the sections open.
 */

import { ExternalLink, Lock, Maximize2, X } from "lucide-react";
import { useState } from "react";
import type * as React from "react";

import { shortName } from "../../shared/attention";
import type { JourneyEvent, PrView } from "../../shared/protocol";
import { MINUTE, useNow, useUtcOffset } from "@/hooks/use-clock";
import { useDashboard } from "@/hooks/use-dashboard";
import { isWidePanel } from "@/lib/panel";
import { formatRoute } from "@/lib/route";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  askHeadline,
  checksTag,
  filesSummary,
  fyiSummary,
  journeyDetail,
  reasonsSummary,
  signaturesSummary,
  slotText,
  thenText,
  whoOf,
} from "@/lib/wording";
import { Avatar, Kbd, RiskBars, Tag } from "./bits";
import { BriefText } from "./brief-text";
import { DiffIndicator } from "./diff-indicator";

const H6 = "text-tx3 m-0 mb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase";
const BUTTON =
  "border-line2 bg-panel2 text-tx inline-flex h-8 items-center justify-center gap-2 rounded-lg border px-3.5 text-[13px] font-semibold whitespace-nowrap";
const PRIMARY = "bg-need border-need text-on-need";

export function DetailPanel({
  pr,
  width,
  onClose,
}: {
  pr: PrView | null;
  width: number;
  onClose: () => void;
}) {
  const { snapshot, github } = useDashboard();
  return (
    <aside className="bg-panel h-full overflow-auto" aria-label="Details">
      <div className="bg-panel border-line sticky top-0 z-10 flex items-center gap-2 border-b py-3 pr-4 pl-6">
        <span className="text-tx3 truncate text-[12.5px]">
          {pr ? `#${pr.number}${pr.topic ? ` · ${pr.topic}` : ""}` : "Details"}
        </span>
        <span className="flex-1" />
        {pr && (
          <>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-tx3 hover:text-tx2 inline-flex items-center gap-1 text-[12.5px]"
            >
              GitHub <ExternalLink className="size-3" />
            </a>
            <a
              className="border-line text-tx2 hover:text-tx grid size-7 place-items-center rounded-[7px] border"
              href={formatRoute({
                view: "pr",
                host: github.host,
                repo: snapshot.repo,
                number: pr.number,
              })}
              title="Link to this pull request"
            >
              <Maximize2 className="size-[13px]" />
            </a>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          className="border-line text-tx2 hover:text-tx grid size-7 place-items-center rounded-[7px] border"
          title="Close (esc)"
          aria-label="Close details"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {pr ? (
        <PanelBody key={pr.number} pr={pr} wide={isWidePanel(width)} />
      ) : (
        <p className="text-tx3 px-6 py-5">
          Focus a row (<Kbd>j</Kbd> <Kbd>k</Kbd>) to see its details here.
        </p>
      )}
    </aside>
  );
}

function PanelBody({ pr, wide }: { pr: PrView; wide: boolean }) {
  const { people, me, openBatch, selection, toggleSelected } = useDashboard();
  const now = useNow(MINUTE);
  const checks = checksTag(pr);
  const selected = selection.includes(pr.number);
  return (
    <div className="px-6 pt-5 pb-10">
      <h1 className="m-0 mb-1.5 text-[19px] leading-[1.3] font-bold tracking-[-0.01em]">
        {pr.title}
      </h1>
      <div className="text-tx3 flex flex-wrap items-center gap-[7px] text-[13px]">
        <Avatar login={pr.prompter} people={people} />
        <span>
          {whoOf(pr, people) === "you" ? "You" : whoOf(pr, people)} ·{" "}
          {pr.state === "merged" ? "merged" : "open"} {ago(pr.mergedAt ?? pr.openedAt, now)}
        </span>
        <DiffIndicator inline added={pr.diff.added} removed={pr.diff.removed} />
        <span>
          {pr.diff.files} file{pr.diff.files === 1 ? "" : "s"}
        </span>
        {checks && <Tag tag={checks} />}
      </div>

      {pr.ask && (
        <div className="border-need-line bg-bg mt-[18px] flex flex-wrap items-center gap-4 rounded-[14px] border px-[18px] py-4">
          <div>
            <h6 className={H6}>Needed from you</h6>
            <b className="block text-[15.5px] font-bold">{askHeadline(pr)}</b>
            <div className="text-tx3 text-[12.5px] leading-[1.55]">{thenText(pr.ask, people)}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              className={cn(BUTTON, PRIMARY)}
              onClick={() => openBatch([pr.number])}
            >
              <Lock className="size-[15px]" />
              Sign <Kbd className="border-[#0003] bg-[#0002] text-on-need">s</Kbd>
            </button>
            <button type="button" className={BUTTON} onClick={() => toggleSelected(pr.number)}>
              {selected ? "In the batch" : "Add to batch"} <Kbd>x</Kbd>
            </button>
          </div>
        </div>
      )}

      {pr.brief ? (
        <dl className="mt-[22px] mb-0 grid grid-cols-[64px_1fr] gap-x-3.5 gap-y-2.5 text-[14px] leading-[1.5]">
          <Dt>What</Dt>
          <Dd>
            <BriefText text={pr.brief.what} />
          </Dd>
          {pr.brief.why && (
            <>
              <Dt>Why</Dt>
              <Dd>
                <BriefText text={pr.brief.why} />
              </Dd>
            </>
          )}
          <Dt>Risk</Dt>
          <Dd>
            <RiskBars risk={pr.risk} className={cn(pr.risk === 0 && "hidden")} />
            {pr.risk > 0 && "  "}
            <BriefText text={pr.brief.risk} />
          </Dd>
          <Dt>Verified</Dt>
          <Dd>
            <BriefText text={pr.brief.verified} />
          </Dd>
          {wide && pr.brief.lookAt.length > 0 && (
            <>
              <Dt>Look at</Dt>
              <Dd className="text-tx2 font-mono text-xs leading-[1.5]">
                {pr.brief.lookAt.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </Dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-tx3 mt-[22px]">This pull request has no brief.</p>
      )}

      {wide ? <JourneyRow events={pr.journey} /> : <JourneyList events={pr.journey} />}

      <div className="mt-[22px]">
        <Fold title="Why this needs you" summary={reasonsSummary(pr)} open={wide}>
          <ReasonsBody pr={pr} />
        </Fold>
        <Fold title="Signatures" summary={signaturesSummary(pr)} open={wide}>
          <SignaturesBody pr={pr} />
        </Fold>
        {pr.fyi && (
          <Fold title="FYI" summary={fyiSummary(pr.fyi, people, me)} open={wide}>
            <FyiBody fyi={pr.fyi} />
          </Fold>
        )}
        <Fold title="Files" summary={filesSummary(pr)} open={wide}>
          <FilesBody pr={pr} />
        </Fold>
      </div>
    </div>
  );
}

/** The inside of the "Why this needs you" fold (the panel's and the phone page's). */
export function ReasonsBody({ pr }: { pr: PrView }) {
  return (
    <>
      {pr.reasons.map((r) => (
        <div
          key={`${r.classifier}:${r.fact}`}
          className="grid grid-cols-[1fr_auto] gap-2.5 py-1.5 text-[13.5px] phone:border-line phone:grid-cols-1 phone:gap-0 phone:border-t phone:py-2 phone:text-sm phone:first:border-t-0 phone:first:pt-0"
        >
          <span>{r.fact}</span>
          <span className={cn(r.raises ? "text-need" : "text-tx3", "phone:text-[13px]")}>
            {r.raises ? "↑ " : ""}
            {r.effect}
          </span>
        </div>
      ))}
      <p className="text-tx3 mt-2 mb-0 text-[12.5px]">
        Policy rule <span className="font-mono">{pr.requirement.policy}</span>, read from {pr.base}.
      </p>
    </>
  );
}

/** The inside of the "Signatures" fold. */
export function SignaturesBody({ pr }: { pr: PrView }) {
  const { people, me } = useDashboard();
  const now = useNow(MINUTE);
  const offset = useUtcOffset();
  return (
    <>
      {pr.requirement.slots.length === 0 && (
        <p className="text-tx3 m-0 text-[13px]">{pr.requirement.label}.</p>
      )}
      {pr.requirement.slots.map((slot, i) => {
        const sig = slot.signature === null ? null : (pr.signatures[slot.signature] ?? null);
        const t = slotText(slot, sig, people, me, now, offset);
        return (
          <div key={i} className="grid grid-cols-[22px_1fr] gap-2.5 py-[7px] text-[13.5px]">
            <span
              className={cn(
                "mt-0.5 grid size-[18px] place-items-center rounded-full text-[11px] font-bold",
                slot.state === "ok"
                  ? "bg-ok text-[#06140d]"
                  : slot.state === "stale"
                    ? "border-bad text-bad border-[1.5px]"
                    : "border-need border-[1.5px]",
              )}
            >
              {slot.state === "ok" ? "✓" : slot.state === "stale" ? "!" : ""}
            </span>
            <div>
              {t.who}
              <small className="text-tx3 block text-[12.5px]">{t.detail}</small>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The inside of the "FYI" fold. */
export function FyiBody({ fyi }: { fyi: NonNullable<PrView["fyi"]> }) {
  const { people, me } = useDashboard();
  return (
    <>
      <p className="text-tx2 m-0 text-[13px]">{fyi.reason}</p>
      {fyi.pending.length > 0 && (
        <p className="text-tx3 mt-1 mb-0 text-[12.5px]">
          Not seen yet by{" "}
          {fyi.pending
            .map((l) => (l.toLowerCase() === me.toLowerCase() ? "you" : shortName(l, people)))
            .join(", ")}
          .
        </p>
      )}
    </>
  );
}

/** The inside of the "Files" fold. */
export function FilesBody({ pr }: { pr: PrView }) {
  return (
    <>
      {pr.files ? (
        pr.files.map((f) => (
          <div
            key={f.path}
            className="text-tx2 grid grid-cols-[1fr_90px_80px] gap-2.5 py-[5px] text-[12.5px] phone:border-line phone:grid-cols-[minmax(0,1fr)_auto] phone:items-center phone:border-t phone:py-1 phone:first:border-t-0 phone:min-h-9"
          >
            <span className="truncate font-mono text-xs phone:fs-code">{f.path}</span>
            <span className="phone:text-[13px]">
              <span className="text-ok">+{f.added}</span>{" "}
              <span className="text-bad">−{f.removed}</span>
            </span>
            <span className="text-tx3 truncate phone:col-span-2 phone:text-[13px] phone:empty:hidden">
              {f.excluded ?? f.area ?? ""}
            </span>
          </div>
        ))
      ) : (
        <p className="text-tx3 m-0 text-[13px]">
          The file list is on{" "}
          <a className="underline" href={`${pr.url}/files`} target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      )}
      {pr.diff.excluded.files > 0 && (
        <p className="text-tx3 mt-2 mb-0 text-[12.5px]">
          Not counted: {pr.diff.excluded.files} lockfile or generated file
          {pr.diff.excluded.files === 1 ? "" : "s"} (+{pr.diff.excluded.added} −
          {pr.diff.excluded.removed}).
        </p>
      )}
    </>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-tx3 pt-0.5 text-[13px]">{children}</dt>;
}

function Dd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dd className={cn("m-0", className)}>{children}</dd>;
}

/** A folded section; the panel's width decides how it starts. */
function Fold({
  title,
  summary,
  open: initial,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<{ open: boolean; from: boolean }>({
    open: initial,
    from: initial,
  });
  // A width change past 620 px resets it to the new default.
  const open = state.from === initial ? state.open : initial;
  return (
    <div className="border-line border-t py-3.5 last:border-b">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 text-left"
        aria-expanded={open}
        onClick={() => setState({ open: !open, from: initial })}
      >
        <b className="font-semibold">{title}</b>
        <span className="text-tx3 text-[13px]">{summary}</span>
        <i className="text-tx3 ml-auto text-xs not-italic">{open ? "▾" : "▸"}</i>
      </button>
      {open && <div className="pt-3 pb-0.5">{children}</div>}
    </div>
  );
}

function useJourneyText() {
  const now = useNow(MINUTE);
  const offset = useUtcOffset();
  return (e: JourneyEvent) => journeyDetail(e, now, offset);
}

/** The journey as a vertical list: the narrow panel's, and the phone page's fold. */
export function JourneyList({
  events,
  className,
}: {
  events: ReadonlyArray<JourneyEvent>;
  className?: string;
}) {
  const detail = useJourneyText();
  return (
    <ul className={cn("journey-v relative mt-6 mb-1.5 list-none p-0", className)}>
      {events.map((e, i) => (
        <li
          key={i}
          className={cn(
            "relative flex gap-2 py-[3px] pl-6 text-[13px]",
            "before:absolute before:top-[7px] before:left-0 before:size-3 before:rounded-full before:border-2",
            e.phase === "now"
              ? "text-need before:bg-need before:border-panel font-semibold"
              : e.phase === "next"
                ? "text-tx3 before:bg-panel before:border-line2 before:border-dashed"
                : e.tone === "bad"
                  ? "text-tx2 before:bg-bad before:border-panel"
                  : "text-tx2 before:bg-ok before:border-panel",
          )}
        >
          {e.text}
          <small className="text-tx3 ml-auto text-xs font-normal">{detail(e)}</small>
        </li>
      ))}
    </ul>
  );
}

function JourneyRow({ events }: { events: ReadonlyArray<JourneyEvent> }) {
  const detail = useJourneyText();
  return (
    <div
      className="journey-h relative mt-[34px] mb-2 grid"
      style={{ gridTemplateColumns: `repeat(${events.length}, minmax(0, 1fr))` }}
    >
      {events.map((e, i) => (
        <div
          key={i}
          className={cn(
            "relative px-1 pt-5 text-center text-xs leading-[1.35]",
            "before:absolute before:top-0 before:left-1/2 before:-ml-[7px] before:size-3.5 before:rounded-full",
            e.phase === "now"
              ? "text-need before:bg-need before:border-panel font-semibold before:border-[3px] before:shadow-[0_0_0_4px_var(--need-bg)]"
              : e.phase === "next"
                ? "text-tx3 before:bg-panel before:border-line2 before:border-2 before:border-dashed"
                : e.tone === "bad"
                  ? "text-tx2 before:bg-bad before:border-panel before:border-[3px]"
                  : "text-tx2 before:bg-ok before:border-panel before:border-[3px]",
          )}
        >
          {e.text}
          <small className="text-tx3 block text-[11.5px] font-normal">{detail(e)}</small>
        </div>
      ))}
    </div>
  );
}
