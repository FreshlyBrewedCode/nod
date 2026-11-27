/**
 * The list's shared state, for rows and the panel deep in the tree: focus,
 * selection, expanded clusters, the panel, and the actions on a row. Owned by
 * `Dashboard` (`components/dashboard.tsx`).
 */

import { createContext, useContext } from "react";

import type {
  GitHubInfo,
  Person,
  PrId,
  PrView,
  RepoInfo,
  RepoKey,
  Snapshot,
} from "../../shared/protocol";
import type { FocusKey } from "@/lib/focus";
import type { Selection } from "@/lib/selection";

export interface DashboardState {
  readonly snapshot: Snapshot;
  /** Every repo `nod serve` reads (ADR 0007). */
  readonly repos: ReadonlyArray<RepoInfo>;
  /** The repo chip's words per repo once there are several; empty with one (no chip). */
  readonly chips: ReadonlyMap<RepoKey, string>;
  /** The GitHub host a PR's repo is on. */
  githubOf(pr: Pick<PrView, "repo">): GitHubInfo;
  /** My login on the first repo's host (`snapshot.me`): for what is no one repo's. */
  readonly me: string;
  /** My login in a PR's repo, on its host: for "you" and "mine to fill" on a PR. */
  meIn(pr: Pick<PrView, "repo">): string;
  readonly people: ReadonlyArray<Person>;
  readonly focus: FocusKey | null;
  /** Focus a row; `open` also opens the panel on it. */
  focusRow(key: FocusKey, options?: { open?: boolean }): void;
  readonly selection: Selection;
  toggleSelected(pr: PrId): void;
  clearSelection(): void;
  readonly expanded: ReadonlySet<string>;
  toggleCluster(id: string): void;
  readonly panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  /** "Got it" on an FYI: unsigned; the row leaves the lane right away. */
  ackFyi(pr: PrView): void;
  /** THE way into signing and approving (the batch dialog seam), by PR id: a batch may span repos. */
  openBatch(prs: ReadonlyArray<PrId>): void;
  /**
   * My key is enrolled and active in the PR's repo: I sign. false: no key,
   * or a pending or not enrolled one there; my asks are GitHub approvals
   * (ADR 0006).
   */
  signingIn(pr: Pick<PrView, "repo">): boolean;
}

export const DashboardContext = createContext<DashboardState | null>(null);

export function useDashboard(): DashboardState {
  const state = useContext(DashboardContext);
  if (!state) throw new Error("useDashboard needs the Dashboard above it");
  return state;
}
