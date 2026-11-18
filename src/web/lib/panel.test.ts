import { describe, expect, test } from "bun:test";

import { clampPanelWidth, isWidePanel, panelMax, readPanelPrefs } from "./panel";

describe("panel width", () => {
  test("at most half the window, within 380–900", () => {
    expect(panelMax(1440)).toBe(720);
    expect(panelMax(2400)).toBe(900);
    expect(panelMax(600)).toBe(380);
  });

  test("clamp", () => {
    expect(clampPanelWidth(500, 1440)).toBe(500);
    expect(clampPanelWidth(700.4, 1440)).toBe(700);
    expect(clampPanelWidth(860, 1440)).toBe(720);
    expect(clampPanelWidth(200, 1440)).toBe(380);
    expect(clampPanelWidth(860, 2400)).toBe(860);
    expect(clampPanelWidth(5000, 2400)).toBe(900);
  });

  test("anything that is not a width is the default", () => {
    expect(clampPanelWidth(undefined, 1440)).toBe(500);
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(500);
    expect(clampPanelWidth("700", 1440)).toBe(500);
  });

  test("wide from 620 px", () => {
    expect(isWidePanel(619)).toBe(false);
    expect(isWidePanel(620)).toBe(true);
  });
});

describe("stored prefs", () => {
  test("closed and 500 px by default; broken fields fall back one by one", () => {
    expect(readPanelPrefs(null)).toEqual({ open: false, width: 500 });
    expect(readPanelPrefs({ open: true })).toEqual({ open: true, width: 500 });
    expect(readPanelPrefs({ open: "yes", width: 640 })).toEqual({ open: false, width: 640 });
    expect(readPanelPrefs({ open: true, width: 2000 })).toEqual({ open: true, width: 900 });
  });
});
