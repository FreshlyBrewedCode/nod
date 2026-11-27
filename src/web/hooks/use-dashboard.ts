/**
 * The list's shared state, for rows and the panel deep in the tree: focus,
 * selection, expanded clusters, the panel, and the actions on a row. Owned by
 * `Dashboard` (`components/dashboard.tsx`).
 */

import { createContext, useContext } from "react";

import type { GitHubInfo, Person, Snapshot } from "../../shared/protocol";
import type { FocusKey } from "@/lib/focus";
import type { Selection } from "@/lib/selection";

export interface DashboardState {
  readonly snapshot: Snapshot;
  /** The GitHub host the snapshot's repo is on. */
  readonly github: GitHubInfo;
  readonly me: string;
  readonly people: ReadonlyArray<Person>;
  readonly focus: FocusKey | null;
  /** Focus a row; `open` also opens the panel on it. */
  focusRow(key: FocusKey, options?: { open?: boolean }): void;
  readonly selection: Selection;
  toggleSelected(pr: number): void;
  clearSelection(): void;
  readonly expanded: ReadonlySet<string>;
  toggleCluster(id: string): void;
  readonly panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  /** "Got it" on an FYI: unsigned; the row leaves the lane right away. */
  ackFyi(pr: number): void;
  /** THE way into signing and approving (the batch dialog seam). */
  openBatch(prs: ReadonlyArray<number>): void;
  /**
   * My key is enrolled and active in this repo: I sign. false: no key, or a
   * pending or not enrolled one; my asks are GitHub approvals (ADR 0006).
   */
  readonly signing: boolean;
}

export const DashboardContext = createContext<DashboardState | null>(null);

export function useDashboard(): DashboardState {
  const state = useContext(DashboardContext);
  if (!state) throw new Error("useDashboard needs the Dashboard above it");
  return state;
}
