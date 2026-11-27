import { describe, expect, test } from "bun:test";

import type { Enrolment, RepoInfo } from "../../shared/protocol";
import { repoKey } from "../../shared/repo-key";
import { setupStatus } from "../../server/fake-source";
import {
  bestEnrolment,
  chipsOf,
  githubOfRepo,
  loginIn,
  readRepoFilter,
  repoOf,
  worstEnrolment,
} from "./repos";

const repo = (name: string, enrolment: Enrolment | null, host = "github.com"): RepoInfo => ({
  key: repoKey(host, name),
  name,
  github: { host, webUrl: `https://${host}` },
  setup: setupStatus("ready", null),
  enrolment,
});
const active = { state: "active" } as const;
const pending = { state: "pending", pr: null } as const;
const none = { state: "not-enrolled" } as const;

describe("the repos (ADR 0007)", () => {
  const fieldbook = repo("tallyho/fieldbook", active);
  const app = repo("tallyho/field-app", none);
  const ledger = repo("finance/ledger", pending, "acme.ghe.com");
  const all = [fieldbook, app, ledger];

  test("a PR's repo by its key, case aside; its host", () => {
    expect(repoOf(all, "TallyHo/Field-App")).toBe(app);
    expect(repoOf(all, "finance/ledger")).toBeNull();
    expect(githubOfRepo(all, ledger.key)).toEqual({
      host: "acme.ghe.com",
      webUrl: "https://acme.ghe.com",
    });
    expect(githubOfRepo(all, "gone/repo").host).toBe("github.com");
  });

  test("my login in a repo is its host's; the snapshot's while the server does not say", () => {
    const managed = { ...ledger, login: "mara_acme" };
    expect(loginIn([fieldbook, managed], managed.key, "mara-l")).toBe("mara_acme");
    expect(loginIn([fieldbook, managed], fieldbook.key, "mara-l")).toBe("mara-l");
    expect(loginIn([{ ...managed, login: null }], managed.key, "mara-l")).toBe("mara-l");
    expect(loginIn([], "gone/repo", "mara-l")).toBe("mara-l");
  });

  test("no chip with one repo, the shortest name with several", () => {
    expect(chipsOf([fieldbook]).size).toBe(0);
    expect([...chipsOf(all).values()]).toEqual(["fieldbook", "field-app", "ledger"]);
  });

  test("one key: the best enrolment for the key's own places, the worst for a batch", () => {
    expect(bestEnrolment(all)).toEqual(active);
    expect(bestEnrolment([app, ledger])).toEqual(pending);
    expect(bestEnrolment([app])).toEqual(none);
    expect(bestEnrolment([repo("a/b", null)])).toBeNull();
    expect(worstEnrolment(all, [fieldbook.key, ledger.key])).toEqual(pending);
    expect(worstEnrolment(all, [fieldbook.key])).toEqual(active);
    expect(worstEnrolment([repo("a/b", null)], ["a/b"])).toBeNull();
  });
});

describe("the remembered repo filter", () => {
  const a = repo("tallyho/fieldbook", null);
  const b = repo("finance/ledger", null, "acme.ghe.com");
  test("a repo of the list, as the list spells it", () => {
    expect(readRepoFilter("ACME.ghe.com/Finance/Ledger", [a, b])).toBe(
      "acme.ghe.com/finance/ledger",
    );
  });
  test("all: a repo the list no longer has, one repo only, anything else", () => {
    expect(readRepoFilter("tallyho/gone", [a, b])).toBeNull();
    expect(readRepoFilter("tallyho/fieldbook", [a])).toBeNull();
    expect(readRepoFilter(null, [a, b])).toBeNull();
    expect(readRepoFilter(7, [a, b])).toBeNull();
  });
});
