/**
 * What a deep link lands on (concept decision 7; r1/r2 `4-deeplink`, r3
 * `#link`): the PRs it names as the snapshot knows them, which of them still
 * need me, and why the others do not. Nothing here signs: the landing's
 * button opens the normal batch dialog.
 */

import type { PrView, Snapshot, UnclassifiedPr } from "../../shared/protocol";
import { linkNumbers, type LinkRoute } from "./route";
import { duration } from "./time";
import { namesOf, statusText, type People } from "./wording";

export interface LinkTarget {
  readonly pr: PrView;
  /** It has a slot I can fill now: selected on the landing, part of the batch. */
  readonly needsMe: boolean;
  /** Why it does not need me (any more); null when it does. */
  readonly why: string | null;
}

export type Landing =
  /** The link is for another repo than the one `nod serve` reads. */
  | { readonly kind: "other-repo"; readonly repo: string; readonly here: string }
  | {
      readonly kind: "found";
      readonly targets: ReadonlyArray<LinkTarget>;
      /** Named by the link, open, but not classified by the verifier yet. */
      readonly unclassified: ReadonlyArray<UnclassifiedPr>;
      /** Named by the link, not in the snapshot: merged long ago, or a wrong number. */
      readonly missing: ReadonlyArray<number>;
    };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The PR on GitHub, for links that cannot be shown here. */
export function githubPrUrl(repo: string, pr: number): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

/**
 * Why a PR the link names does not need me, in a few words: "merged 2 hours
 * ago", "you signed it already", "waits on Jonas". null when it needs me.
 */
export function whyNotNeeded(pr: PrView, people: People, now: number): string | null {
  if (pr.state === "merged")
    return pr.mergedAt !== null ? `merged ${duration(now - pr.mergedAt)} ago` : "merged";
  if (pr.state === "closed") return "closed without merging";
  if (pr.ask && pr.patchId === null) return "its patch-id is not known yet; try again in a moment";
  if (pr.ask) return null;
  if (pr.state === "draft") return "a draft: the agent is still writing it";
  if (pr.signatures.some((s) => s.byMe && s.counts)) return "you signed it already";
  if (pr.requirement.slots.length === 0 && pr.tags.includes("not classified"))
    return "not classified yet: the verifier has not run on it";
  if (pr.requirement.slots.length === 0 && pr.tags.includes("verifier error"))
    return "the verifier failed on it; nothing can be signed until it runs again";
  // A slot for me, and no ask: my key cannot sign here yet (pending or not enrolled).
  if (pr.state === "open" && pr.waitingOn.some((w) => w.kind === "me"))
    return "it waits on you, but your key cannot sign here until it is enrolled";
  if (pr.mine && pr.waitingOn.some((w) => w.kind === "anyone"))
    return "your own work: it waits on a teammate’s nod, not yours";
  if (pr.requirement.satisfied) return "nothing more is needed; its agent merges it";
  const humans = pr.waitingOn.filter((w) => w.kind === "person" || w.kind === "anyone");
  if (humans.length) return `waits on ${namesOf(humans, people)}, not you`;
  return `nothing needed from you: ${statusText(pr, people)}`;
}

export function landingOf(route: LinkRoute, snapshot: Snapshot, now: number): Landing {
  if (!same(route.repo, snapshot.repo))
    return { kind: "other-repo", repo: route.repo, here: snapshot.repo };
  const targets: LinkTarget[] = [];
  const unclassified: UnclassifiedPr[] = [];
  const missing: number[] = [];
  for (const n of linkNumbers(route)) {
    const pr = snapshot.prs.find((p) => p.number === n);
    const waiting = snapshot.unclassified.find((u) => u.number === n);
    if (pr) {
      const why = whyNotNeeded(pr, snapshot.people, now);
      targets.push({ pr, needsMe: why === null, why });
    } else if (waiting) unclassified.push(waiting);
    else missing.push(n);
  }
  return { kind: "found", targets, unclassified, missing };
}

/** "#482 as peer, #476 as owner": what the batch signs, by role. */
export function asWhat(prs: ReadonlyArray<PrView>): string {
  const role = (p: PrView) =>
    p.ask?.kind === "peer"
      ? "as peer"
      : p.ask?.kind === "owner"
        ? "as owner"
        : p.ask?.kind === "self"
          ? "as your own work"
          : "again";
  return prs.map((p) => `#${p.number} ${role(p)}`).join(", ");
}

/** "Both can merge afterwards." / "It still waits on Jonas afterwards." */
export function afterwards(prs: ReadonlyArray<PrView>, people: People): string {
  const merging = prs.filter((p) => p.ask?.then.outcome === "satisfied");
  const waiting = prs.filter((p) => p.ask?.then.outcome === "waits");
  const parts: string[] = [];
  if (merging.length)
    parts.push(
      merging.length === prs.length
        ? prs.length === 1
          ? "It can merge afterwards."
          : prs.length === 2
            ? "Both can merge afterwards."
            : `All ${prs.length} can merge afterwards.`
        : `${merging.map((p) => `#${p.number}`).join(", ")} can merge afterwards.`,
    );
  for (const p of waiting)
    if (p.ask?.then.outcome === "waits")
      parts.push(
        `${waiting.length === prs.length && prs.length === 1 ? "It" : `#${p.number}`} still waits on ${namesOf(p.ask.then.on, people) || "someone else"}.`,
      );
  return parts.join(" ");
}
