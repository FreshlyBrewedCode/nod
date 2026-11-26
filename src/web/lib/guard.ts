/**
 * Two guards for the pages that must not be tricked into a tap (ADR 0005 §7):
 *
 * - **Framed.** The web app never runs inside another page (`isFramed`): it
 *   has the passphrase field, and the confirmation that remembers a host.
 *   The hosted UI is served by GitHub Pages, which sends no
 *   `X-Frame-Options` or `frame-ancestors` and takes no header config, and a
 *   `<meta>` CSP cannot carry `frame-ancestors`; so the app itself refuses.
 *   The named host's page is also refused by its headers
 *   (`src/server/static-files.ts`).
 * - **Armed.** "Remember this address" takes a tap only after the page has
 *   been visible for `ARM_MS` in one go: since it mounted, since its host
 *   changed (the page is keyed on it), or since it was last hidden. A page
 *   opened in the background, or a tap aimed at where the button will
 *   appear (a double click on the page before), lands on a disabled button.
 *   The clock is the caller's (`now`), so this is tested without timers.
 */

/** How long the page must have been visible before a guarded button takes a tap. */
export const ARM_MS = 1000;

/** When the page became visible and stayed so, or null while it is hidden. */
export type VisibleSince = number | null;

/** After a visibility change (or on mount): the start of this visible stretch, if any. */
export function visibleSince(previous: VisibleSince, visible: boolean, now: number): VisibleSince {
  return visible ? (previous ?? now) : null;
}

/**
 * How long until the guarded button takes a tap: 0 when it does now, null
 * while the page is hidden (it never arms while hidden).
 */
export function untilArmed(since: VisibleSince, now: number): number | null {
  if (since === null) return null;
  return Math.max(0, since + ARM_MS - now);
}

/** Whether this window is inside another page's frame. */
export function isFramed(win: { readonly top: unknown; readonly self: unknown }): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}
