/**
 * The inbox service over the fake source and a stub runner: what runs when,
 * the cache keys (analyzer and patch-id), what stays on screen, `open`
 * analyzers, a reload, and what `decorate` adds to a snapshot.
 */
import { describe, expect, test } from "bun:test";

import { combineAttention } from "../../kit/inbox/run.ts";
import type { InboxIO, InsightState } from "../../kit/inbox/types.ts";
import type { InboxStatus, Snapshot } from "../../shared/protocol";
import { ManualClock } from "../clock";
import { FakeSource } from "../fake-source";
import { InboxService, Lru, type InboxEvent, type InboxSource, type RunnerLike } from "./service";
import type { JobInput, PlannedAnalyzer } from "./wire";

const REPO = "tallyho/fieldbook";

class StubRunner implements RunnerLike {
  generation = 1;
  isReady = true;
  readonly prepares: number[] = [];
  readonly analyses: string[] = [];
  /** Hold analyzers until `release()`. */
  hold = false;
  /** Answer analyze with null (it could not run). */
  skip = false;
  private readonly pending: Array<() => void> = [];
  private readonly listeners = new Set<(e: "status" | "loaded") => void>();

  status(): InboxStatus {
    return {
      config: "yours",
      path: "/x",
      state: "ready",
      error: null,
      classifiers: [],
      analyzers: [],
    };
  }
  subscribe(l: (e: "status" | "loaded") => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: "status" | "loaded") {
    for (const l of this.listeners) l(e);
  }
  async prepare(job: JobInput) {
    this.prepares.push(job.input.pr.number);
    const plan = (id: string, when: "poll" | "open"): PlannedAnalyzer => ({
      id,
      title: id,
      when,
      origin: "yours",
      key: `${id}:${job.patchId}`,
    });
    return {
      attention:
        job.input.pr.number === 483
          ? combineAttention([
              { classifier: "watch(billing)", attention: 1, tag: "billing", detail: "billing" },
            ])
          : combineAttention([]),
      analyzers: [plan("size", "poll"), plan("later", "open")],
    };
  }
  async analyze(job: JobInput, a: PlannedAnalyzer, _io: InboxIO): Promise<InsightState | null> {
    this.analyses.push(`${a.id}#${job.input.pr.number}`);
    if (this.hold) await new Promise<void>((r) => this.pending.push(r));
    if (this.skip) return null;
    return {
      id: a.id,
      title: a.title,
      origin: a.origin,
      when: a.when,
      status: "ready",
      insight: { blocks: [{ type: "stats", items: [{ label: "gen", value: this.generation }] }] },
    };
  }
  release() {
    for (const r of this.pending.splice(0)) r();
  }
}

/** The fake team, with a way to move one PR's head and patch-id. */
function setup() {
  const fake = new FakeSource({ clock: new ManualClock(Date.UTC(2026, 10, 18, 14, 20)) });
  const moved = new Map<number, { head?: string; patch?: string }>();
  const source: InboxSource = {
    snapshot: () => {
      const s = fake.snapshot()!;
      return {
        ...s,
        prs: s.prs.map((p) => {
          const m = moved.get(p.number);
          return m ? { ...p, headSha: m.head ?? p.headSha, patchId: m.patch ?? p.patchId } : p;
        }),
      };
    },
    repos: () => fake.repos(),
    inboxSubject: async (repo, pr) => {
      const s = await fake.inboxSubject(repo, pr);
      const m = moved.get(pr);
      return s && m
        ? {
            ...s,
            patchId: m.patch ?? s.patchId,
            pr: { ...s.pr, head_sha: m.head ?? s.pr.head_sha },
          }
        : s;
    },
  };
  const runner = new StubRunner();
  const service = new InboxService({ runner, source, log: () => {} });
  const events: InboxEvent[] = [];
  service.subscribe((e) => events.push(e));
  const open = fake.snapshot()!.prs.filter((p) => p.state === "open" || p.state === "draft");
  return { fake, source, runner, service, events, moved, open };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const of = (snapshot: Snapshot, n: number) => snapshot.prs.find((p) => p.number === n)!;

describe("the inbox service", () => {
  test("a round: every open PR classified once, its poll analyzers run, results pushed", async () => {
    const { runner, service, events, open, source } = setup();
    runner.hold = true;
    service.schedule();
    await service.idle();
    expect([...runner.prepares].sort()).toEqual(open.map((p) => p.number).sort());
    expect(runner.analyses.every((a) => a.startsWith("size#"))).toBe(true); // `later` waits for open
    expect(events.filter((e) => e.t === "personal")).toHaveLength(1);
    // Running first, the snapshot is never held back.
    let shown = service.decorate(source.snapshot()!);
    expect(of(shown, 483).personal).toMatchObject({ attention: 1, tags: ["billing"] });
    expect(of(shown, 483).insights).toEqual([
      { id: "size", title: "size", origin: "yours", when: "poll", status: "running" },
    ]);
    // Merged PRs get nothing.
    expect(
      shown.prs.filter((p) => p.state === "merged").every((p) => !p.insights && !p.personal),
    ).toBe(true);
    runner.release();
    await settle();
    shown = service.decorate(source.snapshot()!);
    expect(of(shown, 483).insights![0]).toMatchObject({ status: "ready" });
    expect(events.some((e) => e.t === "insights" && e.pr === 483)).toBe(true);
  });

  test("nothing changed: no classifier and no analyzer runs again", async () => {
    const { runner, service } = setup();
    service.schedule();
    await service.idle();
    await settle();
    const [p, a] = [runner.prepares.length, runner.analyses.length];
    service.schedule();
    await service.idle();
    await settle();
    expect([runner.prepares.length, runner.analyses.length]).toEqual([p, a]);
  });

  test("cached by analyzer and patch-id: a rebase keeps the result, a content change runs it again", async () => {
    const { runner, service, moved, source } = setup();
    service.schedule();
    await service.idle();
    await settle();
    const analyses = runner.analyses.length;

    // Same patch-id, new head: classified again (the head is in its input), no analyzer runs.
    moved.set(483, { head: "c".repeat(40) });
    service.schedule();
    await service.idle();
    await settle();
    expect(runner.prepares.filter((n) => n === 483)).toHaveLength(2);
    expect(runner.analyses.length).toBe(analyses);

    // New content: a new patch-id, a new key; the old result stays on screen meanwhile.
    runner.hold = true;
    moved.set(483, { head: "d".repeat(40), patch: "e".repeat(40) });
    service.schedule();
    await service.idle();
    expect(runner.analyses.slice(analyses)).toEqual(["size#483"]);
    expect(of(service.decorate(source.snapshot()!), 483).insights![0]).toMatchObject({
      status: "ready",
    });
    runner.release();
  });

  test("open analyzers run when the panel opens, once per patch-id", async () => {
    const { runner, service } = setup();
    service.schedule();
    await service.idle();
    await settle();
    runner.hold = true;
    const now = await service.open(REPO, 482);
    expect(now.map((s) => [s.id, s.status])).toEqual([
      ["size", "ready"],
      ["later", "running"],
    ]);
    runner.release();
    await settle();
    expect(service.insights(REPO, 482).map((s) => s.status)).toEqual(["ready", "ready"]);
    const before = runner.analyses.length;
    await service.open(REPO, 482);
    expect(runner.analyses.length).toBe(before);
    // A PR it does not have, or one that is merged: what it has, nothing runs.
    expect(await service.open(REPO, 9999)).toEqual([]);
  });

  test("a reload drops the cache and runs everything again; results stay until replaced", async () => {
    const { runner, service, source, events } = setup();
    service.schedule();
    await service.idle();
    await settle();
    const analyses = runner.analyses.length;
    runner.hold = true;
    runner.generation = 2;
    runner.emit("loaded");
    await service.idle();
    expect(runner.analyses.length).toBe(analyses * 2);
    expect(of(service.decorate(source.snapshot()!), 483).insights![0]).toMatchObject({
      status: "ready",
      insight: { blocks: [{ items: [{ value: 1 }] }] },
    });
    runner.release();
    await settle();
    expect(of(service.decorate(source.snapshot()!), 483).insights![0]).toMatchObject({
      insight: { blocks: [{ items: [{ value: 2 }] }] },
    });
    runner.emit("status");
    expect(events.at(-1)).toEqual({ t: "status" });
  });

  test("an analyzer that could not run leaves no running state behind", async () => {
    const { runner, service } = setup();
    runner.skip = true;
    service.schedule();
    await service.idle();
    await settle();
    expect(service.insights(REPO, 483)).toEqual([]);
  });

  test("not loaded: nothing runs", async () => {
    const { runner, service } = setup();
    runner.isReady = false;
    service.schedule();
    await service.idle();
    expect(runner.prepares).toEqual([]);
  });

  test("myWork: my open PRs and their files, the repo layer's summary", async () => {
    const { service, source } = setup();
    const seen: JobInput[] = [];
    const runner = new StubRunner();
    const prepare = runner.prepare.bind(runner);
    runner.prepare = async (job: JobInput) => {
      seen.push(job);
      return prepare(job);
    };
    const s = new InboxService({ runner, source, log: () => {} });
    s.schedule();
    await s.idle();
    const job = seen.find((j) => j.input.pr.number === 481)!;
    expect(job.input.me).toBe("mara-l");
    expect(job.input.myWork.map((w) => w.number).sort()).toEqual([479, 488, 490, 491, 493]);
    expect(job.input.myWork.find((w) => w.number === 490)!.files).toContain(
      "core/tenant/context.ts",
    );
    expect(job.input.repoSummary).toMatchObject({
      source: "verifier",
      risk: 0,
      satisfied: expect.any(Boolean),
    });
    service.stop();
  });
});

test("the cache forgets the least recently used past its size", () => {
  const lru = new Lru<string, number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.get("a");
  lru.set("c", 3);
  expect([lru.get("a"), lru.get("b"), lru.get("c"), lru.size]).toEqual([1, undefined, 3, 2]);
});
