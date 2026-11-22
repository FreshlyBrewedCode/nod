/**
 * The pure part of how a phone's back gesture closes a full-screen page or
 * sheet. Opening one pushes a history entry that carries its layer (1 for the
 * first, 2 for a sheet over a detail page) in `history.state`; the address
 * does not change, so there is no route for it (a reload shows the list, and
 * the deep links of `lib/route.ts` stay what they are). The browser's back
 * pops the entry, and a layer that is deeper than the entry it landed on is
 * closed. `hooks/use-back-stop.ts` does the `history` calls.
 */

const KEY = "nodLayer";

/** How many of our overlays the history entry with this state has open: 0 for any other. */
export function layerOf(state: unknown): number {
  const layer = (state as Record<string, unknown> | null)?.[KEY];
  return typeof layer === "number" && Number.isInteger(layer) && layer > 0 ? layer : 0;
}

/** The `history.state` of the entry an overlay at this layer pushes. */
export function layerState(layer: number): Record<string, number> {
  return { [KEY]: layer };
}

/**
 * What a popstate means to an open overlay at layer `mine`, the entry it
 * landed on being at layer `now`:
 * - `stay`: the entry is the overlay's or one above it;
 * - `close`: the entry is below it, the overlay is dismissed;
 * - `restore`: the same, but it must not be dismissed now (a sign request is
 *   in flight): its entry is pushed again.
 */
export function onPop(mine: number, now: number, blocked: boolean): "stay" | "close" | "restore" {
  if (now >= mine) return "stay";
  return blocked ? "restore" : "close";
}

/**
 * A forward into an entry deeper than what is open (a page or sheet that is
 * gone, whose in-memory state cannot come back) is undone by a back: true
 * when `now` is deeper than the `open` overlays.
 */
export function isDeadForward(open: number, now: number): boolean {
  return now > open;
}
