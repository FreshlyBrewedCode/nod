import { describe, expect, test } from "bun:test";

import {
  chipLabels,
  idOf,
  parsePrId,
  parseRepoInput,
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
    for (const bad of ["482", "a/b#", "a/b#0", "a/b#x", "nope#1"])
      expect(parsePrId(bad)).toBeNull();
  });
});

describe("a repo as a person names it (adding one)", () => {
  const key = (input: string) => parseRepoInput(input)?.key ?? null;

  test("owner/name is on github.com; host/owner/name names its host", () => {
    expect(parseRepoInput(" tallyho/fieldbook ")).toEqual({
      host: "github.com",
      name: "tallyho/fieldbook",
      key: "tallyho/fieldbook",
    });
    expect(key("Acme.GHE.com/finance/ledger")).toBe("acme.ghe.com/finance/ledger");
    expect(key("git.example.test:8443/a/b")).toBe("git.example.test:8443/a/b");
    expect(key("github.com/tallyho/fieldbook")).toBe("tallyho/fieldbook");
  });

  test("a link to the repo or anything in it, a clone URL, an ssh remote", () => {
    expect(key("https://github.com/tallyho/fieldbook")).toBe("tallyho/fieldbook");
    expect(key("https://github.com/tallyho/fieldbook/")).toBe("tallyho/fieldbook");
    expect(key("https://github.com/tallyho/fieldbook.git")).toBe("tallyho/fieldbook");
    expect(key("https://acme.ghe.com/finance/ledger/pull/57#discussion")).toBe(
      "acme.ghe.com/finance/ledger",
    );
    expect(key("https://github.com/tallyho/fieldbook?tab=readme")).toBe("tallyho/fieldbook");
    expect(key("git@github.com:tallyho/fieldbook.git")).toBe("tallyho/fieldbook");
    expect(key("ssh://git@acme.ghe.com:22/finance/ledger.git")).toBe("acme.ghe.com/finance/ledger");
  });

  test("anything else names no repo", () => {
    for (const bad of [
      "",
      "fieldbook",
      "a/b/c/d",
      "tallyho/ field",
      "-x/y",
      "a/..",
      "not a host/a/b",
      "https://github.com/tallyho",
      "git@work:tallyho/fieldbook",
      "file:///tmp/a/b",
      "https://api.github.com/repos/x",
      "gist.github.com/tallyho/x",
      "x".repeat(301),
    ])
      expect(key(bad)).toBeNull();
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
