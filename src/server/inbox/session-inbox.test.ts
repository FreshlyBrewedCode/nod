/**
 * My inbox through the protocol, end to end: the fake source, the real
 * runner (a subprocess over a temp inbox folder), the service and the
 * session. What a tab sees: `welcome.inbox`, `personal` on the snapshot's
 * PRs (and the tier it moves), `insights` pushes, `open-insights`, and the
 * `inbox` push when the file stops loading.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tempDir } from "../../kit/test-support.ts";
import { tier } from "../../shared/attention";
import type { PrView, Reply, ServerToClient, Snapshot } from "../../shared/protocol";
import { ManualClock } from "../clock";
import { FakeSource } from "../fake-source";
import { Session } from "../session";
import { FakeSigner } from "../signer";
import { inboxEnv } from "./env";
import { startInbox, type StartedInbox } from "./setup";

const R = "tallyho/fieldbook";

const INBOX = `
import { defineAnalyzer, defineInbox, stats, text, watch } from "@frebreco/nod/kit/inbox";
export default defineInbox({
  classifiers: [watch("modules/billing/**", { tag: "billing" })],
  analyzers: [
    defineAnalyzer({ id: "count", title: "Files", when: "poll", run: ({ files }) => stats([{ label: "files", value: files.length }]) }),
    defineAnalyzer({ id: "deep", title: "Deep", when: "open", appliesTo: ({ pr }) => pr.number === 483, run: () => text("deep") }),
  ],
});
`;

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function until(ok: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

test("a tab sees my inbox: status, personal attention, insights, open-insights, a load error", async () => {
  const { dir, cleanup } = await tempDir("nod-inbox-");
  stops.push(cleanup);
  const { dir: home, cleanup: cleanHome } = await tempDir("nod-home-");
  stops.push(cleanHome);
  await writeFile(join(dir, "inbox.ts"), INBOX);

  const clock = new ManualClock(Date.UTC(2026, 10, 18, 14, 20));
  const source = new FakeSource({ clock });
  const signer = new FakeSigner(clock, { hasKey: true });
  const inbox: StartedInbox = startInbox({
    dir,
    source,
    log: () => {},
    runner: {
      env: inboxEnv({ PATH: process.env.PATH, HOME: home }),
      debounceMs: 50,
      size: 1,
    },
  });
  stops.push(() => inbox.stop());
  const session = new Session({
    source,
    signer,
    clock,
    version: null,
    fake: true,
    inbox: inbox.service,
  });
  stops.push(() => session.stop());

  const messages: ServerToClient[] = [];
  const client = {
    side: "loopback" as const,
    send: (d: string) => void messages.push(JSON.parse(d)),
  };
  await session.attach(client);
  const welcome = messages[0] as Extract<ServerToClient, { t: "welcome" }>;
  expect(welcome.inbox).toMatchObject({ path: dir, config: "yours" });

  const snapshots = () =>
    messages.filter((m): m is Snapshot & { t: "snapshot" } => m.t === "snapshot");
  const pr = (n: number) =>
    snapshots()
      .at(-1)!
      .prs.find((p) => p.number === n) as PrView;
  await until(() => pr(483)?.personal !== undefined);
  // +1 from my watch: folded (tier 4) becomes a one-liner; the risk stays the repo's.
  expect(pr(483).personal).toMatchObject({ attention: 1, tags: ["billing"] });
  expect([tier(pr(483)), pr(483).risk]).toEqual([3, 2]);
  expect(tier({ ...pr(483), personal: undefined })).toBe(4);

  const insights = (n: number) =>
    messages.filter(
      (m): m is Extract<ServerToClient, { t: "insights" }> => m.t === "insights" && m.pr === n,
    );
  await until(() => insights(483).some((m) => m.insights[0]?.status === "ready"));
  expect(insights(483)[0]!.insights).toEqual([
    { id: "count", title: "Files", origin: "yours", when: "poll", status: "running" },
  ]);
  expect(insights(483).at(-1)!.insights[0]).toMatchObject({
    status: "ready",
    insight: { blocks: [{ type: "stats", items: [{ label: "files" }] }] },
  });

  // The panel opens: the open analyzer runs, its result is pushed.
  await session.handle(client, JSON.stringify({ t: "open-insights", id: "o1", repo: R, pr: 483 }));
  const reply = messages.find((m): m is Reply => m.t === "reply" && m.id === "o1")!;
  expect(
    reply.ok &&
      (reply.result as { insights: { id: string; status: string }[] }).insights.map((s) => [
        s.id,
        s.status,
      ]),
  ).toEqual([
    ["count", "ready"],
    ["deep", "running"],
  ]);
  await until(() => insights(483).at(-1)!.insights[1]?.status === "ready");
  await session.handle(client, JSON.stringify({ t: "open-insights", id: "o2", repo: R, pr: "x" }));
  expect(messages.find((m): m is Reply => m.t === "reply" && m.id === "o2")).toMatchObject({
    ok: false,
    error: { code: "bad-request" },
  });

  // A save that breaks it: the inbox push says so; what was shown stays.
  await writeFile(join(dir, "inbox.ts"), "export default defineInbox({");
  await until(() => messages.some((m) => m.t === "inbox" && m.inbox.state === "error"));
  const last = messages.filter((m) => m.t === "inbox").at(-1) as Extract<
    ServerToClient,
    { t: "inbox" }
  >;
  expect(last.inbox.error).toContain("inbox.ts does not load");
  // Its parts are the last good load's.
  expect(last.inbox.analyzers.map((a) => a.id)).toEqual(["count", "deep"]);
  session.handle(client, JSON.stringify({ t: "refresh", id: "r1" }));
  await Bun.sleep(100);
  expect(pr(483).personal?.tags).toEqual(["billing"]);
}, 30_000);
