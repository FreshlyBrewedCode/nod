import { describe, expect, test } from "bun:test";

import type { RepoInfo, SignerState } from "../../shared/protocol";
import { setupStatus } from "../../server/fake-source";
import { FAKE_KEY } from "../../server/signer";
import { SETTINGS_SECTIONS } from "./route";
import {
  SECTIONS,
  badgeLine,
  addProblem,
  keyWords,
  repoFacts,
  repoListError,
  sectionOf,
  suggestionLine,
} from "./settings";

const key = {
  fingerprint: "SHA256:x",
  publicKey: FAKE_KEY.publicKey,
  location: "~/.config/nod/signing-key.json",
};
const locked: SignerState = { state: "locked", key };
const noKey: SignerState = { state: "no-key" };

const ledger: RepoInfo = {
  key: "acme.ghe.com/finance/ledger",
  name: "finance/ledger",
  github: { host: "acme.ghe.com", webUrl: "https://acme.ghe.com" },
  setup: setupStatus("ready", null, { step: "shared-policy" }),
  enrolment: { state: "active" },
};

describe("the sections", () => {
  test("every section has its words; a route without one opens the first", () => {
    for (const id of SETTINGS_SECTIONS) expect(SECTIONS[id].title.length).toBeGreaterThan(0);
    expect(sectionOf(undefined)).toBe("repositories");
    expect(sectionOf("repositories")).toBe("repositories");
  });
});

describe("Repositories", () => {
  test("a row's facts: host, step, my key there", () => {
    expect(repoFacts(ledger, locked)).toBe("acme.ghe.com · Shared policy · your key signs here");
    expect(repoFacts({ ...ledger, enrolment: null }, noKey)).toBe(
      "acme.ghe.com · Shared policy · no signing key",
    );
  });

  test("my key in a repo", () => {
    expect(keyWords(null, null)).toBe("no signing key");
    expect(keyWords(locked, { state: "not-enrolled" })).toBe("your key is not enrolled");
    expect(keyWords(locked, null)).toBe("your key is not enrolled");
    expect(keyWords(locked, { state: "pending", pr: { number: 501, url: "" } })).toBe(
      "your key is pending · #501",
    );
    expect(keyWords(locked, { state: "pending", pr: null })).toBe("your key is pending");
  });

  test("a suggestion's line", () => {
    expect(suggestionLine({ myOpenPrs: 2, reviewRequests: 1 })).toBe(
      "2 open pull requests of yours · 1 review requested",
    );
    expect(suggestionLine({ myOpenPrs: 1, reviewRequests: 0 })).toBe(
      "1 open pull request of yours",
    );
    expect(suggestionLine({ myOpenPrs: 0, reviewRequests: 3 })).toBe("3 reviews requested");
    expect(suggestionLine({ myOpenPrs: 0, reviewRequests: 0 })).toBe("nothing open of yours");
  });

  test("the add field: a repo, or what is wrong, before anything is sent", () => {
    expect(addProblem("tallyho/infra")).toBeNull();
    expect(addProblem("https://acme.ghe.com/finance/payroll/pull/3")).toBeNull();
    expect(addProblem("  ")).toBe("Type a repository, or pick one below.");
    expect(addProblem("infra")).toMatch(/^That is not a repository/);
  });

  test("a refusal says the server's sentence; nod serve gone says so", () => {
    expect(repoListError({ code: "not-found", message: "tallyho/missing does not exist." })).toBe(
      "tallyho/missing does not exist.",
    );
    expect(repoListError({ code: "offline", message: "x" })).toMatch(/did not answer/);
  });
});

test("the badge's line in Settings → App", () => {
  expect(badgeLine(null)).toContain("once nod serve has read GitHub");
  expect(badgeLine(0)).toContain("no badge");
  expect(badgeLine(1)).toBe("Now: 1 pull request needs you most, so it shows 1.");
  expect(badgeLine(3)).toBe("Now: 3 pull requests need you most, so it shows 3.");
});
