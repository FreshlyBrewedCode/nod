import { describe, expect, test } from "bun:test";

import type { PrView, Reply, ServerToClient, Snapshot } from "../shared/protocol";
import { ManualClock } from "./clock";
import { FakeSource, scenarioHasKey, type FakeScenario } from "./fake-source";
import { Session, parseRequest } from "./session";
import { FakeSigner, fakeSignature } from "./signer";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const SECOND = 1000;

function setup(scenario: FakeScenario = "team") {
  const clock = new ManualClock(NOW);
  const source = new FakeSource({ clock, scenario, mergeDelayMs: 4 * SECOND });
  const signer = new FakeSigner(clock, { hasKey: scenarioHasKey(scenario) });
  const session = new Session({ source, signer, clock, version: null, fake: true });
  const tab = () => {
    const messages: ServerToClient[] = [];
    const client = {
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
});
