/**
 * A PR's details on a phone: a full-screen page (docs/design/m1 `a-detail`,
 * with direction C's "1 of 6 that need you" and `Next ›`). The same content
 * as the desktop panel (`detail-panel.tsx`, whose fold bodies it shares) laid
 * out for a thumb: a header with back, the brief stacked under small labels,
 * the folds closed with their summaries, and a sticky action bar with the
 * primary action. The risk bars and the avatar have no tooltip here, so they
 * are said in words. Opening it is a history entry (`hooks/use-back-stop.ts`),
 * so the back gesture returns to the list where it was.
 */

import { ChevronLeft, ChevronRight, ExternalLink, Lock } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { selectable } from "../../shared/attention";
import type { PrView } from "../../shared/protocol";
import { MINUTE, useNow, useUtcOffset } from "@/hooks/use-clock";
import { useDashboard } from "@/hooks/use-dashboard";
import { nextNeedingYou, positionAmong } from "@/lib/next";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  checksTag,
  filesSummary,
  fyiSummary,
  journeySummary,
  localNeed,
  neededFromYou,
  ownPrHint,
  reasonsSummary,
  reviewsSummary,
  riskWords,
  rowTag,
  signaturesSummary,
  thenText,
  whoOf,
} from "@/lib/wording";
import { Avatar, RiskBars, Tag } from "./bits";
import { BriefText } from "./brief-text";
import {
  ApproveDetail,
  FilesBody,
  FyiBody,
  JourneyList,
  OwnPrNote,
  ReasonsBody,
  ReviewsBody,
  SignaturesBody,
} from "./detail-panel";
import { DiffIndicator } from "./diff-indicator";

const BUTTON =
  "border-line2 bg-panel2 text-tx inline-flex h-[46px] min-w-0 items-center justify-center gap-2 rounded-[11px] border px-4 text-[15px] font-semibold whitespace-nowrap";

export function DetailPage({
  pr,
  order,
  onClose,
  onOpen,
}: {
  pr: PrView;
  /** The PRs that need me, in list order (`lib/next.ts`). */
  order: ReadonlyArray<number>;
  onClose: () => void;
  /** Show another PR in the page (`Next ›`). */
  onOpen: (pr: number) => void;
}) {
  const { people, me, openBatch, selection, toggleSelected, ackFyi, signing } = useDashboard();
  const now = useNow(MINUTE);
  const offset = useUtcOffset();
  const page = useRef<HTMLElement>(null);
  useEffect(() => page.current?.focus({ preventScroll: true }), [pr.number]);

  const position = positionAmong(order, pr.number);
  const next = nextNeedingYou(order, pr.number);
  const selected = selection.includes(pr.number);
  const tag = rowTag(pr);
  const checks = checksTag(pr);
  const who = whoOf(pr, people);
  const needed = neededFromYou(pr);
  const need = localNeed(pr, people, me);
  const own = need ? null : ownPrHint(pr, signing);
  const canBatch = selectable(pr);
  const hasBar = Boolean(pr.ask || need || pr.fyiForMe || canBatch || next !== null);
  const riskWord = pr.risk > 0 ? riskWords(pr.risk, pr.brief?.risk ?? null) : null;

  return (
    <section
      ref={page}
      tabIndex={-1}
      aria-label={`Details of #${pr.number}`}
      className="bg-bg pt-safe px-safe fixed inset-0 z-30 flex flex-col outline-none"
    >
      <header className="border-line bg-bg flex h-[52px] flex-none items-center gap-1 border-b">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to the list"
          className="text-tx grid min-h-11 min-w-11 flex-none place-items-center"
        >
          <ChevronLeft className="size-6" />
        </button>
        <span className="text-tx2 min-w-0 flex-1 truncate text-sm">
          {position
            ? `${position.index} of ${position.total} that need you`
            : `#${pr.number}${pr.topic ? ` · ${pr.topic}` : ""}`}
        </span>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="text-tx3 inline-flex min-h-11 flex-none items-center gap-1 px-3.5 text-[13px]"
        >
          GitHub <ExternalLink className="size-3.5" />
        </a>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        <div className="px-4 pt-4">
          <h1 className="m-0 text-xl leading-[26px] font-[650] tracking-[-0.01em] [overflow-wrap:anywhere]">
            {pr.title}
          </h1>
          <div className="text-tx3 mt-2 flex flex-wrap items-center gap-x-[9px] gap-y-1.5 text-[13.5px]">
            <Avatar login={pr.prompter} people={people} />
            <span>
              {who === "you" ? "You" : who} · {pr.state === "merged" ? "merged" : "open"}{" "}
              {ago(pr.mergedAt ?? pr.openedAt, now)}
            </span>
            <DiffIndicator inline added={pr.diff.added} removed={pr.diff.removed} />
            <span>
              {pr.diff.files} file{pr.diff.files === 1 ? "" : "s"}
            </span>
            {tag && <Tag tag={tag} />}
            {checks && <Tag tag={checks} />}
          </div>

          {pr.brief ? (
            <dl className="mt-[18px] mb-0">
              <Term>What</Term>
              <Def>
                <BriefText text={pr.brief.what} />
              </Def>
              {pr.brief.why && (
                <>
                  <Term>Why</Term>
                  <Def>
                    <BriefText text={pr.brief.why} />
                  </Def>
                </>
              )}
              <Term>Risk</Term>
              <Def>
                <RiskLine risk={pr.risk} word={riskWord} />
                <BriefText text={pr.brief.risk} />
              </Def>
              <Term>Verified</Term>
              <Def>
                <BriefText text={pr.brief.verified} />
              </Def>
            </dl>
          ) : (
            <>
              <p className="text-tx3 mt-[18px] mb-0 text-[15px]">This pull request has no brief.</p>
              {riskWord && (
                <p className="mt-2 mb-0 text-[15px]">
                  <RiskLine risk={pr.risk} word={riskWord} />
                </p>
              )}
            </>
          )}
          {own && <OwnPrNote text={own} className="mt-1 mb-3.5" />}
        </div>

        <div className="mt-1">
          <PageFold id="journey" title="Journey" summary={journeySummary(pr.journey, now, offset)}>
            <JourneyList events={pr.journey} className="mt-0.5 mb-0" />
          </PageFold>
          <PageFold id="reasons" title="Why this needs you" summary={reasonsSummary(pr)}>
            <ReasonsBody pr={pr} />
          </PageFold>
          {pr.classifiedBy === "local" ? (
            <PageFold id="reviews" title="Reviews" summary={reviewsSummary(pr.review)}>
              <ReviewsBody pr={pr} />
            </PageFold>
          ) : (
            <PageFold id="signatures" title="Signatures" summary={signaturesSummary(pr)}>
              <SignaturesBody pr={pr} />
            </PageFold>
          )}
          {pr.fyi && (
            <PageFold id="fyi" title="FYI" summary={fyiSummary(pr.fyi, people, me)}>
              <FyiBody fyi={pr.fyi} />
            </PageFold>
          )}
          <PageFold id="files" title="Files" summary={filesSummary(pr)} last>
            <FilesBody pr={pr} />
          </PageFold>
        </div>
      </div>

      {hasBar && (
        <div className="border-line2 flex-none border-t bg-[#11141af2] px-3 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] backdrop-blur-md">
          {needed && pr.ask && (
            <p className="text-tx2 m-0 px-1 pb-[9px] text-[13px] leading-[18px]">
              <b className="text-tx font-semibold">{needed}</b>{" "}
              {pr.ask.kind === "approve" ? (
                <ApproveDetail pr={pr} ask={pr.ask} />
              ) : (
                thenText(pr.ask, people)
              )}
            </p>
          )}
          {need && (
            <p className="text-tx2 m-0 px-1 pb-[9px] text-[13px] leading-[18px]">
              <b className="text-tx font-semibold">{need.headline}.</b> {need.detail}
            </p>
          )}
          <div className="flex items-center gap-2">
            {canBatch && (
              <button
                type="button"
                aria-pressed={selected}
                aria-label={selected ? "Take out of the batch" : "Add to batch"}
                onClick={() => toggleSelected(pr.number)}
                className={cn(
                  BUTTON,
                  next !== null && "px-3.5",
                  selected && "border-need-line bg-need-bg text-need",
                )}
              >
                {next !== null
                  ? selected
                    ? "✓ Batch"
                    : "+ Batch"
                  : selected
                    ? "✓ In the batch"
                    : "Add to batch"}
              </button>
            )}
            {pr.ask ? (
              <button
                type="button"
                onClick={() => openBatch([pr.number])}
                className={cn(BUTTON, "bg-need border-need text-on-need flex-1 px-2")}
              >
                {pr.ask.kind !== "approve" && <Lock className="size-4 flex-none" />}
                <span className="truncate">{pr.ask.label}</span>
              </button>
            ) : need ? (
              <a
                href={need.href}
                target="_blank"
                rel="noreferrer"
                className={cn(BUTTON, "bg-need border-need text-on-need flex-1 px-2")}
              >
                <span className="truncate">{need.action}</span>
                <ExternalLink className="size-4 flex-none" />
              </a>
            ) : pr.fyiForMe ? (
              <button
                type="button"
                onClick={() => ackFyi(pr.number)}
                className={cn(BUTTON, "text-know flex-1 border-[#74a9ff55] bg-transparent")}
              >
                Got it
              </button>
            ) : (
              <span className="flex-1" />
            )}
            {next !== null && (
              <button
                type="button"
                onClick={() => onOpen(next)}
                aria-label={`Next that needs you, #${next}`}
                className={cn(BUTTON, "px-3.5")}
              >
                Next <ChevronRight className="-mr-1 size-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The risk bars, and the level in words where the brief's text does not say it. */
function RiskLine({ risk, word }: { risk: PrView["risk"]; word: string | null }) {
  if (risk === 0) return null;
  return (
    <span className="mr-1.5 inline-flex items-center gap-1.5 align-[-1px]">
      <RiskBars risk={risk} />
      {word && <span className="text-tx">{word.charAt(0).toUpperCase() + word.slice(1)}.</span>}
    </span>
  );
}

function Term({ children }: { children: ReactNode }) {
  return (
    <dt className="text-tx3 text-[11.5px] font-semibold tracking-[0.05em] uppercase">{children}</dt>
  );
}

function Def({ children }: { children: ReactNode }) {
  return <dd className="m-0 mt-[3px] mb-3.5 text-[15px] leading-[22px]">{children}</dd>;
}

/** A fold of the page: closed, a 50 px header with the summary, the body in the page's padding. */
function PageFold({
  id,
  title,
  summary,
  last = false,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  last?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("border-line border-t", last && "border-b")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`fold-${id}`}
        onClick={() => setOpen(!open)}
        className="flex min-h-[50px] w-full items-center gap-2.5 px-4 text-left"
      >
        <b className="flex-none text-[15px] font-semibold">{title}</b>
        <span className="text-tx3 min-w-0 truncate text-[13px]">{summary}</span>
        <i className="text-tx3 ml-auto flex-none text-[13px] not-italic" aria-hidden>
          {open ? "▾" : "▸"}
        </i>
      </button>
      {open && (
        <div id={`fold-${id}`} className="px-4 pb-3.5">
          {children}
        </div>
      )}
    </div>
  );
}
