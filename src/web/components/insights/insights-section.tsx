/**
 * The Insights section (ADR 0009 decision 4): what my own inbox's analyzers
 * say about a PR, after the brief and "Needed from you", in the desktop
 * panel and on a phone's detail page. One sub-block per insight, in the
 * inbox's order, with its title and a quiet `default` / `yours` label; its
 * blocks when `ready`, a calm placeholder while `running`, the error (small)
 * when `failed`, all inside that sub-block. An `empty` insight is hidden;
 * with none to show the section is one quiet line, and without an inbox (or
 * on a merged PR it never looked at) it is not there.
 *
 * Opening it asks `nod serve` for the PR's `when: "open"` analyzers
 * (`openInsights`, once per PR and head); their states arrive as `insights`
 * pushes, which the connection layer merges into the snapshot.
 */

import { useEffect } from "react";
import type { ReactNode } from "react";

import type { Block, InsightState, PrView } from "../../../shared/protocol";
import { useDashboard } from "@/hooks/use-dashboard";
import { insightsEmptyLine, insightsSummary, isCompact, shownInsights } from "@/lib/insights";
import { formatRoute } from "@/lib/route";
import { cn } from "@/lib/utils";
import { BreakdownBlock } from "./breakdown-block";
import { FilesBlock } from "./files-block";
import { SeriesBlock } from "./series-block";
import { StatsBlock } from "./stats-block";
import { TextBlock } from "./text-block";

const H6 = "text-tx3 m-0 text-[11px] font-semibold tracking-[0.08em] uppercase";

export function InsightsSection({ pr, className }: { pr: PrView; className?: string }) {
  const { inbox, openInsights } = useDashboard();
  const open = pr.state === "open" || pr.state === "draft";
  const hasInbox = inbox !== null;
  useEffect(() => {
    if (hasInbox && open) openInsights(pr);
    // `openInsights` asks once per PR and head; it keeps what it asked for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the PR's identity, not the object
  }, [hasInbox, open, pr.repo, pr.number, pr.headSha]);
  if (!hasInbox) return null;
  const shown = shownInsights(pr.insights);
  const empty = insightsEmptyLine(pr.insights, open);
  if (shown.length === 0 && !empty) return null;
  return (
    <section aria-label="Insights" className={className}>
      <div className="flex items-baseline gap-2.5">
        <h2 className={H6}>Insights</h2>
        {shown.length > 0 && (
          <span className="text-tx3 fs-note">{insightsSummary(pr.insights ?? [])}</span>
        )}
        <a
          href={formatRoute({ view: "settings", section: "inbox" })}
          className="text-tx3 hover:text-tx2 fs-note ml-auto phone:inline-flex phone:min-h-11 phone:items-center"
        >
          from your inbox
        </a>
      </div>
      {shown.length === 0 ? (
        <p className="text-tx3 fs-note m-0 mt-1">{empty}</p>
      ) : (
        // Two columns from 600 px of panel (its own width, not the window's): the
        // compact insights side by side, the rest across.
        <div className="@container mt-2">
          <div className="grid grid-flow-row-dense grid-cols-1 gap-x-7 @min-[600px]:grid-cols-2">
            {shown.map((insight) => (
              <InsightCard key={insight.id} state={insight} pr={pr} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** One insight: its title and origin, then what its state has. */
function InsightCard({ state, pr }: { state: InsightState; pr: PrView }) {
  const title = (state.status === "ready" && state.insight.title) || state.title;
  const summary = state.status === "ready" ? state.insight.summary : undefined;
  return (
    <article
      aria-label={title}
      aria-busy={state.status === "running" || undefined}
      className={cn(
        "border-line min-w-0 border-t py-3.5",
        !isCompact(state) && "@min-[600px]:col-span-2",
      )}
    >
      <header className="flex items-baseline gap-2">
        <h3 className="m-0 min-w-0 truncate text-[13.5px] font-semibold phone:text-[14.5px]">
          {title}
        </h3>
        <Origin origin={state.origin} />
        {state.status === "running" && (
          <span className="text-tx3 fs-note ml-auto flex-none">running…</span>
        )}
        {state.status === "failed" && (
          <span className="text-bad fs-note ml-auto flex-none">failed</span>
        )}
      </header>
      {summary && <p className="text-tx3 fs-note m-0 mt-0.5 leading-[1.45]">{summary}</p>}
      {state.status === "ready" && (
        <div className="mt-2.5 space-y-4">
          {state.insight.blocks.map((block, i) => (
            <BlockView key={i} block={block} pr={pr} />
          ))}
        </div>
      )}
      {state.status === "running" && <Running when={state.when} />}
      {state.status === "failed" && (
        <p className="text-tx3 m-0 mt-1.5 font-mono text-[11.5px] leading-[1.5] [overflow-wrap:anywhere] phone:text-[12.5px]">
          {state.error}
        </p>
      )}
    </article>
  );
}

/** `default` (the kit's) or `yours`: quiet, mono, outlined, so it never reads as a tag. */
function Origin({ origin }: { origin: InsightState["origin"] }) {
  return (
    <span
      title={origin === "default" ? "One of nod’s built-in analyzers" : "From your inbox.ts"}
      className={cn(
        "inline-flex h-[17px] flex-none items-center rounded-[4px] border px-[5px] font-mono text-[10.5px]",
        origin === "yours" ? "border-line2 text-tx2" : "border-line text-tx3",
      )}
    >
      {origin}
    </span>
  );
}

/** A calm placeholder: two soft bars that breathe (still, with reduced motion). */
function Running({ when }: { when: InsightState["when"] }) {
  return (
    <div className="mt-2.5" aria-hidden>
      <div className="bg-line2/70 h-2.5 w-full rounded-full motion-safe:animate-pulse" />
      <div className="bg-line2/70 mt-2 h-2.5 w-3/5 rounded-full motion-safe:animate-pulse [animation-delay:300ms]" />
      {when === "open" && (
        <p className="text-tx3 fs-note m-0 mt-2">It runs when you open a pull request.</p>
      )}
    </div>
  );
}

function BlockView({ block, pr }: { block: Block; pr: PrView }): ReactNode {
  switch (block.type) {
    case "breakdown":
      return <BreakdownBlock block={block} />;
    case "stats":
      return <StatsBlock block={block} />;
    case "series":
      return <SeriesBlock block={block} />;
    case "files":
      return <FilesBlock block={block} pr={pr} />;
    case "text":
      return <TextBlock block={block} />;
    default:
      // A block type this build does not know (a newer server): left out.
      return null;
  }
}
