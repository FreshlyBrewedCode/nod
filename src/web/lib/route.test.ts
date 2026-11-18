import { describe, expect, test } from "bun:test";

import { formatRoute, parseRoute, viewOf, type Route } from "./route";

describe("parseRoute", () => {
  test("the three views", () => {
    expect(parseRoute("")).toEqual({ view: "list" });
    expect(parseRoute("#")).toEqual({ view: "list" });
    expect(parseRoute("#/")).toEqual({ view: "list" });
    expect(parseRoute("#/chrono")).toEqual({ view: "chrono" });
    expect(parseRoute("#/board")).toEqual({ view: "board" });
    expect(parseRoute("#/board/")).toEqual({ view: "board" });
  });

  test("a deep link to a PR", () => {
    expect(parseRoute("#/pr/tallyho/fieldbook/482")).toEqual({
      view: "pr",
      repo: "tallyho/fieldbook",
      number: 482,
    });
  });

  test("a broken deep link is the list", () => {
    expect(parseRoute("#/pr/tallyho/fieldbook/x")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/tallyho/482")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/a/b/0")).toEqual({ view: "list" });
  });

  test("the pairing fragment and anything unknown are the list", () => {
    expect(parseRoute("#host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc")).toEqual({ view: "list" });
    expect(parseRoute("#token=abc")).toEqual({ view: "list" });
    expect(parseRoute("#/epics")).toEqual({ view: "list" });
  });
});

describe("formatRoute", () => {
  test("round trips", () => {
    const routes: Route[] = [
      { view: "list" },
      { view: "chrono" },
      { view: "board" },
      { view: "pr", repo: "tallyho/fieldbook", number: 7 },
    ];
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
    expect(formatRoute({ view: "list" })).toBe("#/");
  });

  test("a deep link shows the list", () => {
    expect(viewOf({ view: "pr", repo: "a/b", number: 1 })).toBe("list");
    expect(viewOf({ view: "chrono" })).toBe("chrono");
  });
});
