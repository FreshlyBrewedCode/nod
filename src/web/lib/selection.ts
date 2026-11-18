/**
 * The PRs ticked for signing (checkbox, `x`, "Add to batch"), in the order
 * they were ticked. Only PRs that need me can be in it (tiers 1–2): `keep`
 * drops the ones that stopped needing me after a snapshot.
 */

export type Selection = ReadonlyArray<number>;

export type SelectionAction =
  | { readonly t: "toggle"; readonly pr: number }
  | { readonly t: "add"; readonly prs: ReadonlyArray<number> }
  | { readonly t: "clear" }
  /** Keep only these (the PRs that may still be selected). */
  | { readonly t: "keep"; readonly prs: ReadonlyArray<number> };

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.t) {
    case "toggle":
      return state.includes(action.pr)
        ? state.filter((n) => n !== action.pr)
        : [...state, action.pr];
    case "add": {
      const added = action.prs.filter((n, i) => !state.includes(n) && action.prs.indexOf(n) === i);
      return added.length ? [...state, ...added] : state;
    }
    case "clear":
      return state.length ? [] : state;
    case "keep": {
      const kept = state.filter((n) => action.prs.includes(n));
      return kept.length === state.length ? state : kept;
    }
  }
}
