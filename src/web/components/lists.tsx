/**
 * The two orders of the list (r3): by attention, in three lanes; and
 * chronological, in time buckets. Both render what `shared/attention.ts`
 * returns; nothing is grouped here.
 */

import type * as React from "react";

import type { Bucket, Item, Lane, LaneView } from "../../shared/attention";
import { cn } from "@/lib/utils";
import { ClusterRow, PrRow } from "./pr-row";

export function Rows({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="listbox"
      aria-label={label}
      aria-multiselectable
      className="border-line bg-panel divide-line divide-y overflow-hidden rounded-xl border"
    >
      {children}
    </div>
  );
}

export function ItemRows({
  items,
  chrono,
  label,
}: {
  items: ReadonlyArray<Item>;
  chrono: boolean;
  label: string;
}) {
  return (
    <Rows label={label}>
      {items.map((item) =>
        item.kind === "pr" ? (
          <PrRow key={item.pr.number} item={item} chrono={chrono} />
        ) : (
          <ClusterRow key={item.id} cluster={item} chrono={chrono} />
        ),
      )}
    </Rows>
  );
}

const DOT: Readonly<Record<Lane, string>> = {
  needs: "bg-need",
  know: "bg-know",
  background: "bg-bgl",
};

export function LaneHeader({
  lane,
  title,
  count,
  hint,
}: {
  lane: Lane;
  title: string;
  count: number;
  hint?: string | null;
}) {
  return (
    <div className="flex items-baseline gap-2.5 px-1 pb-2.5">
      <span className={cn("size-2 flex-none self-center rounded-[2px]", DOT[lane])} />
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      <span className="text-tx3">{count}</span>
      {hint && <span className="text-tx3 ml-auto text-[12.5px]">{hint}</span>}
    </div>
  );
}

/** An empty lane: one sentence in a dashed box. */
export function EmptyLane({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-line2 text-tx3 rounded-xl border border-dashed px-[18px] py-[22px]">
      {children}
    </div>
  );
}

export function LaneSection({
  lane,
  hint,
  empty,
  chrono = false,
}: {
  lane: LaneView;
  hint?: string | null;
  empty?: React.ReactNode;
  chrono?: boolean;
}) {
  return (
    <section className="mb-[34px]" aria-label={lane.title}>
      <LaneHeader lane={lane.lane} title={lane.title} count={lane.count} hint={hint} />
      {lane.items.length ? (
        <ItemRows items={lane.items} chrono={chrono} label={lane.title} />
      ) : (
        <EmptyLane>{empty}</EmptyLane>
      )}
    </section>
  );
}

export function BucketSection({ bucket }: { bucket: Bucket }) {
  return (
    <section aria-label={bucket.label}>
      <div className="text-tx3 flex gap-2.5 px-1.5 pt-4 pb-2 text-xs font-semibold tracking-[0.06em] uppercase">
        {bucket.label}
        <span className="font-normal tracking-normal normal-case">
          {bucket.count} change{bucket.count === 1 ? "" : "s"}
        </span>
      </div>
      <ItemRows items={bucket.items} chrono label={bucket.label} />
    </section>
  );
}
