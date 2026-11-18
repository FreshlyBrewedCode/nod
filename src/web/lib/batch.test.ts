import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource } from "../../server/fake-source";
import type { PrView, SignResult, SignerState } from "../../shared/protocol";
import {
  INITIAL_BATCH,
  batchReducer,
  batchRows,
  countWord,
  entriesOf,
  groupByRole,
  isNotOpened,
  mergeResults,
  openModel,
  outcomeOf,
  outcomeSentence,
  readiness,
  reviewAgain,
  staleText,
  summarySentence,
  toggleRow,
  type BatchEvent,
  type BatchState,
} from "./batch";
import { openedKey } from "./storage";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const snapshot = new FakeSource({ clock: new ManualClock(NOW) }).snapshot()!;
const { people, repo, prs } = snapshot;
const pr = (n: number) => prs.find((p) => p.number === n)!;
const opened = { [openedKey(repo, 482)]: NOW - 60_000 };

// The mockup's batch (r2 `11`) plus the owner sign-off on #476.
const BATCH = [482, 485, 476, 488, 491];
const rowsOf = (numbers = BATCH, model = openModel(prs, numbers)) =>
  batchRows(model, prs, { opened, repo });

describe("rows and roles", () => {
  test("grouped by my role: peer, owner, re-attest, my own", () => {
    const groups = groupByRole(rowsOf(), people);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.pr.number)])).toEqual([
      ["Jonas’s work · you sign as peer", [482, 485]],
      ["Jonas’s work · you sign as owner of core/auth", [476]],
      ["Changed since you signed · you sign again", [491]],
      ["Your work · you sign as prompter", [488]],
    ]);
  });

  test("peers from several teammates", () => {
    const ines = { ...pr(482), number: 900, prompter: "inescal" };
    const model = openModel([...prs, ines], [482, 900]);
    const rows = batchRows(model, [...prs, ines], { opened, repo });
    expect(groupByRole(rows, people)[0]!.title).toBe("Teammates’ work · you sign as peer");
  });

  test("the entries are the included rows at the heads I looked at", () => {
    const model = toggleRow(openModel(prs, BATCH), 485);
    expect(entriesOf(rowsOf(BATCH, model))).toEqual([
      { pr: 482, head_sha: pr(482).headSha },
      { pr: 476, head_sha: pr(476).headSha },
      { pr: 488, head_sha: pr(488).headSha },
      { pr: 491, head_sha: pr(491).headSha },
    ]);
    // and back in
    expect(entriesOf(rowsOf(BATCH, toggleRow(model, 485)))).toHaveLength(5);
  });

  test("a PR that stopped needing me, or has no patch-id yet, is left out", () => {
    const done = { ...pr(482), ask: null, needsMe: false };
    const noPatch = { ...pr(485), patchId: null };
    const list = prs.map((p) => (p.number === 482 ? done : p.number === 485 ? noPatch : p));
    const rows = batchRows(openModel(list, [482, 485, 488]), list, { opened, repo });
    expect(rows.map((r) => [r.pr.number, r.included, r.blocked])).toEqual([
      [482, false, "no-ask"],
      [485, false, "no-patch-id"],
      [488, true, null],
    ]);
    expect(groupByRole(rows, people).at(-1)!.title).toBe("Nothing to sign here any more");
  });

  test("a head that moved after I looked is marked; review again takes the new one", () => {
    const model = openModel(prs, [482]);
    const moved = prs.map((p) => (p.number === 482 ? { ...p, headSha: "f".repeat(40) } : p));
    const [row] = batchRows(model, moved, { opened, repo });
    expect(row!.moved).toBe(true);
    expect(row!.headSha).toBe(pr(482).headSha);
    const again = reviewAgain(model, [
      { pr: 482, signed: pr(482).headSha, current: "f".repeat(40) },
    ]);
    const [fresh] = batchRows(again, moved, { opened, repo });
    expect([fresh!.moved, fresh!.changed, fresh!.headSha]).toEqual([false, true, "f".repeat(40)]);
  });
});

describe("not opened", () => {
  test("only someone else's work I never showed here", () => {
    const rows = rowsOf();
    const marked = rows.filter((r) => r.notOpened).map((r) => r.pr.number);
    // #482 was opened; #485 and #476 (peer, owner) were not; #488 and #491 are my own.
    expect(marked).toEqual([485, 476]);
  });

  test("a re-attest on a teammate's PR counts an opening after my old signature only", () => {
    const base = pr(491);
    const theirs: PrView = {
      ...base,
      mine: false,
      signatures: [{ ...base.signatures[0]!, byMe: true, at: NOW - 3_600_000 }],
    };
    const before = { [openedKey(repo, 491)]: NOW - 7_200_000 };
    const after = { [openedKey(repo, 491)]: NOW - 60_000 };
    expect(isNotOpened(theirs, before, repo)).toBe(true);
    expect(isNotOpened(theirs, after, repo)).toBe(false);
    expect(isNotOpened(base, {}, repo)).toBe(false);
  });
});

describe("sentences", () => {
  test("the batch in one sentence, by role", () => {
    expect(summarySentence(rowsOf())).toBe(
      "You are signing 5 changes: 2 as peer, 1 as owner, 1 again after a change, 1 your own.",
    );
    expect(summarySentence(rowsOf([482, 485]))).toBe("You are signing 2 changes as peer.");
    expect(summarySentence(rowsOf([488]))).toBe("You are signing 1 change of your own.");
    expect(summarySentence(rowsOf([482], toggleRow(openModel(prs, [482]), 482)))).toBe(
      "Nothing is left to sign. Tick a row to put it back.",
    );
  });

  test("the outcome per PR after my nod", () => {
    expect(outcomeOf(pr(482), people)).toEqual({
      text: "check turns green, the agent merges",
      tone: "ok",
    });
    expect(outcomeOf(pr(485), people)).toEqual({ text: "still waits on Jonas", tone: "wait" });
    expect(outcomeOf(pr(485), people, "after").text).toBe("waits on Jonas");
    expect(outcomeOf(pr(482), people, "after").text).toBe("the agent can merge");
    const running = { ...pr(482), checks: { ...pr(482).checks, state: "pending" as const } };
    expect(outcomeOf(running, people).text).toBe("check turns green, merges after CI");
    const failing = { ...pr(482), checks: { ...pr(482).checks, state: "failing" as const } };
    expect(outcomeOf(failing, people).tone).toBe("wait");
    expect(outcomeOf(pr(479), people)).toEqual({
      text: "nothing needed from you now",
      tone: "none",
    });
  });

  test("what the batch leads to, in r2's words", () => {
    const batch = [482, 485, 488, 490, 491].map(pr);
    expect(outcomeSentence(batch, people, "before")).toBe(
      "Four will be merged by their agents. One still waits on Jonas afterwards.",
    );
    expect(outcomeSentence(batch, people, "after")).toBe(
      "Four are with their agents now. One still waits on Jonas.",
    );
    expect(outcomeSentence([pr(482)], people, "before")).toBe("One will be merged by its agent.");
    expect(outcomeSentence([pr(485)], people, "after")).toBe("It still waits on Jonas.");
  });

  test("how a stale PR changed", () => {
    const entry = {
      pr: 482,
      signed: "9f3c2ab".padEnd(40, "0"),
      current: "1c4d5e6".padEnd(40, "0"),
    };
    expect(staleText(entry, { lastActivity: { at: NOW, text: "2 new commits" } })).toBe(
      "head 9f3c2ab → 1c4d5e6 · 2 new commits",
    );
    expect(staleText(entry, null)).toBe("head 9f3c2ab → 1c4d5e6");
  });

  test("counts in words up to ten", () => {
    expect([countWord(1), countWord(4), countWord(10), countWord(12)]).toEqual([
      "one",
      "four",
      "ten",
      "12",
    ]);
  });
});

describe("readiness", () => {
  const key = { fingerprint: "SHA256:x", publicKey: "ssh-ed25519 AAAA", location: "here" };
  test("from the signer state and the key's enrolment", () => {
    expect(readiness(null).state).toBe("locked");
    expect(readiness({ state: "no-key" }).state).toBe("no-key");
    const active = { ...key, enrolment: { state: "active" } } as const;
    expect(readiness({ state: "locked", key: active }).state).toBe("locked");
    expect(readiness({ state: "unlocked", key: active, until: NOW, once: false }).state).toBe(
      "unlocked",
    );
    const pending: SignerState = {
      state: "unlocked",
      key: { ...key, enrolment: { state: "pending", pr: { number: 501, url: "" } } },
      until: NOW,
      once: false,
    };
    expect(readiness(pending)).toEqual({ state: "pending", pr: 501 });
    expect(
      readiness({ state: "locked", key: { ...key, enrolment: { state: "not-enrolled" } } }).state,
    ).toBe("not-enrolled");
  });
});

describe("the state machine", () => {
  const rows = [pr(482), pr(485)];
  const entries = rows.map((p) => ({ pr: p.number, head_sha: p.headSha }));
  const sign = (
    readinessState: "unlocked" | "locked" | "no-key",
  ): Extract<BatchEvent, { t: "sign" }> => ({
    t: "sign",
    readiness: readinessState,
    rows,
    entries,
  });
  const result: SignResult = {
    payload: "nod v1 …",
    posted: [{ pr: 482, url: "u1" }],
    failed: [{ pr: 485, message: "GitHub said no." }],
  };
  const run = (...events: BatchEvent[]) =>
    events.reduce<BatchState>((s, e) => batchReducer(s, e), INITIAL_BATCH);

  test("unlocked: review → signing → signed", () => {
    expect(run(sign("unlocked")).step).toBe("signing");
    const signed = run(sign("unlocked"), { t: "signed", result });
    expect(signed).toEqual({ step: "signed", shown: rows, result });
  });

  test("locked: review → unlock → (wrong passphrase) → unlock → signing → signed", () => {
    expect(run(sign("locked"))).toMatchObject({ step: "unlock", busy: false, error: null });
    expect(run(sign("locked"), { t: "unlock" })).toMatchObject({ step: "unlock", busy: true });
    const wrong = run(
      sign("locked"),
      { t: "unlock" },
      {
        t: "unlock-failed",
        failure: { code: "bad-passphrase", message: "no" },
      },
    );
    expect(wrong).toMatchObject({ step: "unlock", busy: false, error: { code: "bad-passphrase" } });
    const done = run(sign("locked"), { t: "unlock" }, { t: "unlocked" }, { t: "signed", result });
    expect(done.step).toBe("signed");
  });

  test("a key file nod cannot read ends in the error step, not the field", () => {
    const s = run(
      sign("locked"),
      { t: "unlock" },
      {
        t: "unlock-failed",
        failure: { code: "bad-key-file", message: "damaged" },
      },
    );
    expect(s).toEqual({ step: "error", failure: { code: "bad-key-file", message: "damaged" } });
  });

  test("no key or a pending key: the button does nothing", () => {
    expect(run(sign("no-key"))).toBe(INITIAL_BATCH);
    expect(run({ ...sign("unlocked"), entries: [] })).toBe(INITIAL_BATCH);
  });

  test("stale: nothing signed, the moved PRs listed; back to review", () => {
    const stale = [{ pr: 482, signed: "a", current: "b" }];
    const s = run(sign("unlocked"), {
      t: "sign-failed",
      failure: { code: "stale", message: "#482 changed" },
      details: { stale },
    });
    expect(s).toEqual({ step: "stale", stale });
    expect(batchReducer(s, { t: "back" })).toBe(INITIAL_BATCH);
  });

  test("locked in between: back to the field, with a note", () => {
    const s = run(sign("unlocked"), {
      t: "sign-failed",
      failure: { code: "locked", message: "Unlock signing first." },
    });
    expect(s).toMatchObject({ step: "unlock", error: { code: "locked" } });
  });

  test("any other failure: the error step", () => {
    const s = run(sign("unlocked"), {
      t: "sign-failed",
      failure: { code: "offline", message: "Not connected." },
    });
    expect(s).toEqual({ step: "error", failure: { code: "offline", message: "Not connected." } });
  });

  test("retrying the failed posts keeps what was posted", () => {
    const signed = run(sign("unlocked"), { t: "signed", result });
    const retry = batchReducer(signed, {
      t: "sign",
      readiness: "unlocked",
      rows: [],
      entries: [entries[1]!],
    });
    expect(retry).toMatchObject({ step: "signing", attempt: { shown: rows, prior: result } });
    const after = batchReducer(retry, {
      t: "signed",
      result: { payload: "nod v1 again", posted: [{ pr: 485, url: "u2" }], failed: [] },
    });
    expect(after).toMatchObject({
      step: "signed",
      shown: rows,
      result: { posted: [{ pr: 482 }, { pr: 485 }], failed: [] },
    });
    // a retry that fails again keeps the signed step, with the new reason
    const again = batchReducer(retry, {
      t: "sign-failed",
      failure: { code: "github", message: "Still down." },
    });
    expect(again).toEqual({
      step: "signed",
      shown: rows,
      result: { ...result, failed: [{ pr: 485, message: "Still down." }] },
    });
    // a locked retry goes through the field, and Back returns to the signed step
    const locked = batchReducer(signed, { ...sign("locked"), entries: [entries[1]!] });
    expect(locked.step).toBe("unlock");
    expect(batchReducer(locked, { t: "back" })).toEqual(signed);
  });

  test("events that do not fit the step change nothing", () => {
    expect(batchReducer(INITIAL_BATCH, { t: "unlocked" })).toBe(INITIAL_BATCH);
    expect(batchReducer(INITIAL_BATCH, { t: "signed", result })).toBe(INITIAL_BATCH);
    const signing = run(sign("unlocked"));
    expect(batchReducer(signing, { t: "back" })).toBe(signing);
  });

  test("merging results: posted adds up, failed is the latest", () => {
    expect(mergeResults(null, result)).toBe(result);
    expect(
      mergeResults(result, { payload: "p", posted: [{ pr: 482, url: "x" }], failed: [] }).posted,
    ).toEqual([{ pr: 482, url: "u1" }]);
  });
});
