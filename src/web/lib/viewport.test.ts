import { describe, expect, test } from "bun:test";

import { keyboardOpen, sheetBox } from "./viewport";

const vv = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });

describe("sheetBox", () => {
  test("follows the visual viewport", () => {
    expect(sheetBox(vv(544, 0))).toEqual({ top: 0, height: 544 });
    // iOS scrolls the layout viewport behind the keyboard: the sheet follows the top too.
    expect(sheetBox(vv(544, 36))).toEqual({ top: 36, height: 544 });
  });
  test("leaves it to CSS without a visual viewport, or while zoomed", () => {
    expect(sheetBox(null)).toBeNull();
    expect(sheetBox(vv(300, 120, 2))).toBeNull();
    expect(sheetBox(vv(0))).toBeNull();
  });
});

describe("keyboardOpen", () => {
  test("a short visual viewport is a keyboard, a toolbar's few pixels are not", () => {
    expect(keyboardOpen(vv(544), 844)).toBe(true);
    expect(keyboardOpen(vv(800), 844)).toBe(false);
    expect(keyboardOpen(null, 844)).toBe(false);
    expect(keyboardOpen(vv(300, 0, 2), 844)).toBe(false);
  });
});
