/**
 * Where a full-screen sheet sits while an on-screen keyboard is open. iOS and
 * Android Chrome leave the layout viewport as it was and shrink only the
 * *visual* viewport (`window.visualViewport`): `100dvh` does not follow the
 * keyboard, and a docked field at the bottom would be covered. The sheet is
 * therefore placed on the visual viewport. Pure; `hooks/use-visual-viewport.ts`
 * reads the numbers.
 */

export interface ViewportBox {
  readonly offsetTop: number;
  readonly height: number;
  readonly scale: number;
}

/** A visual viewport this much shorter than the layout one is a keyboard, not a toolbar. */
export const KEYBOARD_MIN = 120;

/**
 * The top and height a sheet takes, or null when CSS (`100dvh`) is right: no
 * visual viewport, or the user has pinch-zoomed (the visual viewport is then a
 * window into the page, not the screen).
 */
export function sheetBox(
  vv: ViewportBox | null,
): { readonly top: number; readonly height: number } | null {
  if (!vv || vv.scale !== 1 || vv.height <= 0) return null;
  return { top: Math.max(0, vv.offsetTop), height: vv.height };
}

/** Whether the visible area is much shorter than the layout viewport: a keyboard is up. */
export function keyboardOpen(vv: ViewportBox | null, layoutHeight: number): boolean {
  return vv !== null && vv.scale === 1 && layoutHeight - vv.height >= KEYBOARD_MIN;
}
