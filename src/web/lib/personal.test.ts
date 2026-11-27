import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource } from "../../server/fake-source";
import type { InboxStatus, PersonalAttention, PrView } from "../../shared/protocol";
import {
  bannerError,
  inboxFile,
  inboxStateLine,
  markLines,
  personalOf,
  personalTag,
  placementLine,
  readDismissed,
  repoLine,
  youLine,
} from "./personal";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const snapshot = new FakeSource({ clock: new ManualClock(NOW) }).snapshot()!;
const pr = (n: number) => snapshot.prs.find((p) => p.number === n)!;

const personal = (over: Partial<PersonalAttention> = {}): PersonalAttention => ({
  attention: 0,
  tags: [],
  fyi: false,
  marks: [],
  errors: [],
  ...over,
});
const withMe = (p: PrView, over: Partial<PersonalAttention>): PrView => ({
  ...p,
  personal: personal(over),
});

describe("the two layers, in words", () => {
  test("the repo's line: its risk and what the PR needs", () => {
    expect(repoLine(pr(476))).toBe("repo: high risk · Prompter self-attest + named owner (Mara)");
  });

  test("mine: what my inbox did, and its tags", () => {
    expect(youLine(withMe(pr(476), { attention: 1, tags: ["auth"] }))).toBe("you: raised · auth");
    expect(youLine(withMe(pr(478), { attention: "mute" }))).toBe("you: muted");
    expect(youLine(withMe(pr(478), { attention: -1, tags: ["ci"] }))).toBe("you: lowered · ci");
    expect(youLine(withMe(pr(478), { fyi: true }))).toBe("you: worth knowing");
    expect(youLine(withMe(pr(478), { errors: ["x: boom"] }))).toBe("you: a classifier failed");
  });

  test("nothing said: no line, no tag", () => {
    expect(personalOf(pr(476))).toBeNull();
    expect(personalOf(withMe(pr(476), {}))).toBeNull();
    expect(personalOf({ personal: null as unknown as undefined })).toBeNull();
    expect(youLine(withMe(pr(476), {}))).toBeNull();
    expect(personalTag(withMe(pr(476), { attention: 1 }))).toBeNull();
  });

  test("the row's tag: my first tag, or muted", () => {
    expect(personalTag(withMe(pr(476), { attention: 1, tags: ["auth", "x"] }))).toBe("auth");
    expect(personalTag(withMe(pr(478), { attention: "mute" }))).toBe("muted");
    expect(personalTag(withMe(pr(478), { attention: "mute", tags: ["ci"] }))).toBe("muted · ci");
  });

  test("each mark with what it does and who said it", () => {
    expect(
      markLines([
        { classifier: "watch(auth)", attention: 1, tag: "auth", detail: "3 files you watch" },
        { classifier: "quiet-ci", attention: "mute", detail: "you mute CI changes" },
        { classifier: "mine", fyi: true, detail: "touches docs" },
        { classifier: "t", tag: "x", detail: "d" },
      ]),
    ).toEqual([
      {
        detail: "3 files you watch",
        effect: "↑ one tier · tag auth",
        classifier: "watch(auth)",
        raises: true,
      },
      { detail: "you mute CI changes", effect: "muted", classifier: "quiet-ci", raises: false },
      { detail: "touches docs", effect: "worth knowing", classifier: "mine", raises: false },
      { detail: "d", effect: "tag x", classifier: "t", raises: false },
    ]);
  });
});

describe("why the row sits where it sits", () => {
  test("raised: the tier now and the repo's", () => {
    // #483 is folded by the repo alone; +1 makes it one line.
    expect(placementLine(withMe(pr(483), { attention: 1 }))).toBe(
      "Raised by your inbox: one line, where the repo alone shows it folded.",
    );
  });

  test("raised, but prominent already", () => {
    expect(placementLine(withMe(pr(476), { attention: 1 }))).toBe(
      "Your inbox raised it, but it is prominent already.",
    );
  });

  test("muted: folded into Background, unless the repo holds it", () => {
    expect(placementLine(withMe(pr(478), { attention: "mute" }))).toBe(
      "Muted by your inbox: folded into Background.",
    );
    expect(placementLine(withMe(pr(476), { attention: "mute" }))).toBe(
      "Muted by your inbox, but it needs you: it stays in Needs you.",
    );
  });

  test("lowered, but it needs me", () => {
    expect(placementLine(withMe(pr(476), { attention: -1 }))).toMatch(
      /^Lowered by your inbox: a normal row/,
    );
  });

  test("nothing asked: no line", () => {
    expect(placementLine(withMe(pr(476), { tags: ["auth"] }))).toBeNull();
    expect(placementLine(pr(476))).toBeNull();
  });
});

describe("the banner and Settings → Inbox", () => {
  const status: InboxStatus = {
    config: "yours",
    path: "/home/u/.config/nod/inbox/",
    state: "ready",
    error: null,
    classifiers: [{ name: "watch(auth)", origin: "yours" }],
    analyzers: [
      { id: "a", title: "A", when: "poll", origin: "default" },
      { id: "b", title: "B", when: "open", origin: "yours" },
    ],
  };

  test("the banner shows an error until that error is put away", () => {
    const broken = { ...status, state: "error" as const, error: "inbox.ts does not load: x" };
    expect(bannerError(status, [])).toBeNull();
    expect(bannerError(null, [])).toBeNull();
    expect(bannerError(broken, [])).toBe("inbox.ts does not load: x");
    expect(bannerError(broken, ["inbox.ts does not load: x"])).toBeNull();
    expect(bannerError({ error: "another" }, ["inbox.ts does not load: x"])).toBe("another");
  });

  test("what was put away is read back defensively", () => {
    expect(readDismissed(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(readDismissed("a")).toEqual([]);
    expect(readDismissed(Array.from({ length: 30 }, (_, i) => String(i))).length).toBe(20);
  });

  test("the state in one line, and the file", () => {
    expect(inboxStateLine(status)).toBe("Your inbox.ts runs: 1 classifier, 2 analyzers.");
    expect(inboxStateLine({ ...status, config: "default", state: "starting" })).toBe(
      "The built-in defaults run (no inbox.ts): loading…",
    );
    expect(inboxStateLine({ ...status, state: "error" })).toMatch(/does not load/);
    expect(inboxFile(status)).toBe("/home/u/.config/nod/inbox/inbox.ts");
  });
});
