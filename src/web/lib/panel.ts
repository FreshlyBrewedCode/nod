/**
 * The list's detail panel: its width rules (r3: 380–900 px, default 500, at
 * most about half the window) and the breakpoint where its layout changes
 * (from 620 px: horizontal journey, "Look at", sections open).
 */

export const PANEL_MIN = 380;
export const PANEL_MAX = 900;
export const PANEL_DEFAULT = 500;
export const PANEL_WIDE_FROM = 620;

/** The widest the panel may be in this window: half of it, within [min, max]. */
export function panelMax(windowWidth: number): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(windowWidth / 2)));
}

/** A width (stored, dragged, or broken) made valid for this window. */
export function clampPanelWidth(width: unknown, windowWidth: number): number {
  const w = typeof width === "number" && Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT;
  return Math.max(PANEL_MIN, Math.min(panelMax(windowWidth), w));
}

export function isWidePanel(width: number): boolean {
  return width >= PANEL_WIDE_FROM;
}

/** What the browser remembers about the panel. */
export interface PanelPrefs {
  readonly open: boolean;
  readonly width: number;
}

export const DEFAULT_PANEL: PanelPrefs = { open: false, width: PANEL_DEFAULT };

/** Stored prefs, defaulted field by field (closed and 500 px when unknown). */
export function readPanelPrefs(value: unknown): PanelPrefs {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<string, unknown>>;
  return {
    open: typeof v.open === "boolean" ? v.open : DEFAULT_PANEL.open,
    width:
      typeof v.width === "number" && Number.isFinite(v.width)
        ? Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(v.width)))
        : DEFAULT_PANEL.width,
  };
}
