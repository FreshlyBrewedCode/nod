import { describe, expect, test } from "bun:test";

import { ManualClock } from "../../server/clock";
import { FakeSource } from "../../server/fake-source";
import type { ApproveResult, PrView, SignResult, SignerState } from "../../shared/protocol";
import {
  INITIAL_BATCH,
  batchKind,
  batchReducer,
  batchRows,
  canSignWith,
  countWord,
  entriesOf,
  groupByRole,
  isNotOpened,
  mergeApprovals,
  mergeResults,
  openModel,
  outcomeOf,
  outcomeSentence,
  readiness,
  reviewAgain,
  roleShort,
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

describe("roleShort", () => {
  test("is a word or two per role", () => {
    expect(roleShort("peer")).toBe("as peer");
    expect(roleShort("owner")).toBe("as owner");
    expect(roleShort("re-attest")).toBe("again");
    expect(roleShort("self")).toBe("your own");
    expect(roleShort(null)).toBe("");
  });
});

describe("approving on GitHub (ADR 0006)", () => {
  // The inbox step: no policy, no key; two teammates' PRs ask for my review.
  const inboxSource = new FakeSource({ clock: new ManualClock(NOW), scenario: "inbox" });
  const inbox = async () => {
    await inboxSource.ready;
    return inboxSource.snapshot()!.prs;
  };

  test("rows: approvals need no patch-id; the batch's kind is the asks'", async () => {
    const all = await inbox();
    const model = openModel(all, [512, 515, 514]);
    expect(batchKind(model, all)).toBe("approve");
    const rows = batchRows(model, all, { opened: {}, repo });
    expect(rows.map((r) => [r.pr.number, r.role, r.included, r.blocked, r.notOpened])).toEqual([
      [512, "approve", true, null, true],
      [515, "approve", true, null, true],
      [514, null, false, "no-ask", false],
    ]);
    expect(groupByRole(rows, people, "approve").map((g) => [g.role, g.title])).toEqual([
      ["approve", "Teammates’ work · you approve on GitHub"],
      [null, "Nothing to approve here any more"],
    ]);
    expect(summarySentence(rows, "approve")).toBe("You are approving 2 changes on GitHub.");
    expect(entriesOf(rows)).toEqual([
      { pr: 512, head_sha: rows[0]!.pr.headSha },
      { pr: 515, head_sha: rows[1]!.pr.headSha },
    ]);
  });

  test("one kind per batch: a row of the other kind is left out and says so", async () => {
    const all = await inbox();
    const mixed = [...all, pr(482)];
    const approveFirst = batchRows(openModel(mixed, [512, 482]), mixed, { opened, repo });
    expect(approveFirst.map((r) => [r.pr.number, r.included, r.blocked])).toEqual([
      [512, true, null],
      [482, false, "other-kind"],
    ]);
    expect(groupByRole(approveFirst, people, "approve").at(-1)).toMatchObject({
      role: "other-kind",
      title: "To sign · in a batch of their own",
    });
    const signFirst = batchRows(openModel(mixed, [482, 512]), mixed, { opened, repo });
    expect(batchKind(openModel(mixed, [482, 512]), mixed)).toBe("sign");
    expect(signFirst.map((r) => [r.pr.number, r.blocked])).toEqual([
      [482, null],
      [512, "other-kind"],
    ]);
  });

  test("the outcome: ready to merge at the inbox step, the agent at a set-up repo", async () => {
    const all = await inbox();
    const at = (n: number) => all.find((p) => p.number === n)!;
    expect(outcomeOf(at(512), people)).toEqual({ text: "ready to merge", tone: "ok" });
    expect(outcomeSentence([at(512), at(515)], people, "before")).toBe(
      "Two will be ready to merge.",
    );
    expect(outcomeSentence([at(512)], people, "after")).toBe("One is ready to merge now.");
    const running = { ...at(512), checks: { ...at(512).checks, state: "pending" as const } };
    expect(outcomeOf(running, people, "after").text).toBe("ready after CI");
    // A set-up repo: an approval fills the slot like a nod; the agent merges.
    const approve = { kind: "approve", label: "Approve", then: { outcome: "satisfied" } } as const;
    expect(outcomeOf({ ...pr(482), ask: approve }, people).text).toBe(
      "check turns green, the agent merges",
    );
  });

  describe("the state machine: review → approving → approved / stale / error", () => {
    const rows = [pr(482), pr(485)];
    const entries = rows.map((p) => ({ pr: p.number, head_sha: p.headSha }));
    const approve: Extract<BatchEvent, { t: "approve" }> = { t: "approve", rows, entries };
    const result: ApproveResult = {
      posted: [{ pr: 482, url: "r1" }],
      failed: [{ pr: 485, message: "GitHub said no." }],
    };
    const run = (...events: BatchEvent[]) =>
      events.reduce<BatchState>((s, e) => batchReducer(s, e), INITIAL_BATCH);

    test("no unlock, ever: review → approving → approved", () => {
      expect(run(approve)).toEqual({
        step: "approving",
        attempt: { shown: rows, entries, prior: null },
      });
      expect(run(approve, { t: "approved", result })).toEqual({
        step: "approved",
        shown: rows,
        result,
      });
      expect(run({ ...approve, entries: [] })).toBe(INITIAL_BATCH);
    });

    test("stale: nothing approved, the moved PRs listed; back to review", () => {
      const stale = [{ pr: 482, signed: "a", current: "b" }];
      const s = run(approve, {
        t: "approve-failed",
        failure: { code: "stale", message: "#482 changed" },
        details: { stale },
      });
      expect(s).toEqual({ step: "stale", stale });
      expect(batchReducer(s, { t: "back" })).toBe(INITIAL_BATCH);
    });

    test("any other failure: the error step; my own PR too", () => {
      const s = run(approve, {
        t: "approve-failed",
        failure: { code: "forbidden", message: "#519 is your own pull request." },
      });
      expect(s).toEqual({
        step: "error",
        failure: { code: "forbidden", message: "#519 is your own pull request." },
      });
    });

    test("retrying the failed ones keeps what was approved", () => {
      const approved = run(approve, { t: "approved", result });
      const retry = batchReducer(approved, { t: "approve", rows: [], entries: [entries[1]!] });
      expect(retry).toMatchObject({ step: "approving", attempt: { shown: rows, prior: result } });
      expect(
        batchReducer(retry, {
          t: "approved",
          result: { posted: [{ pr: 485, url: "r2" }], failed: [] },
        }),
      ).toMatchObject({ result: { posted: [{ pr: 482 }, { pr: 485 }], failed: [] } });
      expect(
        batchReducer(retry, { t: "approve-failed", failure: { code: "github", message: "Down." } }),
      ).toEqual({
        step: "approved",
        shown: rows,
        result: { ...result, failed: [{ pr: 485, message: "Down." }] },
      });
      expect(mergeApprovals(null, result)).toBe(result);
    });

    test("events that do not fit the step change nothing", () => {
      expect(batchReducer(INITIAL_BATCH, { t: "approved", result })).toBe(INITIAL_BATCH);
      const approving = run(approve);
      expect(batchReducer(approving, { t: "back" })).toBe(approving);
      expect(batchReducer(approving, { t: "sign", readiness: "unlocked", rows, entries })).toBe(
        approving,
      );
      expect(batchReducer(run(approve, { t: "approved", result }), { t: "back" }).step).toBe(
        "approved",
      );
    });
  });

  test("canSignWith: an active key, locked or not", () => {
    expect(canSignWith(null)).toBe(false);
    expect(canSignWith({ state: "no-key" })).toBe(false);
    const key = (state: "active" | "not-enrolled") =>
      ({
        fingerprint: "SHA256:x",
        publicKey: "ssh-ed25519 AAAA",
        location: "/tmp/k",
        enrolment: { state },
      }) as const;
    expect(canSignWith({ state: "locked", key: key("active") })).toBe(true);
    expect(canSignWith({ state: "locked", key: key("not-enrolled") })).toBe(false);
  });

  test("roleShort: approve", () => {
    expect(roleShort("approve")).toBe("approve");
  });
});
