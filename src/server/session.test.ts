import { describe, expect, test } from "bun:test";

import type { PrView, Reply, ServerToClient, Snapshot } from "../shared/protocol";
import { ManualClock } from "./clock";
import { FakeSource, scenarioHasKey, type FakeScenario } from "./fake-source";
import { Session, parseRequest } from "./session";
import { FakeSigner, fakeSignature, type Side } from "./signer";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const SECOND = 1000;

function setup(scenario: FakeScenario = "team") {
  const clock = new ManualClock(NOW);
  const source = new FakeSource({ clock, scenario, mergeDelayMs: 4 * SECOND });
  const signer = new FakeSigner(clock, { hasKey: scenarioHasKey(scenario) });
  const session = new Session({ source, signer, clock, version: null, fake: true });
  const tab = (side: Side = "loopback") => {
    const messages: ServerToClient[] = [];
    const client = {
      side,
      send: (data: string) => void messages.push(JSON.parse(data) as ServerToClient),
    };
    let id = 0;
    const ask = async (t: string, body: Record<string, unknown> = {}): Promise<Reply> => {
      const rid = `q${++id}`;
      await session.handle(client, JSON.stringify({ ...body, t, id: rid }));
      const reply = messages.find((m) => m.t === "reply" && m.id === rid);
      if (!reply) throw new Error(`no reply to ${t}`);
      return reply as Reply;
    };
    const last = <T extends ServerToClient["t"]>(t: T) =>
      messages.filter((m): m is Extract<ServerToClient, { t: T }> => m.t === t).at(-1);
    const snapshot = () => last("snapshot") as (Snapshot & { t: "snapshot" }) | undefined;
    const pr = (n: number) => snapshot()!.prs.find((p) => p.number === n) as PrView;
    return { client, messages, ask, last, snapshot, pr };
  };
  return { clock, source, signer, session, tab };
}

const ok = (reply: Reply) => {
  if (!reply.ok) throw new Error(`${reply.to} failed: ${reply.error.code} ${reply.error.message}`);
  return reply.result as never;
};
const err = (reply: Reply) => (reply.ok ? "ok" : reply.error.code);

describe("connecting", () => {
  test("welcome, then the snapshot", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    expect(t.messages.map((m) => m.t)).toEqual(["welcome", "snapshot"]);
    const welcome = t.messages[0] as Extract<ServerToClient, { t: "welcome" }>;
    expect(welcome).toMatchObject({
      protocol: 1,
      version: null,
      fake: true,
      me: { login: "mara-l" },
      repo: "tallyho/fieldbook",
      setup: { state: "ready" },
      signer: { state: "locked", key: { enrolment: { state: "active" } } },
    });
    expect(t.snapshot()!.prs).toHaveLength(18);
  });

  test("the inbox scenario: step 0, no key, the PRs classified locally once ready", async () => {
    const { session, source, tab } = setup("inbox");
    const t = tab();
    await source.ready;
    await session.attach(t.client);
    expect(t.last("welcome")).toMatchObject({
      repo: "tallyho/fieldbook",
      setup: { state: "missing", step: "inbox" },
      signer: { state: "no-key" },
    });
    const prs = t.snapshot()!.prs;
    expect(prs.length).toBeGreaterThan(8);
    expect(prs.every((p) => p.classifiedBy === "local")).toBe(true);
    expect(prs.filter((p) => p.needsMe).map((p) => p.number)).toEqual([512, 515, 509, 511]);
    expect(prs.filter((p) => p.ask).map((p) => [p.number, p.ask?.kind])).toEqual([
      [512, "approve"],
      [515, "approve"],
    ]);
  });

  test("before a repo is picked there is no snapshot", async () => {
    const { session, tab } = setup("fresh");
    const t = tab();
    await session.attach(t.client);
    expect(t.messages.map((m) => m.t)).toEqual(["welcome"]);
    expect(t.last("welcome")).toMatchObject({
      repo: null,
      setup: { state: "none" },
      signer: { state: "no-key" },
    });
  });

  test("every tab gets every push; a closed tab gets nothing", async () => {
    const { session, tab } = setup();
    const a = tab();
    const b = tab();
    await session.attach(a.client);
    await session.attach(b.client);
    await a.ask("unlock", { passphrase: "pass" });
    expect(a.last("signer")?.signer.state).toBe("unlocked");
    expect(b.last("signer")?.signer.state).toBe("unlocked");
    session.detach(b.client);
    await a.ask("lock");
    expect(b.last("signer")?.signer.state).toBe("unlocked");
    expect(a.last("signer")?.signer.state).toBe("locked");
  });
});

describe("a side each (ADR 0005)", () => {
  test("an unlock on loopback neither unlocks nor signs for the named host, and back", async () => {
    const { session, tab } = setup();
    const desk = tab("loopback");
    const desk2 = tab("loopback");
    const phone = tab("named-host");
    for (const t of [desk, desk2, phone]) await session.attach(t.client);
    const entries = [{ pr: 482, head_sha: desk.pr(482).headSha }];

    ok(await desk.ask("unlock", { passphrase: "pass" }));
    // Tabs of one side share its window; the other side is told it is locked.
    expect(desk2.last("signer")?.signer.state).toBe("unlocked");
    expect(phone.last("signer")?.signer.state).toBe("locked");
    expect(err(await phone.ask("sign", { entries, verdict: "approve" }))).toBe("locked");
    expect(err(await phone.ask("test-signature"))).toBe("locked");

    // The phone's own unlock, and its lock, leave the desk alone.
    ok(await phone.ask("unlock", { passphrase: "pass", once: true }));
    expect(phone.last("signer")?.signer).toMatchObject({ state: "unlocked", once: true });
    expect(desk.last("signer")?.signer).toMatchObject({ state: "unlocked", once: false });
    ok(await phone.ask("lock"));
    expect(phone.last("signer")?.signer.state).toBe("locked");
    expect(desk.last("signer")?.signer.state).toBe("unlocked");

    // And the other way round: a window opened on the phone does not sign for the desk.
    ok(await desk.ask("lock"));
    ok(await phone.ask("unlock", { passphrase: "pass" }));
    expect(desk.last("signer")?.signer.state).toBe("locked");
    expect(err(await desk.ask("sign", { entries, verdict: "approve" }))).toBe("locked");
    ok(await phone.ask("sign", { entries, verdict: "approve" }));

    // A tab that connects later is welcomed with its own side's state.
    const late = tab("loopback");
    await session.attach(late.client);
    expect(late.last("welcome")?.signer.state).toBe("locked");
  });
});

describe("unlock, sign, ack", () => {
  test("the round trip: a signed PR is satisfied, then merges after a few seconds", async () => {
    const { session, tab, clock } = setup();
    const t = tab();
    await session.attach(t.client);
    expect(err(await t.ask("unlock", { passphrase: "wrong" }))).toBe("bad-passphrase");
    const { until } = ok(await t.ask("unlock", { passphrase: "correct horse", minutes: 15 })) as {
      until: number;
    };
    expect(until).toBe(NOW + 15 * 60 * SECOND);

    const before = t.pr(482);
    expect([before.needsMe, before.ask?.kind]).toEqual([true, "peer"]);
    const result = ok(
      await t.ask("sign", {
        entries: [
          { pr: 482, head_sha: before.headSha },
          { pr: 488, head_sha: t.pr(488).headSha },
        ],
        verdict: "approve",
        note: "Billing looks right.",
      }),
    ) as { payload: string; posted: { pr: number; url: string }[]; failed: unknown[] };

    const payload = JSON.parse(result.payload);
    expect(payload).toEqual({
      v: 1,
      repo: "tallyho/fieldbook",
      entries: [
        { pr: 482, base: "main", head_sha: before.headSha, patch_id: before.patchId },
        { pr: 488, base: "main", head_sha: t.pr(488).headSha, patch_id: t.pr(488).patchId },
      ],
      verdict: "approve",
      level: "review",
      reviewer: "mara-l",
      signed_at: new Date(NOW).toISOString(),
    });
    expect(result.posted.map((p) => p.pr)).toEqual([482, 488]);
    expect(result.failed).toEqual([]);

    const after = t.pr(482);
    expect([after.needsMe, after.requirement.satisfied, after.state]).toEqual([
      false,
      true,
      "open",
    ]);
    expect(after.signatures.at(-1)).toMatchObject({
      by: "mara-l",
      byMe: true,
      level: "peer",
      counts: true,
      batchSize: 2,
    });
    expect(after.lastActivity.text).toBe("you signed");
    expect(after.waitingOn).toEqual([{ kind: "merge" }]);
    expect(t.pr(488).signatures.at(-1)?.level).toBe("self");

    clock.advance(4 * SECOND);
    expect(t.pr(482).state).toBe("merged");
    expect(t.pr(488).state).toBe("merged");
    expect(t.pr(482).journey.at(-1)?.text).toBe("Merged");
  });

  test("a nod that does not complete the requirement leaves it waiting (#485 waits on Jonas)", async () => {
    const { session, tab, clock } = setup();
    const t = tab();
    await session.attach(t.client);
    await t.ask("unlock", { passphrase: "pass" });
    ok(
      await t.ask("sign", {
        entries: [{ pr: 485, head_sha: t.pr(485).headSha }],
        verdict: "approve",
      }),
    );
    clock.advance(60 * SECOND);
    const pr = t.pr(485);
    expect([pr.needsMe, pr.state, pr.requirement.satisfied]).toEqual([false, "open", false]);
    expect(pr.waitingOn).toEqual([{ kind: "person", login: "jonas-r" }]);
  });

  test("re-attesting a PR whose content changed", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    await t.ask("unlock", { passphrase: "pass" });
    expect(t.pr(491).ask?.kind).toBe("re-attest");
    ok(
      await t.ask("sign", {
        entries: [{ pr: 491, head_sha: t.pr(491).headSha }],
        verdict: "approve",
      }),
    );
    const pr = t.pr(491);
    expect(pr.needsMe).toBe(false);
    expect(pr.signatures.map((s) => s.counts)).toEqual([false, true]);
  });

  test("all or nothing: one entry that moved since I looked signs nothing", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    await t.ask("unlock", { passphrase: "pass" });
    const reply = await t.ask("sign", {
      entries: [
        { pr: 482, head_sha: t.pr(482).headSha },
        { pr: 485, head_sha: "41aa9e7" + "0".repeat(33) },
      ],
      verdict: "approve",
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("stale");
    expect(reply.error.details?.stale).toEqual([
      { pr: 485, signed: "41aa9e7" + "0".repeat(33), current: t.pr(485).headSha },
    ]);
    expect(t.pr(482).needsMe).toBe(true);
  });

  test("refusals: locked, merged, unknown PR, bad requests", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    const sign = (entries: unknown, extra: Record<string, unknown> = {}) =>
      t.ask("sign", { entries, verdict: "approve", ...extra });
    expect(err(await sign([{ pr: 482, head_sha: t.pr(482).headSha }]))).toBe("locked");
    await t.ask("unlock", { passphrase: "pass" });
    expect(err(await sign([{ pr: 489, head_sha: t.pr(489).headSha }]))).toBe("not-open");
    expect(err(await sign([{ pr: 1, head_sha: "a".repeat(40) }]))).toBe("not-found");
    expect(err(await sign([]))).toBe("bad-request");
    expect(err(await sign([{ pr: 482, head_sha: "nope" }]))).toBe("bad-request");
    expect(
      err(
        await sign([
          { pr: 482, head_sha: "a".repeat(40) },
          { pr: 482, head_sha: "a".repeat(40) },
        ]),
      ),
    ).toBe("bad-request");
    expect(err(await sign([{ pr: 482, head_sha: t.pr(482).headSha }], { verdict: "reject" }))).toBe(
      "bad-request",
    );
    expect(err(await t.ask("nope"))).toBe("bad-request");
    expect(t.pr(482).needsMe).toBe(true);
  });

  test("once: the key locks again after the batch", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    await t.ask("unlock", { passphrase: "pass", once: true });
    ok(
      await t.ask("sign", {
        entries: [{ pr: 482, head_sha: t.pr(482).headSha }],
        verdict: "approve",
      }),
    );
    expect(t.last("signer")?.signer.state).toBe("locked");
  });

  test("auto-lock is pushed to every tab", async () => {
    const { session, tab, clock } = setup();
    const t = tab();
    await session.attach(t.client);
    await t.ask("unlock", { passphrase: "pass", minutes: 1 });
    expect(t.last("signer")?.signer).toMatchObject({ state: "unlocked", until: NOW + 60 * SECOND });
    clock.advance(60 * SECOND);
    expect(t.last("signer")?.signer.state).toBe("locked");
  });

  test("Got it: an FYI ack moves the PR out of Worth knowing", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    expect(t.pr(478).fyiForMe).toBe(true);
    ok(await t.ask("ack-fyi", { pr: 478 }));
    expect(t.pr(478).fyiForMe).toBe(false);
    expect(t.pr(478).fyi?.acked).toContain("mara-l");
    expect(err(await t.ask("ack-fyi", { pr: 482 }))).toBe("not-found");
  });

  test("a pending key reads everything and signs nothing", async () => {
    const { session, tab } = setup("first-run");
    const t = tab();
    await session.attach(t.client);
    expect(t.last("welcome")?.signer).toMatchObject({
      key: { enrolment: { state: "pending", pr: { number: 494 } } },
    });
    expect(t.snapshot()).toMatchObject({ prs: [], unclassified: { length: 7 } });
    await t.ask("unlock", { passphrase: "pass" });
    expect(
      err(
        await t.ask("sign", {
          entries: [{ pr: 482, head_sha: "a".repeat(40) }],
          verdict: "approve",
        }),
      ),
    ).toBe("key-pending");
  });
});

describe("approve (ADR 0006): a GitHub approval, no key", () => {
  test("the inbox: approving answers the review request, the rows leave needs me", async () => {
    const { session, source, tab } = setup("inbox");
    await source.ready;
    const t = tab();
    await session.attach(t.client);
    const result = ok(
      await t.ask("approve", {
        entries: [
          { pr: 512, head_sha: t.pr(512).headSha },
          { pr: 515, head_sha: t.pr(515).headSha },
        ],
      }),
    ) as { posted: { pr: number; url: string }[]; failed: unknown[] };
    expect(result.posted.map((p) => p.pr)).toEqual([512, 515]);
    expect(result.posted[0]!.url).toMatch(/\/pull\/512#pullrequestreview-\d+$/);
    expect(result.failed).toEqual([]);
    expect([t.pr(512).needsMe, t.pr(512).ask, t.pr(515).needsMe]).toEqual([false, null, false]);
    expect(t.pr(512).review).toMatchObject({ approvedBy: ["mara-l"], fromMe: false });
    expect(t.pr(512).journey.some((e) => e.text === "You approved")).toBe(true);
    // No key was asked for: there is none.
    expect(t.last("welcome")?.signer.state).toBe("no-key");
    expect(t.last("signer")).toBeUndefined();
  });

  test("join: a set-up repo without my key; an approval fills the peer slot, the PR merges", async () => {
    const { session, tab, clock } = setup("join");
    const t = tab();
    await session.attach(t.client);
    expect(t.pr(482).ask?.kind).toBe("approve");
    // Ines approved #485 on GitHub already: its peer slot is filled, it waits on Jonas.
    expect(t.pr(485).requirement.slots.find((s) => s.role === "peer")).toMatchObject({
      state: "ok",
      approval: "inescal",
      signature: null,
    });
    expect([t.pr(485).needsMe, t.pr(485).ask]).toEqual([false, null]);
    ok(await t.ask("approve", { entries: [{ pr: 482, head_sha: t.pr(482).headSha }] }));
    expect(t.pr(482).requirement).toMatchObject({ satisfied: true });
    expect(t.pr(482).requirement.slots[0]).toMatchObject({ state: "ok", approval: "mara-l" });
    expect(t.pr(482).needsMe).toBe(false);
    clock.advance(4 * SECOND);
    expect(t.pr(482).state).toBe("merged");
  });

  test("all or nothing: one entry that moved since I looked approves nothing", async () => {
    const { session, source, tab } = setup("inbox");
    await source.ready;
    const t = tab();
    await session.attach(t.client);
    const moved = "41aa9e7" + "0".repeat(33);
    const reply = await t.ask("approve", {
      entries: [
        { pr: 512, head_sha: t.pr(512).headSha },
        { pr: 515, head_sha: moved },
      ],
    });
    expect(err(reply)).toBe("stale");
    if (reply.ok) return;
    expect(reply.error.message).toMatch(/Nothing was approved/);
    expect(reply.error.details?.stale).toEqual([
      { pr: 515, signed: moved, current: t.pr(515).headSha },
    ]);
    expect([t.pr(512).needsMe, t.pr(515).needsMe]).toEqual([true, true]);
  });

  test("refusals: my own PR, a draft, unknown, bad requests", async () => {
    const { session, source, tab } = setup("inbox");
    await source.ready;
    const t = tab();
    await session.attach(t.client);
    const approve = (entries: unknown) => t.ask("approve", { entries });
    const own = await approve([
      { pr: 512, head_sha: t.pr(512).headSha },
      { pr: 519, head_sha: t.pr(519).headSha },
    ]);
    expect(err(own)).toBe("forbidden");
    if (!own.ok) expect(own.error.message).toMatch(/#519 is your own pull request/);
    // Nothing was approved, not even the other one.
    expect(t.pr(512).needsMe).toBe(true);
    expect(err(await approve([{ pr: 518, head_sha: t.pr(518).headSha }]))).toBe("not-open");
    expect(err(await approve([{ pr: 506, head_sha: t.pr(506).headSha }]))).toBe("not-open");
    expect(err(await approve([{ pr: 1, head_sha: "a".repeat(40) }]))).toBe("not-found");
    expect(err(await approve([]))).toBe("bad-request");
    expect(err(await approve([{ pr: 512, head_sha: "nope" }]))).toBe("bad-request");
  });
});

describe("onboarding", () => {
  test("fresh: pick a repo, create a key, open the setup PR, test signature", async () => {
    const { session, tab } = setup("fresh");
    const t = tab();
    await session.attach(t.client);
    const repos = ok(await t.ask("list-repos")) as {
      account: { login: string };
      repos: { repo: string }[];
    };
    expect(repos.account.login).toBe("mara-l");
    expect(repos.repos[0]).toMatchObject({ repo: "tallyho/fieldbook", current: true });
    expect(err(await t.ask("check-setup"))).toBe("no-repo");

    const picked = ok(await t.ask("pick-repo", { repo: "tallyho/fieldbook" })) as {
      setup: { state: string };
    };
    expect(picked.setup.state).toBe("missing");
    expect(t.last("setup")?.setup.state).toBe("missing");

    expect(err(await t.ask("create-key", { passphrase: "short" }))).toBe("weak-passphrase");
    ok(await t.ask("create-key", { passphrase: "a long passphrase" }));
    expect(t.last("signer")?.signer).toMatchObject({
      state: "locked",
      key: { enrolment: { state: "not-enrolled" } },
    });

    const { pr } = ok(await t.ask("open-setup-pr")) as { pr: { number: number } };
    expect(pr.number).toBe(494);
    expect(t.last("setup")?.setup).toMatchObject({ state: "pending", setupPr: { number: 494 } });
    // the first key rides in the setup PR
    expect(t.last("signer")?.signer).toMatchObject({
      key: { enrolment: { state: "pending", pr: { number: 494 } } },
    });

    expect(err(await t.ask("test-signature"))).toBe("locked");
    await t.ask("unlock", { passphrase: "a long passphrase" });
    const test = ok(await t.ask("test-signature")) as {
      payload: string;
      signature: string;
      verified: boolean;
    };
    expect(test.verified).toBe(true);
    expect(test.signature).toBe(fakeSignature(test.payload));
    expect(() => JSON.parse(test.payload)).toThrow(); // never a nod payload
  });

  test("join: a set-up repo, a new key, the enrolment PR", async () => {
    const { session, tab } = setup("join");
    const t = tab();
    await session.attach(t.client);
    expect(err(await t.ask("open-enrol-pr"))).toBe("no-key");
    ok(await t.ask("create-key", { passphrase: "a long passphrase" }));
    expect(err(await t.ask("open-setup-pr"))).toBe("already-set-up");
    const { pr } = ok(await t.ask("open-enrol-pr")) as { pr: { number: number } };
    expect(pr.number).toBe(501);
    expect(t.last("signer")?.signer).toMatchObject({
      key: { enrolment: { state: "pending", pr: { number: 501 } } },
    });
  });

  test("team: the key is enrolled already", async () => {
    const { session, tab } = setup();
    const t = tab();
    await session.attach(t.client);
    expect(err(await t.ask("open-enrol-pr"))).toBe("already-enrolled");
    expect(err(await t.ask("create-key", { passphrase: "a long passphrase" }))).toBe("key-exists");
  });

  test("clear: nothing needs me", async () => {
    const { session, tab } = setup("clear");
    const t = tab();
    await session.attach(t.client);
    const prs = t.snapshot()!.prs;
    expect(prs.filter((p) => p.needsMe || p.fyiForMe)).toEqual([]);
    expect(prs.find((p) => p.number === 485)?.waitingOn).toEqual([
      { kind: "person", login: "jonas-r" },
    ]);
  });
});

test("parseRequest keeps only what the protocol defines", () => {
  expect(
    parseRequest(JSON.stringify({ t: "unlock", id: "1", passphrase: "p", minutes: 5, extra: 1 })),
  ).toEqual({
    t: "unlock",
    id: "1",
    passphrase: "p",
    minutes: 5,
  });
  expect(() => parseRequest("{")).toThrow();
  expect(() => parseRequest(JSON.stringify({ t: "unlock", id: "1" }))).toThrow();
  expect(() => parseRequest(JSON.stringify({ t: "ack-fyi", id: "1", pr: "482" }))).toThrow();
  expect(() => parseRequest(JSON.stringify({ t: "lock" }))).toThrow();
  const head = "a".repeat(40);
  expect(
    parseRequest(
      JSON.stringify({ t: "approve", id: "2", entries: [{ pr: 7, head_sha: head }], verdict: "x" }),
    ),
  ).toEqual({ t: "approve", id: "2", entries: [{ pr: 7, head_sha: head }] });
  expect(() =>
    parseRequest(JSON.stringify({ t: "approve", id: "2", entries: [{ pr: 7 }] })),
  ).toThrow();
});
