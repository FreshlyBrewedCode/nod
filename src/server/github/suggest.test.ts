import { expect, test } from "bun:test";

import type { RepoSuggestion } from "../../shared/protocol";
import { rankSuggestions } from "./suggest";

test("suggestions: review requests first, then my own PRs, then the name", () => {
  const s = (key: string, myOpenPrs: number, reviewRequests: number): RepoSuggestion => ({
    key,
    name: key,
    github: { host: "github.com", webUrl: "https://github.com" },
    myOpenPrs,
    reviewRequests,
  });
  expect(
    rankSuggestions([s("b/b", 5, 0), s("a/a", 1, 2), s("c/c", 0, 2), s("d/d", 9, 0)]).map(
      (x) => x.key,
    ),
  ).toEqual(["a/a", "c/c", "d/d", "b/b"]);
});
