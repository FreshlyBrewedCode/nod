import { describe, expect, test } from "bun:test";

import {
  chipLabels,
  idOf,
  parsePrId,
  parseRepoKey,
  prId,
  repoKey,
  sameRepo,
} from "./repo-key";

describe("repo keys (ADR 0007)", () => {
  test("github.com leaves the host out; every other host is named, lowercase", () => {
    expect(repoKey("github.com", "tallyho/fieldbook")).toBe("tallyho/fieldbook");
    expect(repoKey("GitHub.com", "tallyho/fieldbook")).toBe("tallyho/fieldbook");
    expect(repoKey("Acme.GHE.com", "finance/ledger")).toBe("acme.ghe.com/finance/ledger");
    expect(repoKey("git.example.test", "a/b")).toBe("git.example.test/a/b");
  });

  test("parsing: the host and owner/name, or null", () => {
    expect(parseRepoKey("tallyho/fieldbook")).toEqual({
      host: "github.com",
      name: "tallyho/fieldbook",
    });
    expect(parseRepoKey("acme.ghe.com/finance/ledger")).toEqual({
      host: "acme.ghe.com",
      name: "finance/ledger",
    });
    for (const bad of ["", "fieldbook", "a/b/c/d", "a b/c", "not a host!/a/b", "/a/b", "a/"])
      expect(parseRepoKey(bad)).toBeNull();
  });

  test("the same owner/name on two hosts is two repos; case does not matter", () => {
    expect(sameRepo("acme/api", "ACME/Api")).toBe(true);
    expect(sameRepo("acme/api", "acme.ghe.com/acme/api")).toBe(false);
    expect(sameRepo(null, "acme/api")).toBe(false);
  });

  test("a PR id is <repo key>#<n>, and back", () => {
    expect(prId("tallyho/fieldbook", 482)).toBe("tallyho/fieldbook#482");
    expect(idOf({ repo: "acme.ghe.com/finance/ledger", number: 57 })).toBe(
      "acme.ghe.com/finance/ledger#57",
    );
    expect(parsePrId("acme.ghe.com/finance/ledger#57")).toEqual({
      repo: "acme.ghe.com/finance/ledger",
      number: 57,
    });
    for (const bad of ["482", "a/b#", "a/b#0", "a/b#x", "nope#1"]) expect(parsePrId(bad)).toBeNull();
  });
});

describe("the repo chip", () => {
  test("the shortest name that still tells the repos apart", () => {
    expect([
      ...chipLabels([
        "tallyho/fieldbook",
        "tallyho/field-app",
        "acme.ghe.com/finance/ledger",
      ]).values(),
    ]).toEqual(["fieldbook", "field-app", "ledger"]);
    expect([...chipLabels(["acme/api", "tallyho/api", "tallyho/web"]).values()]).toEqual([
      "acme/api",
      "tallyho/api",
      "web",
    ]);
    // The same owner/name on two hosts: only the key tells them apart.
    expect([...chipLabels(["acme/api", "acme.ghe.com/acme/api"]).values()]).toEqual([
      "acme/api",
      "acme.ghe.com/acme/api",
    ]);
  });
});
