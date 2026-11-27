/**
 * The settings page (`#/settings`, ADR 0007, concept C.8 and D.7), the pure
 * part: its sections and the words of the Repositories and App sections.
 *
 * Adding a section: its id in `SETTINGS_SECTIONS` (`lib/route.ts`, which
 * also makes `#/settings/<id>` a route), its words in `SECTIONS` below, and
 * its page in `SECTION_PAGES` (`components/settings.tsx`). The nav lists
 * only the sections there are: none is shipped empty.
 */

import type { Enrolment, RepoInfo, RepoSuggestion, SignerState } from "../../shared/protocol";
import { parseRepoInput } from "../../shared/repo-key";
import type { Failure } from "./batch";
import { RUNG_NAMES, onboardingError } from "./onboarding";
import { SETTINGS_SECTIONS, type SettingsSection } from "./route";

export interface SectionWords {
  /** The nav's entry and the section's heading. */
  readonly title: string;
  /** Under the entry in the nav: what is in it. */
  readonly line: string;
}

export const SECTIONS: Readonly<Record<SettingsSection, SectionWords>> = {
  repositories: { title: "Repositories", line: "what nod reads, and each one’s step" },
  app: { title: "App", line: "install it, the badge" },
};

/** The section a route shows: the one it names, else the first. */
export function sectionOf(asked: SettingsSection | null | undefined): SettingsSection {
  return asked ?? SETTINGS_SECTIONS[0];
}

// ---------------------------------------------------------------------------
// Repositories

/** My key in one repo, in a few words: "your key signs here", "your key is pending · #501". */
export function keyWords(signer: SignerState | null, enrolment: Enrolment | null): string {
  if (!signer || signer.state === "no-key") return "no signing key";
  switch (enrolment?.state) {
    case "active":
      return "your key signs here";
    case "pending":
      return enrolment.pr ? `your key is pending · #${enrolment.pr.number}` : "your key is pending";
    default:
      return "your key is not enrolled";
  }
}

/**
 * A repo's row, under its name: its host, its step of the ladder, my key
 * there. "github.com · Enforced · your key signs here".
 */
export function repoFacts(repo: RepoInfo, signer: SignerState | null): string {
  return [repo.github.host, RUNG_NAMES[repo.setup.step], keyWords(signer, repo.enrolment)].join(
    " · ",
  );
}

/** "2 open pull requests of yours · 1 review requested"; "nothing open of yours" when both are 0. */
export function suggestionLine(s: Pick<RepoSuggestion, "myOpenPrs" | "reviewRequests">): string {
  const parts: string[] = [];
  if (s.myOpenPrs)
    parts.push(`${s.myOpenPrs} open pull request${s.myOpenPrs === 1 ? "" : "s"} of yours`);
  if (s.reviewRequests)
    parts.push(`${s.reviewRequests} review${s.reviewRequests === 1 ? "" : "s"} requested`);
  return parts.join(" · ") || "nothing open of yours";
}

/** What is wrong with the text in the add field, before anything is sent; null when it names a repo. */
export function addProblem(text: string): string | null {
  if (!text.trim()) return "Type a repository, or pick one below.";
  return parseRepoInput(text)
    ? null
    : "That is not a repository: type owner/name, host/owner/name, or paste its link.";
}

/** A failed `add-repo` or `remove-repo`, in one calm sentence. */
export function repoListError(failure: Failure): string {
  switch (failure.code) {
    case "not-found":
    case "forbidden":
    case "bad-request":
      return failure.message;
    default:
      return onboardingError(failure);
  }
}

// ---------------------------------------------------------------------------
// App

/** The badge's line in Settings → App: what it shows now. */
export function badgeLine(n: number | null): string {
  if (n === null) return "It shows once nod serve has read GitHub.";
  if (n === 0) return "Nothing needs you most right now, so there is no badge.";
  return `Now: ${n} pull request${n === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} you most, so it shows ${n}.`;
}
