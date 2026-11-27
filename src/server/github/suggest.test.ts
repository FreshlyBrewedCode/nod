import { expect, test } from "bun:test";

import { parseRepoInput, rankSuggestions, type RepoSuggestion } from "./suggest";

test("what one may type for a repo", () => {
  const gh = (name: string) => ({ host: "github.com", name });
  expect(parseRepoInput("tallyho/fieldbook")).toEqual(gh("tallyho/fieldbook"));
  expect(parseRepoInput(" tallyho/fieldbook.git ")).toEqual(gh("tallyho/fieldbook"));
  expect(parseRepoInput("https://github.com/tallyho/fieldbook")).toEqual(gh("tallyho/fieldbook"));
  expect(parseRepoInput("https://github.com/tallyho/fieldbook/pull/482/files")).toEqual(
    gh("tallyho/fieldbook"),
  );
  expect(parseRepoInput("git@github.com:tallyho/fieldbook.git")).toEqual(gh("tallyho/fieldbook"));
  expect(parseRepoInput("acme.ghe.com/finance/ledger")).toEqual({
    host: "acme.ghe.com",
    name: "finance/ledger",
  });
  expect(parseRepoInput("https://ACME.ghe.com/finance/ledger.git")).toEqual({
    host: "acme.ghe.com",
    name: "finance/ledger",
  });
  expect(parseRepoInput("https://git.example.test:8443/acme/widgets")).toEqual({
    host: "git.example.test:8443",
    name: "acme/widgets",
  });
  for (const bad of [
    "",
    "fieldbook",
    "a/b/c/d",
    "tallyho/..",
    "https://api.github.com/repos/x",
    "git@work:acme/widgets", // an ssh alias: nod cannot tell its host
    "gist.github.com/tallyho/x",
  ])
    expect(parseRepoInput(bad)).toBeNull();
});

test("suggestions: review requests first, then my own PRs, then the name", () => {
  const s = (key: string, myOpenPrs: number, reviewRequests: number) => ({
    suggestion: {
      key,
      name: key,
      github: { host: "github.com", webUrl: "https://github.com" },
      myOpenPrs,
      reviewRequests,
    } satisfies RepoSuggestion,
  });
  expect(
    rankSuggestions([s("b/b", 5, 0), s("a/a", 1, 2), s("c/c", 0, 2), s("d/d", 9, 0)]).map(
      (x) => x.suggestion.key,
    ),
  ).toEqual(["a/a", "c/c", "d/d", "b/b"]);
});
