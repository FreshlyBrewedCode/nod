/**
 * My own inbox on screen (ADR 0009 decision 1), the pure part: the words of
 * the personal layer, kept apart from the repo's. The repo decides risk and
 * what a PR needs ("repo: high risk · another human"); my inbox decides how
 * much of my attention it gets ("you: raised · auth"). Nothing here mixes
 * the two: the repo's reasons are `wording.ts`'s, mine are here.
 */

import { repoTier, tier, lane, LANE_TITLES, type Tier } from "../../shared/attention";
import type { InboxStatus, NamedMark, PersonalAttention, PrView } from "../../shared/protocol";

const RISK_WORDS = ["no risk", "low risk", "medium risk", "high risk"] as const;

/** The repo's layer in one line: "repo: high risk · Another human (not the prompter)". */
export function repoLine(pr: Pick<PrView, "risk" | "requirement">): string {
  return [`repo: ${RISK_WORDS[pr.risk]}`, pr.requirement.label].filter(Boolean).join(" · ");
}

/** My personal attention, if it says anything: a PR my inbox did not run on, or that it left alone, has none. */
export function personalOf(pr: Pick<PrView, "personal">): PersonalAttention | null {
  const p = pr.personal ?? null;
  if (!p) return null;
  return p.attention !== 0 || p.tags.length || p.fyi || p.marks.length || p.errors.length
    ? p
    : null;
}

/**
 * The row's quiet personal tag (never the repo's `Tag`): my first tag, or
 * "muted" for a PR my inbox muted without one. null: nothing to show (a PR
 * raised or lowered without a tag needs no mark; the panel says why it sits
 * where it sits).
 */
export function personalTag(pr: Pick<PrView, "personal">): string | null {
  const p = personalOf(pr);
  if (!p) return null;
  if (p.attention === "mute") return p.tags[0] ? `muted · ${p.tags[0]}` : "muted";
  return p.tags[0] ?? null;
}

/** My layer in one line, for the fold's summary and the panel: "you: raised · auth", "you: muted". */
export function youLine(pr: Pick<PrView, "personal">): string | null {
  const p = personalOf(pr);
  if (!p) return null;
  const move =
    p.attention === "mute"
      ? "muted"
      : p.attention === 1
        ? "raised"
        : p.attention === -1
          ? "lowered"
          : p.fyi
            ? "worth knowing"
            : "";
  const parts = [move, ...p.tags].filter(Boolean);
  if (parts.length === 0) return p.errors.length ? "you: a classifier failed" : null;
  return `you: ${parts.join(" · ")}`;
}

/** One mark of my inbox, as the "Your inbox" group lists it. */
export interface MarkLine {
  /** The mark's sentence ("3 files you watch (core/auth/**): …"). */
  readonly detail: string;
  /** What it does: "↑ one tier", "↓ one tier", "muted", "worth knowing", or its tag alone. */
  readonly effect: string;
  /** Which classifier said it. */
  readonly classifier: string;
  readonly raises: boolean;
}

/** Every mark, in order, with what it does in words. */
export function markLines(marks: ReadonlyArray<NamedMark>): ReadonlyArray<MarkLine> {
  return marks.map((m) => {
    const does =
      m.attention === "mute"
        ? "muted"
        : m.attention === 1
          ? "↑ one tier"
          : m.attention === -1
            ? "↓ one tier"
            : m.fyi
              ? "worth knowing"
              : "";
    const effect = [does, m.tag ? `tag ${m.tag}` : ""].filter(Boolean).join(" · ") || "noted";
    return { detail: m.detail, effect, classifier: m.classifier, raises: m.attention === 1 };
  });
}

const TIER_WORDS: Readonly<Record<Tier, string>> = {
  1: "prominent",
  2: "a normal row",
  3: "one line",
  4: "folded",
};

/**
 * Why the row sits where it sits, when my inbox moved it (or tried to): the
 * tier the repo gave it and the one it has now, and, when a rule held it,
 * which. null when my inbox did not ask to move it.
 */
export function placementLine(pr: PrView): string | null {
  const p = personalOf(pr);
  if (!p || (p.attention === 0 && !p.fyi)) return null;
  const without: PrView = { ...pr, personal: undefined };
  const before = repoTier(without);
  const now = tier(pr);
  const laneNow = LANE_TITLES[lane(pr)];
  const laneBefore = LANE_TITLES[lane(without)];
  const where = laneNow === laneBefore ? "" : `, in ${laneNow}`;
  if (p.attention === "mute") {
    if (pr.needsMe) return "Muted by your inbox, but it needs you: it stays in Needs you.";
    if (now !== 4)
      return `Muted by your inbox, but high risk: it stays ${TIER_WORDS[now]}${where}.`;
    return `Muted by your inbox: folded into ${laneNow}.`;
  }
  if (p.attention === 0)
    return laneNow === laneBefore
      ? null
      : `Your inbox finds it worth knowing: it is in ${laneNow}.`;
  if (now === before) {
    if (p.attention === 1) return `Your inbox raised it, but it is ${TIER_WORDS[now]} already.`;
    return pr.needsMe
      ? `Your inbox lowered it, but it needs you: it stays ${TIER_WORDS[now]}.`
      : `Your inbox lowered it, but it stays ${TIER_WORDS[now]}.`;
  }
  const verb = p.attention === 1 ? "Raised" : "Lowered";
  return `${verb} by your inbox: ${TIER_WORDS[now]}${where}, where the repo alone shows it ${TIER_WORDS[before]}.`;
}

// ---------------------------------------------------------------------------
// the banner and Settings → Inbox

/**
 * The quiet banner above the list: my inbox's error, unless it was put away
 * (per error text, so a new error shows again). null: no banner.
 */
export function bannerError(
  inbox: Pick<InboxStatus, "error"> | null | undefined,
  dismissed: ReadonlyArray<string>,
): string | null {
  const error = inbox?.error ?? null;
  if (!error) return null;
  return dismissed.includes(error) ? null : error;
}

/** The errors put away, as stored: strings only, the newest 20. */
export function readDismissed(stored: unknown): ReadonlyArray<string> {
  if (!Array.isArray(stored)) return [];
  return stored.filter((s): s is string => typeof s === "string").slice(-20);
}

/** Settings → Inbox's first line: what runs, and whether it loads. */
export function inboxStateLine(inbox: InboxStatus): string {
  const what =
    inbox.config === "yours" ? "Your inbox.ts runs" : "The built-in defaults run (no inbox.ts)";
  switch (inbox.state) {
    case "starting":
      return `${what}: loading…`;
    case "error":
      return `${what}, but it does not load. The last good load stays in effect.`;
    default: {
      const c = inbox.classifiers.length;
      const a = inbox.analyzers.length;
      return `${what}: ${c} classifier${c === 1 ? "" : "s"}, ${a} analyzer${a === 1 ? "" : "s"}.`;
    }
  }
}

/** The file that runs, or the folder that would hold it: `<path>/inbox.ts`. */
export function inboxFile(inbox: Pick<InboxStatus, "path">): string {
  return `${inbox.path.replace(/\/+$/, "")}/inbox.ts`;
}
