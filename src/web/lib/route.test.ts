import { describe, expect, test } from "bun:test";

import { batchDeepLink, prDeepLink } from "../../kit/sticky.ts";
import {
  MAX_LINK_PRS,
  formatRoute,
  fragmentOf,
  isLinkRoute,
  linkNumbers,
  parseRoute,
  viewFor,
  viewOf,
  type Route,
} from "./route";

describe("parseRoute", () => {
  test("the three views and the setup", () => {
    expect(parseRoute("")).toEqual({ view: "list" });
    expect(parseRoute("#")).toEqual({ view: "list" });
    expect(parseRoute("#/")).toEqual({ view: "list" });
    expect(parseRoute("#/chrono")).toEqual({ view: "chrono" });
    expect(parseRoute("#/board")).toEqual({ view: "board" });
    expect(parseRoute("#/board/")).toEqual({ view: "board" });
    expect(parseRoute("#/setup")).toEqual({ view: "setup" });
    expect(parseRoute("#/setup/signing")).toEqual({ view: "setup", step: "signing" });
    expect(parseRoute("#/setup/shared-policy")).toEqual({ view: "setup", step: "shared-policy" });
    expect(parseRoute("#/setup/nonsense")).toEqual({ view: "setup" });
  });

  test("the setup page of one repo of several (ADR 0007): the host only off github.com", () => {
    expect(parseRoute("#/setup/tallyho/field-app/shared-policy")).toEqual({
      view: "setup",
      repo: "tallyho/field-app",
      step: "shared-policy",
    });
    expect(parseRoute("#/setup/tallyho/field-app")).toEqual({
      view: "setup",
      repo: "tallyho/field-app",
    });
    expect(parseRoute("#/setup/Acme.GHE.com/finance/ledger/signing")).toEqual({
      view: "setup",
      repo: "acme.ghe.com/finance/ledger",
      step: "signing",
    });
    // A repo named like a step: a repo, as owners have no dots.
    expect(parseRoute("#/setup/acme/signing")).toEqual({ view: "setup", repo: "acme/signing" });
    expect(parseRoute("#/setup/acme.ghe.com/acme/signing")).toEqual({
      view: "setup",
      repo: "acme.ghe.com/acme/signing",
    });
    for (const bad of ["#/setup/a/b/c/d", "#/setup/not a/repo", "#/setup/x.y/repo"])
      expect(parseRoute(bad)).toEqual({ view: "setup" });
  });

  test("a deep link to a PR", () => {
    expect(parseRoute("#/pr/tallyho/fieldbook/482")).toEqual({
      view: "pr",
      host: "github.com",
      repo: "tallyho/fieldbook",
      number: 482,
    });
  });

  test("a deep link to a batch: numbers in order, duplicates dropped", () => {
    expect(parseRoute("#/batch/tallyho/fieldbook/482,476,482,485")).toEqual({
      view: "batch",
      host: "github.com",
      repo: "tallyho/fieldbook",
      numbers: [482, 476, 485],
    });
    expect(parseRoute("#/batch/tallyho/fieldbook/7")).toEqual({
      view: "batch",
      host: "github.com",
      repo: "tallyho/fieldbook",
      numbers: [7],
    });
  });

  test("a broken deep link is the list", () => {
    expect(parseRoute("#/pr/tallyho/fieldbook/x")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/tallyho/482")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/a/b/0")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/a b/c/1")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/%E0%A4%A/c/1")).toEqual({ view: "list" });
    expect(parseRoute("#/batch/a/b/")).toEqual({ view: "list" });
    expect(parseRoute("#/batch/a/b/1,x")).toEqual({ view: "list" });
    const many = Array.from({ length: MAX_LINK_PRS + 1 }, (_, i) => i + 1).join(",");
    expect(parseRoute(`#/batch/a/b/${many}`)).toEqual({ view: "list" });
  });

  test("the pairing fragment and anything unknown are the list", () => {
    expect(parseRoute("#host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc")).toEqual({ view: "list" });
    expect(parseRoute("#token=abc")).toEqual({ view: "list" });
    expect(parseRoute("#/epics")).toEqual({ view: "list" });
  });

  test("a route combined with the pairing: the parameters after it are ignored", () => {
    expect(parseRoute("#/pr/a/b/3?host=ws%3A%2F%2F127.0.0.1%3A4518&token=abc")).toEqual({
      view: "pr",
      host: "github.com",
      repo: "a/b",
      number: 3,
    });
    expect(parseRoute("#/batch/a/b/3,4&token=abc")).toEqual({
      view: "batch",
      host: "github.com",
      repo: "a/b",
      numbers: [3, 4],
    });
  });
});

test("#/forward carries its one to=, unchecked; a missing or repeated one is null", () => {
  expect(parseRoute("#/forward?to=https://nod.example.test:8445")).toEqual({
    view: "forward",
    to: "https://nod.example.test:8445",
  });
  expect(parseRoute("#/forward?to=https%3A%2F%2Fnod.example.test")).toEqual({
    view: "forward",
    to: "https://nod.example.test",
  });
  expect(parseRoute("#/forward?to=javascript:alert(1)")).toEqual({
    view: "forward",
    to: "javascript:alert(1)",
  });
  expect(parseRoute("#/forward")).toEqual({ view: "forward", to: null });
  expect(parseRoute("#/forward?to=a&to=b")).toEqual({ view: "forward", to: null });
  expect(viewOf({ view: "forward", to: null })).toBe("list");
});

describe("fragmentOf", () => {
  test("splits a route from its parameters", () => {
    expect(fragmentOf("#/pr/a/b/1?token=t")).toEqual({ path: "/pr/a/b/1", params: "token=t" });
    expect(fragmentOf("#/pr/a/b/1&token=t")).toEqual({ path: "/pr/a/b/1", params: "token=t" });
    expect(fragmentOf("#/board")).toEqual({ path: "/board", params: "" });
    expect(fragmentOf("#host=h&token=t")).toEqual({ path: "", params: "host=h&token=t" });
    expect(fragmentOf("")).toEqual({ path: "", params: "" });
  });
});

describe("formatRoute", () => {
  test("round trips", () => {
    const routes: Route[] = [
      { view: "list" },
      { view: "chrono" },
      { view: "board" },
      { view: "setup" },
      { view: "setup", step: "enforced" },
      { view: "setup", repo: "tallyho/field-app" },
      { view: "setup", repo: "acme.ghe.com/finance/ledger", step: "signing" },
      { view: "forward", to: "https://nod.example.test:8445" },
      { view: "forward", to: "odd & ?#= value" },
      { view: "forward", to: null },
      { view: "pr", host: "github.com", repo: "tallyho/fieldbook", number: 7 },
      { view: "batch", host: "github.com", repo: "tallyho/fieldbook", numbers: [7, 3] },
    ];
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
    expect(formatRoute({ view: "list" })).toBe("#/");
  });

  test("the kit's links parse to the same routes", () => {
    const pr = new URL(prDeepLink("https://ui.nod.frebreco.de/next", "acme/widgets", 12));
    expect(parseRoute(pr.hash)).toEqual({
      view: "pr",
      host: "github.com",
      repo: "acme/widgets",
      number: 12,
    });
    const batch = new URL(batchDeepLink("https://ui.nod.frebreco.de", "acme/widgets", [12, 9]));
    expect(parseRoute(batch.hash)).toEqual({
      view: "batch",
      host: "github.com",
      repo: "acme/widgets",
      numbers: [12, 9],
    });
    expect(
      formatRoute({ view: "batch", host: "github.com", repo: "acme/widgets", numbers: [12, 9] }),
    ).toBe(batch.hash);
  });

  test("a link off github.com carries its host; github.com links stay as they were", () => {
    const ghe = new URL(
      prDeepLink("https://ui.nod.frebreco.de", "acme/widgets", 12, "https://ACME.ghe.com/"),
    );
    expect(ghe.hash).toBe("#/pr/acme.ghe.com/acme/widgets/12");
    expect(parseRoute(ghe.hash)).toEqual({
      view: "pr",
      host: "acme.ghe.com",
      repo: "acme/widgets",
      number: 12,
    });
    const ghes = new URL(
      batchDeepLink("https://ui.example.test", "acme/widgets", [3, 4], "git.example.test:8443"),
    );
    expect(parseRoute(ghes.hash)).toEqual({
      view: "batch",
      host: "git.example.test:8443",
      repo: "acme/widgets",
      numbers: [3, 4],
    });
    expect(formatRoute(parseRoute(ghes.hash))).toBe(ghes.hash);
    // github.com named or not: the same route, and the link without the host.
    expect(prDeepLink("https://ui.example.test", "acme/widgets", 1, "https://github.com")).toBe(
      "https://ui.example.test/#/pr/acme/widgets/1",
    );
    expect(parseRoute("#/pr/github.com/acme/widgets/1")).toEqual(parseRoute("#/pr/acme/widgets/1"));
    expect(formatRoute({ view: "pr", host: "acme.ghe.com", repo: "mona_acme/x", number: 2 })).toBe(
      "#/pr/acme.ghe.com/mona_acme/x/2",
    );
    // A host segment that is not a host is no route.
    expect(parseRoute("#/pr/not%20a%20host/acme/widgets/1")).toEqual({ view: "list" });
    expect(parseRoute("#/pr/a/b/c/d/1")).toEqual({ view: "list" });
  });

  test("deep links and the setup sit over the list", () => {
    expect(viewOf({ view: "pr", host: "github.com", repo: "a/b", number: 1 })).toBe("list");
    expect(viewOf({ view: "batch", host: "github.com", repo: "a/b", numbers: [1] })).toBe("list");
    expect(viewOf({ view: "setup" })).toBe("list");
    expect(viewOf({ view: "chrono" })).toBe("chrono");
    expect(isLinkRoute({ view: "setup" })).toBe(false);
    expect(linkNumbers({ view: "pr", host: "github.com", repo: "a/b", number: 5 })).toEqual([5]);
  });
});

describe("viewFor", () => {
  test("a phone shows the list for the board, a desktop the board", () => {
    expect(viewFor({ view: "board" }, true)).toBe("list");
    expect(viewFor({ view: "board" }, false)).toBe("board");
  });

  test("every other route shows what it shows anywhere", () => {
    for (const phone of [true, false]) {
      expect(viewFor({ view: "list" }, phone)).toBe("list");
      expect(viewFor({ view: "chrono" }, phone)).toBe("chrono");
      expect(viewFor({ view: "setup" }, phone)).toBe("list");
    }
  });

  test("the route itself stays valid: it parses and formats as before", () => {
    expect(formatRoute(parseRoute("#/board"))).toBe("#/board");
  });
});
