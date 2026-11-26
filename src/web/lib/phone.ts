/**
 * What counts as a phone: one breakpoint, defined once. `styles.css` has the
 * same number in `@custom-variant phone` (`phone:…` utilities); a test keeps
 * the two equal. Below it the layout is a phone's: one column, touch-sized
 * controls (docs/design/design.md, "Phone").
 */

/** The first width that is not a phone (tailwind's `sm`). */
export const PHONE_BREAKPOINT = 640;

/** The media query for a phone, in the range syntax `matchMedia` and CSS share. */
export const PHONE_QUERY = `(width < ${PHONE_BREAKPOINT}px)`;

/** Whether a viewport this wide is a phone's. */
export function isPhoneWidth(width: number): boolean {
  return width < PHONE_BREAKPOINT;
}

/**
 * Whether the page runs as a home-screen app (`display: standalone` in the
 * manifest): no address bar, and on iOS a storage of its own, apart from
 * Safari's, so it needs its own pairing. `navigator.standalone` is iOS
 * Safari's flag; the media query is everyone else's.
 */
export function isStandalone(win: {
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  readonly navigator?: unknown;
}): boolean {
  if ((win.navigator as { standalone?: unknown } | undefined)?.standalone === true) return true;
  try {
    return win.matchMedia?.("(display-mode: standalone)").matches ?? false;
  } catch {
    return false;
  }
}
