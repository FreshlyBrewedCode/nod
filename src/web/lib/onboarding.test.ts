import { describe, expect, test } from "bun:test";

import { setupStatus } from "../../server/fake-source";
import type { Account, Enrolment, PrLink, SignerState } from "../../shared/protocol";
import {
  nextStep,
  onboardingError,
  passphraseProblem,
  progressOf,
  reachable,
  shortFingerprint,
  shortPath,
  signerLine,
  teammates,
} from "./onboarding";

const ME: Account = { login: "mara-l", name: "Mara Lindqvist", scopes: ["repo"] };
const REPO = "tallyho/fieldbook";
const SETUP_PR: PrLink = { number: 494, url: `https://github.com/${REPO}/pull/494` };
const ENROL_PR: PrLink = { number: 501, url: `https://github.com/${REPO}/pull/501` };
const KEY = {
  fingerprint: "SHA256:Qx7fT0mAbCdEfGhIjKlMnOpQrStUvWxYzk2Vd9",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample nod",
  location: "/home/someone/.config/nod/signing-key.json",
};
const noKey: SignerState = { state: "no-key" };
const locked = (enrolment: Enrolment): SignerState => ({
  state: "locked",
  key: { ...KEY, enrolment },
});

describe("where onboarding stands, from the server's state alone", () => {
  test("fresh: no repo picked, no key: from step 1, onboarding needed", () => {
    const p = progressOf({ me: ME, setup: setupStatus(null, "none", null), signer: noKey });
    expect(p).toMatchObject({ start: 1, needed: true, enrolVia: "setup-pr" });
    expect(p.done).toEqual({ 1: false, 2: false, 3: false, 4: false });
  });

  test("not signed in to gh: step 1, needed", () => {
    const p = progressOf({ me: null, setup: setupStatus(REPO, "missing", null), signer: noKey });
    expect(p).toMatchObject({ start: 1, needed: true, signedIn: false });
  });

  test("a repo picked but not set up, no key yet: still from the beginning", () => {
    const p = progressOf({ me: ME, setup: setupStatus(REPO, "missing", null), signer: noKey });
    expect(p).toMatchObject({ start: 1, needed: true });
    expect(nextStep(p, 1)).toBe(2);
    expect(nextStep(p, 2)).toBe(3);
  });

  test("a key, the repo not set up: resumes at step 2, the setup PR", () => {
    const p = progressOf({
      me: ME,
      setup: setupStatus(REPO, "missing", null),
      signer: locked({ state: "not-enrolled" }),
    });
    expect(p).toMatchObject({ start: 2, needed: true, key: "not-enrolled" });
  });

  test("setup PR open with my key in it: pending, the dashboard (test signature next)", () => {
    const p = progressOf({
      me: ME,
      setup: setupStatus(REPO, "pending", SETUP_PR),
      signer: locked({ state: "pending", pr: SETUP_PR }),
    });
    expect(p).toMatchObject({ start: 4, needed: false, key: "pending", enrolVia: "setup-pr" });
    expect(p.done).toEqual({ 1: true, 2: true, 3: true, 4: false });
  });

  test("a joining teammate: set up, no key: step 1, then straight to the key (step 2 skipped)", () => {
    const p = progressOf({ me: ME, setup: setupStatus(REPO, "ready", null), signer: noKey });
    expect(p).toMatchObject({ start: 1, needed: true, enrolVia: "enrol-pr" });
    expect(p.done[2]).toBe(true);
    expect(nextStep(p, 1)).toBe(3);
  });

  test("set up, a key that is not enrolled: resumes at step 3 (the enrolment PR)", () => {
    const p = progressOf({
      me: ME,
      setup: setupStatus(REPO, "ready", null),
      signer: locked({ state: "not-enrolled" }),
    });
    expect(p).toMatchObject({ start: 3, needed: true });
    expect(reachable(p, 3)).toBe(true);
    expect(reachable(p, 4)).toBe(false);
  });

  test("key pending in the enrolment PR: the dashboard", () => {
    const p = progressOf({
      me: ME,
      setup: setupStatus(REPO, "ready", null),
      signer: locked({ state: "pending", pr: ENROL_PR }),
    });
    expect(p).toMatchObject({ needed: false, key: "pending", start: 4 });
  });

  test("all ready: not needed", () => {
    const p = progressOf({
      me: ME,
      setup: setupStatus(REPO, "ready", null),
      signer: locked({ state: "active" }),
    });
    expect(p).toMatchObject({ needed: false, key: "active", start: 4 });
    expect([1, 2, 3, 4].map((s) => reachable(p, s as 1 | 2 | 3 | 4))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("the passphrase", () => {
  test("the rule, field by field", () => {
    expect(passphraseProblem("", "")).toEqual({ field: "first", message: "Enter a passphrase." });
    expect(passphraseProblem("short one", "short one")).toEqual({
      field: "first",
      message: "Too short: use at least 12 characters.",
    });
    expect(passphraseProblem("x".repeat(1025), "")?.message).toBe("Use at most 1024 characters.");
    expect(passphraseProblem("correct horse battery", "")?.field).toBe("second");
    expect(passphraseProblem("correct horse battery", "correct horse batterY")).toEqual({
      field: "second",
      message: "The two passphrases differ.",
    });
    expect(passphraseProblem("correct horse battery", "correct horse battery")).toBeNull();
  });

  test("counts characters, not UTF-16 units, and compares normalised", () => {
    // 12 characters, 24 UTF-16 units
    expect(passphraseProblem("🐴".repeat(11), "🐴".repeat(11))?.field).toBe("first");
    expect(passphraseProblem("🐴".repeat(12), "🐴".repeat(12))).toBeNull();
    expect(passphraseProblem("café au lait ok", "café au lait ok")).toBeNull();
  });
});

describe("words", () => {
  test("paths, fingerprints, the allowed_signers line", () => {
    expect(shortPath("/home/someone/.config/nod/signing-key.json")).toBe(
      "~/.config/nod/signing-key.json",
    );
    expect(shortPath("/Users/someone/x")).toBe("~/x");
    expect(shortPath("/tmp/xdg/nod/signing-key.json")).toBe("/tmp/xdg/nod/signing-key.json");
    expect(shortFingerprint(KEY.fingerprint)).toBe("SHA256:Qx7fT0m…k2Vd9");
    expect(signerLine("mara-l", KEY.publicKey)).toBe(
      'mara-l namespaces="nod" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample',
    );
  });

  test("teammates by first name, or none when there are too many to name", () => {
    const people = [
      { login: "mara-l", name: "Mara Lindqvist" },
      { login: "jonas-r", name: "Jonas Reuter" },
      { login: "inescal", name: "Ines Calderón" },
    ];
    expect(teammates(people, "mara-l", "or")).toBe("Jonas or Ines");
    expect(teammates(people, "mara-l", "and")).toBe("Jonas and Ines");
    expect(teammates([people[0]!], "mara-l", "or")).toBeNull();
    expect(teammates([...people, { login: "x", name: null }], "mara-l", "or")).toBeNull();
  });

  test("every error a calm, specific sentence", () => {
    const say = (code: Parameters<typeof onboardingError>[0]["code"], message = "") =>
      onboardingError({ code, message });
    expect(say("github", "`gh` is not logged in.")).toContain("gh auth login");
    expect(
      say(
        "github",
        "`gh` is not logged in to acme.ghe.com. Run `gh auth login --hostname acme.ghe.com`.",
      ),
    ).toBe(
      "nod serve is not signed in to acme.ghe.com. Run `gh auth login --hostname acme.ghe.com` in a terminal, then restart nod serve.",
    );
    expect(say("key-exists")).toContain("never replaces");
    expect(say("bad-key-file")).toContain("nod key show");
    expect(say("offline")).toContain("still running");
    expect(say("github", "GitHub 403: Upgrade to GitHub Pro or make this repository public")).toBe(
      "GitHub refused: rulesets on private repositories need GitHub Pro, Team or Enterprise. Nothing was changed.",
    );
    expect(
      say(
        "forbidden",
        "nod serve reads tallyho/fieldbook only, the repository of its folder. To use acme/x, start nod serve in a clone of it.",
      ),
    ).toContain("clone");
    expect(say("weak-passphrase", "Use a passphrase of at least 12 characters.")).toBe(
      "Use a passphrase of at least 12 characters.",
    );
  });
});
