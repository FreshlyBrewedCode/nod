import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import {
  FAKE_SCENARIOS,
  FakeSource,
  scenarioHasKey,
  setupStatus,
  type FakeScenario,
} from "../../server/fake-source";
import { Session } from "../../server/session";
import { FakeSigner } from "../../server/signer";
import type {
  Account,
  Enrolment,
  PrLink,
  RepoPermission,
  ServerToClient,
  SetupStatus,
  SignerState,
  Welcome,
} from "../../shared/protocol";
import {
  DISMISSED_LIMIT,
  cardOf,
  dismiss,
  landingOf,
  offerKey,
  offerWords,
  offersOf,
  onboardingError,
  passphraseProblem,
  readDismissed,
  rungsOf,
  setupRungOf,
  shortFingerprint,
  shortPath,
  signerLine,
  teammates,
  type Landing,
} from "./onboarding";

const ME: Account = { login: "mara-l", name: "Mara Lindqvist", scopes: ["repo"] };
const REPO = "tallyho/fieldbook";
const HOST = "github.com";
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

const state = (setup: SetupStatus, signer: SignerState, me: Account | null = ME) => ({
  me,
  setup,
  signer,
});
const ready = (step: "shared-policy" | "enforced", permission: RepoPermission | null = "admin") =>
  setupStatus(REPO, "ready", null, { step, permission });

describe("where a first open lands: nothing gates but gh and a repo", () => {
  test("not signed in to gh: the sign-in page", () => {
    expect(landingOf({ me: null, setup: setupStatus(REPO, "missing", null) })).toBe("sign-in");
  });

  test("no repo picked (fake fresh): the repo picker", () => {
    expect(landingOf({ me: ME, setup: setupStatus(null, "none", null) })).toBe("pick-repo");
  });

  test("a repo with nothing in it and no key: the dashboard", () => {
    expect(landingOf({ me: ME, setup: setupStatus(REPO, "missing", null) })).toBe("dashboard");
  });

  test("a set-up repo, no key (a teammate joining): the dashboard", () => {
    expect(landingOf({ me: ME, setup: ready("enforced") })).toBe("dashboard");
  });
});

describe("the ladder's steps for this repo and me", () => {
  test("the inbox: nothing in the repo, no key", () => {
    expect(rungsOf(state(setupStatus(REPO, "missing", null), noKey))).toEqual({
      inbox: "done",
      "shared-policy": "open",
      signing: "open",
      enforced: "later",
    });
  });

  test("the inbox, read access only: the setup PR is someone else's", () => {
    const r = rungsOf(state(setupStatus(REPO, "missing", null, { permission: "read" }), noKey));
    expect(r["shared-policy"]).toBe("not-yours");
    expect(r.signing).toBe("later");
  });

  test("the setup PR open with my key in it: both wait on it", () => {
    const r = rungsOf(
      state(setupStatus(REPO, "pending", SETUP_PR), locked({ state: "pending", pr: SETUP_PR })),
    );
    expect(r).toEqual({
      inbox: "done",
      "shared-policy": "waiting",
      signing: "waiting",
      enforced: "later",
    });
  });

  test("the setup PR open without my key: signing comes after it merges", () => {
    expect(rungsOf(state(setupStatus(REPO, "pending", SETUP_PR), noKey)).signing).toBe("later");
  });

  test("shared policy, my key active, an admin: enforcing is open", () => {
    expect(rungsOf(state(ready("shared-policy"), locked({ state: "active" })))).toEqual({
      inbox: "done",
      "shared-policy": "done",
      signing: "done",
      enforced: "open",
    });
  });

  test("shared policy, write access: enforcing needs an admin", () => {
    const r = rungsOf(state(ready("shared-policy", "write"), locked({ state: "active" })));
    expect(r.enforced).toBe("not-yours");
  });

  test("enforced, no key: every step done but mine", () => {
    expect(rungsOf(state(ready("enforced", "write"), noKey))).toEqual({
      inbox: "done",
      "shared-policy": "done",
      signing: "open",
      enforced: "done",
    });
  });

  test("an older server says neither step nor permission: from the setup's state", () => {
    const old: SetupStatus = { repo: REPO, state: "ready", checks: [], setupPr: null };
    const r = rungsOf(state(old, locked({ state: "active" })));
    expect(r["shared-policy"]).toBe("done");
    expect(r.enforced).toBe("open");
    // Unknown permission: the setup page shows the step, nothing offers it.
    expect(offersOf(state(old, locked({ state: "active" })))).toEqual([]);
  });
});

describe("the offers: the card shows the next one, the menu all of them", () => {
  test("the inbox, no key: share a policy (signing rides in its PR, no offer of its own)", () => {
    const s = state(setupStatus(REPO, "missing", null), noKey);
    expect(offersOf(s)).toEqual([{ rung: "shared-policy", phase: "offer", pr: null }]);
    expect(cardOf(s, [], HOST)).toEqual({ rung: "shared-policy", phase: "offer", pr: null });
  });

  test("the setup PR open: it is on its way, with its link", () => {
    const s = state(
      setupStatus(REPO, "pending", SETUP_PR),
      locked({ state: "pending", pr: SETUP_PR }),
    );
    expect(offersOf(s)).toEqual([{ rung: "shared-policy", phase: "waiting", pr: SETUP_PR }]);
  });

  test("a teammate joining, no key: sign your own agent PRs", () => {
    const s = state(ready("enforced", "write"), noKey);
    expect(offersOf(s)).toEqual([{ rung: "signing", phase: "offer", pr: null }]);
  });

  test("the key pending in its enrolment PR: on its way", () => {
    const s = state(ready("enforced", "write"), locked({ state: "pending", pr: ENROL_PR }));
    expect(cardOf(s, [], HOST)).toEqual({ rung: "signing", phase: "waiting", pr: ENROL_PR });
  });

  test("an admin at the shared policy: signing first, then enforcing", () => {
    const s = state(ready("shared-policy"), noKey);
    expect(offersOf(s).map((o) => o.rung)).toEqual(["signing", "enforced"]);
    expect(cardOf(s, [], HOST)?.rung).toBe("signing");
  });

  test("an admin at the shared policy, key active: enforcing", () => {
    const s = state(ready("shared-policy"), locked({ state: "active" }));
    expect(cardOf(s, [], HOST)).toEqual({ rung: "enforced", phase: "offer", pr: null });
  });

  test("not an admin: enforcing is never offered", () => {
    const s = state(ready("shared-policy", "write"), locked({ state: "active" }));
    expect(offersOf(s)).toEqual([]);
  });

  test("everything done: nothing offered", () => {
    expect(offersOf(state(ready("enforced"), locked({ state: "active" })))).toEqual([]);
  });

  test("before a dashboard: nothing offered", () => {
    expect(offersOf(state(setupStatus(REPO, "missing", null), noKey, null))).toEqual([]);
    expect(offersOf(state(setupStatus(null, "none", null), noKey))).toEqual([]);
  });
});

describe("dismissing the card", () => {
  const s = state(ready("shared-policy"), noKey);
  const signing = { rung: "signing", phase: "offer", pr: null } as const;

  test("a dismissed card stays away and makes no room for the next step", () => {
    const key = offerKey(HOST, REPO, signing);
    expect(key).toBe("github.com/tallyho/fieldbook:signing:offer");
    expect(cardOf(s, [key], HOST)).toBeNull();
    // The menu still has every step.
    expect(offersOf(s)).toHaveLength(2);
  });

  test("per repo and host", () => {
    const other = offerKey(HOST, "tallyho/other", signing);
    expect(cardOf(s, [other], HOST)?.rung).toBe("signing");
    expect(cardOf(s, [offerKey(HOST, REPO, signing)], "acme.ghe.com")?.rung).toBe("signing");
  });

  test("a step that moves on is a new card: the offer dismissed, its PR open", () => {
    const pending = state(ready("enforced", "write"), locked({ state: "pending", pr: ENROL_PR }));
    expect(cardOf(pending, [offerKey(HOST, REPO, signing)], HOST)?.phase).toBe("waiting");
  });

  test("what storage holds: strings only, the newest kept", () => {
    expect(readDismissed(null)).toEqual([]);
    expect(readDismissed({ a: 1 })).toEqual([]);
    expect(readDismissed(["a", 2, "b"])).toEqual(["a", "b"]);
    expect(dismiss(["a", "b"], "a")).toEqual(["b", "a"]);
    const many = Array.from({ length: DISMISSED_LIMIT }, (_, i) => `k${i}`);
    expect(dismiss(many, "new")).toHaveLength(DISMISSED_LIMIT);
    expect(dismiss(many, "new").at(-1)).toBe("new");
    expect(dismiss(many, "new")[0]).toBe("k1");
  });
});

describe("where the setup page opens", () => {
  test("the step asked for wins", () => {
    expect(setupRungOf(state(ready("enforced"), locked({ state: "active" })), "inbox")).toBe(
      "inbox",
    );
  });

  test("else the next offer's step", () => {
    expect(setupRungOf(state(setupStatus(REPO, "missing", null), noKey), null)).toBe(
      "shared-policy",
    );
    expect(setupRungOf(state(ready("enforced", "write"), noKey), null)).toBe("signing");
    expect(setupRungOf(state(ready("shared-policy"), locked({ state: "active" })), null)).toBe(
      "enforced",
    );
  });

  test("not yours to take: the first step that is not done", () => {
    expect(
      setupRungOf(state(ready("shared-policy", "write"), locked({ state: "active" })), null),
    ).toBe("enforced");
  });

  test("all done: signing, the key and its test", () => {
    expect(setupRungOf(state(ready("enforced"), locked({ state: "active" })), null)).toBe(
      "signing",
    );
  });
});

describe("the offers' words", () => {
  test("each step and phase", () => {
    expect(offerWords({ rung: "shared-policy", phase: "offer", pr: null }, "none")).toMatchObject({
      title: "Share one policy with the team",
      action: "Set it up",
    });
    expect(
      offerWords({ rung: "shared-policy", phase: "waiting", pr: SETUP_PR }, "pending"),
    ).toMatchObject({ title: "Setup PR #494 is open", action: null });
    expect(offerWords({ rung: "signing", phase: "offer", pr: null }, "none")).toMatchObject({
      title: "Sign your own agent PRs",
      action: "Create your key",
    });
    expect(offerWords({ rung: "signing", phase: "offer", pr: null }, "not-enrolled").action).toBe(
      "Enrol your key",
    );
    expect(offerWords({ rung: "signing", phase: "waiting", pr: ENROL_PR }, "pending")).toEqual({
      title: "Your key is pending",
      line: "signing, once #501 merges",
      action: null,
    });
    expect(offerWords({ rung: "enforced", phase: "offer", pr: null }, "active").title).toBe(
      "Let agents merge on their own",
    );
  });
});

describe("every fake scenario: where a first open lands, which card shows", () => {
  const NOW = Date.UTC(2026, 10, 18, 14, 20);
  async function welcomeOf(scenario: FakeScenario) {
    const clock = new ManualClock(NOW);
    const source = new FakeSource({ clock, scenario });
    await source.ready;
    const signer = new FakeSigner(clock, { hasKey: scenarioHasKey(scenario) });
    const session = new Session({ source, signer, clock, version: null, fake: true });
    const messages: ServerToClient[] = [];
    await session.attach({
      side: "loopback",
      send: (d: string) => void messages.push(JSON.parse(d)),
    });
    source.stop();
    return messages.find((m): m is Welcome => m.t === "welcome")!;
  }

  const expected: Record<FakeScenario, [Landing, string | null]> = {
    team: ["dashboard", null],
    clear: ["dashboard", null],
    "first-run": ["dashboard", "shared-policy:waiting"],
    fresh: ["pick-repo", null],
    join: ["dashboard", "signing:offer"],
    inbox: ["dashboard", "shared-policy:offer"],
    shared: ["dashboard", "enforced:offer"],
  };

  for (const scenario of FAKE_SCENARIOS)
    test(scenario, async () => {
      const w = await welcomeOf(scenario);
      const s = { me: w.me, setup: w.setup, signer: w.signer };
      const card = cardOf(s, [], HOST);
      expect([landingOf(s), card ? `${card.rung}:${card.phase}` : null]).toEqual(
        expected[scenario],
      );
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
