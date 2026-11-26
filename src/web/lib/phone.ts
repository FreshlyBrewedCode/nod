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
