import { describe, expect, test } from "bun:test";

import { ago, clockTime, countdown, duration, sinceText, whenText } from "./time";

// Wed 18 Nov 2026, 14:20 UTC: the mockup's "now".
const NOW = Date.UTC(2026, 10, 18, 14, 20);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("ago", () => {
  test("now, minutes, hours, days", () => {
    expect(ago(NOW - 20_000, NOW)).toBe("now");
    expect(ago(NOW - 6 * MIN, NOW)).toBe("6m");
    expect(ago(NOW - 59 * MIN, NOW)).toBe("59m");
    expect(ago(NOW - 70 * MIN, NOW)).toBe("1h");
    expect(ago(NOW - 100 * MIN, NOW)).toBe("2h");
    expect(ago(NOW - 19 * HOUR, NOW)).toBe("19h");
    expect(ago(NOW - 23.5 * HOUR, NOW)).toBe("1d");
    expect(ago(NOW - 80 * HOUR, NOW)).toBe("3d");
  });

  test("the future reads as now", () => {
    expect(ago(NOW + HOUR, NOW)).toBe("now");
  });
});

describe("duration", () => {
  test("whole units, rounded down, singular and plural", () => {
    expect(duration(10_000)).toBe("1 minute");
    expect(duration(12 * MIN)).toBe("12 minutes");
    expect(duration(5 * HOUR + 40 * MIN)).toBe("5 hours");
    expect(duration(HOUR)).toBe("1 hour");
    expect(duration(50 * HOUR)).toBe("2 days");
  });
});

describe("clock and calendar", () => {
  test("the wall clock in the viewer's zone", () => {
    expect(clockTime(NOW, 0)).toBe("14:20");
    expect(clockTime(NOW, 60)).toBe("15:20");
    expect(clockTime(NOW - 15 * HOUR, -300)).toBe("18:20");
  });

  test("the chronological time column follows the buckets", () => {
    expect(whenText(NOW - 6 * MIN, NOW, 0)).toBe("6m");
    expect(whenText(NOW - 5 * HOUR, NOW, 0)).toBe("5h");
    expect(whenText(Date.UTC(2026, 10, 17, 19, 5), NOW, 0)).toBe("19:05");
    expect(whenText(Date.UTC(2026, 10, 16, 9, 0), NOW, 0)).toBe("Mon");
    expect(whenText(Date.UTC(2026, 10, 2, 9, 0), NOW, 0)).toBe("2 Nov");
  });

  test("a point in time for a sentence", () => {
    expect(sinceText(Date.UTC(2026, 10, 18, 9, 10), NOW, 0)).toBe("today 09:10");
    expect(sinceText(Date.UTC(2026, 10, 17, 17, 42), NOW, 0)).toBe("yesterday 17:42");
    expect(sinceText(Date.UTC(2026, 10, 15, 17, 42), NOW, 0)).toBe("Sun 17:42");
    expect(sinceText(Date.UTC(2026, 9, 30, 8, 0), NOW, 0)).toBe("30 Oct");
  });
});

describe("countdown", () => {
  test("minutes and seconds, hours when needed, never negative", () => {
    expect(countdown(NOW + 14 * MIN + 48_000, NOW)).toBe("14:48");
    expect(countdown(NOW + 5_000, NOW)).toBe("0:05");
    expect(countdown(NOW + HOUR, NOW)).toBe("1:00:00");
    expect(countdown(NOW - 1, NOW)).toBe("0:00");
    expect(countdown(NOW + 400, NOW)).toBe("0:01");
  });
});
