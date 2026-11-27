import { expect, test } from "bun:test";

import { ManualClock } from "../clock";
import { CHECK_INTERVAL_MS, UpdateChecker } from "./checker";
import { memoryChannelStore } from "./channel-store";
import { FakeInstaller } from "./fake-installer";
import { FakeReleaseFeed } from "./fake-release-feed";
import { FeedRateLimited, type Channel, type ReleaseFeed, type ReleaseInfo } from "./release-feed";

const MIN = 60_000;
const T0 = Date.parse("2026-11-27T12:00:00Z");

const release = (version: string): ReleaseInfo => ({
  version,
  publishedAt: "2026-11-26T18:30:13Z",
  notes: `## ${version}\n\n* something`,
  url: `https://github.com/FreshlyBrewedCode/nod/releases/tag/v${version}`,
  prerelease: version.includes("-"),
});

/** Lets promise chains settle (the feed and installer fakes resolve in microtasks). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup(
  options: {
    version?: string | null;
    releases?: ReleaseInfo[];
    channel?: Channel | null;
    installer?: FakeInstaller;
    onInstalled?: (v: string) => void;
  } = {},
) {
  const clock = new ManualClock(T0);
  const feed = new FakeReleaseFeed({
    releases: options.releases ?? [release("0.3.0"), release("0.2.0"), release("0.3.1-next.2")],
  });
  const installer = options.installer ?? new FakeInstaller();
  const store = memoryChannelStore(options.channel ?? null);
  const checker = new UpdateChecker({
    version: "version" in options ? options.version : "0.2.0",
    feed,
    installer,
    channelStore: store,
    clock,
    onInstalled: options.onInstalled,
  });
  return { clock, feed, installer, store, checker };
}

test("starts idle and checks when started: an update on the channel is available", async () => {
  const { checker, feed } = setup();
  expect(checker.state).toMatchObject({
    current: "0.2.0",
    development: false,
    channel: "stable",
    status: "idle",
    latest: null,
    kind: null,
  });
  checker.start();
  expect(checker.state.status).toBe("checking");
  await settle();
  expect(feed.calls).toEqual(["stable"]);
  expect(checker.state).toMatchObject({
    status: "available",
    kind: "upgrade",
    checkedAt: T0,
    error: null,
    latest: { version: "0.3.0", url: expect.stringContaining("v0.3.0") },
    install: { method: "npm", command: "npm install -g @frebreco/nod@0.3.0" },
  });
  expect(checker.state.latest!.notes).toContain("## 0.3.0");
});

test("up to date when the channel wants the running version", async () => {
  const { checker } = setup({ version: "0.3.0" });
  checker.start();
  await settle();
  expect(checker.state).toMatchObject({
    status: "up-to-date",
    kind: null,
    latest: { version: "0.3.0" },
    install: { command: "npm install -g @frebreco/nod@latest" },
  });
});

test("the cadence: a check every ten minutes, scheduled from the end of the last", async () => {
  const { checker, feed, clock } = setup({ version: "0.3.0" });
  checker.start();
  await settle();
  expect(feed.calls).toHaveLength(1);
  expect(checker.state.nextCheckAt).toBe(T0 + CHECK_INTERVAL_MS);
  clock.advance(CHECK_INTERVAL_MS - 1);
  await settle();
  expect(feed.calls).toHaveLength(1);
  clock.advance(1);
  await settle();
  expect(feed.calls).toHaveLength(2);
  clock.advance(CHECK_INTERVAL_MS);
  await settle();
  expect(feed.calls).toHaveLength(3);
  // A background check does not flicker through "checking".
  const seen: string[] = [];
  checker.subscribe((s) => seen.push(s.status));
  clock.advance(CHECK_INTERVAL_MS);
  await settle();
  expect(seen).not.toContain("checking");
  checker.stop();
  expect(checker.state.nextCheckAt).toBeNull();
  clock.advance(CHECK_INTERVAL_MS * 3);
  await settle();
  expect(feed.calls).toHaveLength(4);
});

test("a new release shows up at the next tick", async () => {
  const { checker, feed, clock } = setup({ version: "0.3.0" });
  checker.start();
  await settle();
  expect(checker.state.status).toBe("up-to-date");
  feed.publish(release("0.4.0"));
  clock.advance(CHECK_INTERVAL_MS);
  await settle();
  expect(checker.state).toMatchObject({
    status: "available",
    kind: "upgrade",
    latest: { version: "0.4.0" },
  });
});

test("a development build checks nothing until asked, and never offers an update", async () => {
  for (const version of [null, undefined, "0.0.0-development"]) {
    const { checker, feed, clock } = setup({ version });
    checker.start();
    clock.advance(CHECK_INTERVAL_MS * 2);
    await settle();
    expect(feed.calls).toEqual([]);
    expect(checker.state).toMatchObject({
      current: null,
      development: true,
      status: "idle",
      nextCheckAt: null,
    });
    await checker.checkNow();
    expect(feed.calls).toEqual(["stable"]);
    expect(checker.state).toMatchObject({
      status: "idle",
      kind: null,
      latest: { version: "0.3.0" },
    });
    expect(clock.pending).toBe(0);
  }
});

test("checkNow resolves with the state, shows checking, and shares an in-flight check", async () => {
  const clock = new ManualClock(T0);
  let release_: (r: ReleaseInfo | null) => void = () => {};
  let calls = 0;
  const feed: ReleaseFeed = {
    latest: () => {
      calls++;
      return new Promise((resolve) => (release_ = resolve));
    },
  };
  const checker = new UpdateChecker({
    version: "0.2.0",
    feed,
    installer: new FakeInstaller(),
    channelStore: memoryChannelStore(),
    clock,
  });
  const first = checker.checkNow();
  const second = checker.checkNow();
  expect(checker.state.status).toBe("checking");
  release_(release("0.2.0"));
  const [a, b] = await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(a.status).toBe("up-to-date");
  expect(b).toBe(a);
});

test("an error is a state, not an exception, and the answer before it is kept", async () => {
  const { checker, feed } = setup();
  await checker.checkNow();
  expect(checker.state.status).toBe("available");
  feed.fail();
  await checker.checkNow();
  expect(checker.state).toMatchObject({
    status: "error",
    error: expect.stringContaining("fake outage"),
    kind: "upgrade",
    latest: { version: "0.3.0" },
  });
  feed.recover();
  await checker.checkNow();
  expect(checker.state).toMatchObject({ status: "available", error: null });
});

test("errors back off: a minute, two, four, … up to an hour; success resets", async () => {
  const { checker, feed, clock } = setup();
  feed.fail();
  checker.start();
  await settle();
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    delays.push(checker.state.nextCheckAt! - clock.now());
    clock.advance(delays.at(-1)!);
    await settle();
  }
  expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((m) => m * MIN));
  expect(feed.calls).toHaveLength(9);
  feed.recover();
  clock.advance(60 * MIN);
  await settle();
  expect(checker.state.status).toBe("available");
  expect(checker.state.nextCheckAt! - clock.now()).toBe(CHECK_INTERVAL_MS);
  feed.fail();
  clock.advance(CHECK_INTERVAL_MS);
  await settle();
  expect(checker.state.nextCheckAt! - clock.now()).toBe(MIN);
});

test("a rate limit waits until GitHub's reset, and Check now does not hit it meanwhile", async () => {
  const { checker, feed, clock } = setup();
  const reset = T0 + 25 * MIN;
  feed.fail(reset);
  checker.start();
  await settle();
  expect(checker.state.status).toBe("error");
  expect(checker.state.error).toContain("rate-limiting");
  expect(checker.state.error).toContain(new Date(reset).toISOString());
  expect(checker.state.nextCheckAt).toBe(reset);
  expect(feed.calls).toHaveLength(1);

  clock.advance(5 * MIN);
  await checker.checkNow();
  expect(feed.calls).toHaveLength(1);
  expect(checker.state.error).toContain("rate-limiting");
  expect(checker.state.nextCheckAt).toBe(reset);

  feed.recover();
  clock.advance(20 * MIN);
  await settle();
  expect(feed.calls).toHaveLength(2);
  expect(checker.state.status).toBe("available");
});

test("a rate limit that ends sooner than the cadence still waits the cadence; none given waits an hour", async () => {
  const soon = setup();
  soon.feed.fail(T0 + 2 * MIN);
  soon.checker.start();
  await settle();
  expect(soon.checker.state.nextCheckAt).toBe(T0 + CHECK_INTERVAL_MS);

  const vague = setup();
  vague.feed.failure = new FeedRateLimited(null);
  vague.checker.start();
  await settle();
  expect(vague.checker.state.nextCheckAt).toBe(T0 + 60 * MIN);
});

test("a feed that throws something odd is still just an error state", async () => {
  const clock = new ManualClock(T0);
  const checker = new UpdateChecker({
    version: "0.2.0",
    feed: {
      latest: () => {
        throw "not even an Error";
      },
    },
    installer: new FakeInstaller(),
    channelStore: memoryChannelStore(),
    clock,
  });
  await checker.checkNow();
  expect(checker.state).toMatchObject({ status: "error", error: "The update check failed." });
});

test("a repository without releases is up to date", async () => {
  const { checker } = setup({ releases: [] });
  await checker.checkNow();
  expect(checker.state).toMatchObject({ status: "up-to-date", latest: null, kind: null });
});

test("the channel decides: next offers the newer pre-release; a build defaults to its own channel", async () => {
  const next = setup({ channel: "next" });
  await next.checker.checkNow();
  expect(next.feed.calls).toEqual(["next"]);
  expect(next.checker.state).toMatchObject({
    channel: "next",
    kind: "upgrade",
    latest: { version: "0.3.1-next.2" },
  });

  const prerelease = setup({ version: "0.3.1-next.1" });
  expect(prerelease.checker.state.channel).toBe("next");
  await prerelease.checker.checkNow();
  expect(prerelease.checker.state).toMatchObject({
    kind: "upgrade",
    latest: { version: "0.3.1-next.2" },
  });
});

test("switching channel: stored, checked at once, and a downgrade is an update, too", async () => {
  const { checker, feed, store } = setup({ version: "0.3.1-next.2", channel: "next" });
  await checker.checkNow();
  expect(checker.state.status).toBe("up-to-date");

  const state = await checker.setChannel("stable");
  expect(store.get()).toBe("stable");
  expect(feed.calls).toEqual(["next", "stable"]);
  expect(state).toMatchObject({
    channel: "stable",
    status: "available",
    kind: "downgrade",
    latest: { version: "0.3.0" },
    install: { command: "npm install -g @frebreco/nod@0.3.0" },
  });

  expect((await checker.setChannel("next")).status).toBe("up-to-date");
  // Same channel again: nothing to do.
  await checker.setChannel("next");
  expect(feed.calls).toHaveLength(3);
});

test("a channel switch while a check is in flight discards the stale answer", async () => {
  const clock = new ManualClock(T0);
  const pending: Array<{ channel: Channel; resolve: (r: ReleaseInfo | null) => void }> = [];
  const feed: ReleaseFeed = {
    latest: (channel) => new Promise((resolve) => pending.push({ channel, resolve })),
  };
  const checker = new UpdateChecker({
    version: "0.2.0",
    feed,
    installer: new FakeInstaller(),
    channelStore: memoryChannelStore(),
    clock,
  });
  const first = checker.checkNow();
  await settle();
  const switching = checker.setChannel("next");
  pending[0]!.resolve(release("0.3.0"));
  await settle();
  expect(pending.map((p) => p.channel)).toEqual(["stable", "next"]);
  pending[1]!.resolve(release("0.4.0-next.1"));
  await Promise.all([first, switching]);
  expect(checker.state).toMatchObject({ channel: "next", latest: { version: "0.4.0-next.1" } });
});

test("subscribers hear every change, and a throwing one breaks nothing", async () => {
  const { checker } = setup();
  const seen: string[] = [];
  checker.subscribe(() => {
    throw new Error("listener bug");
  });
  const stop = checker.subscribe((s) => seen.push(s.status));
  await checker.checkNow();
  expect(seen).toEqual(["checking", "available"]);
  stop();
  await checker.checkNow();
  expect(seen).toHaveLength(2);
});

test("the state is plain JSON", async () => {
  const { checker } = setup();
  await checker.checkNow();
  expect(JSON.parse(JSON.stringify(checker.state))).toEqual(checker.state);
});

test("install: runs the fake for the version on offer, then reports installed and calls onInstalled", async () => {
  const clock = new ManualClock(T0);
  const installer = new FakeInstaller({ clock, delayMs: 3000 });
  const done: string[] = [];
  const checker = new UpdateChecker({
    version: "0.2.0",
    feed: new FakeReleaseFeed({ releases: [release("0.3.0")] }),
    installer,
    channelStore: memoryChannelStore(),
    clock,
    onInstalled: (v) => done.push(v),
  });
  await checker.checkNow();
  const running = checker.install();
  await settle();
  expect(checker.state.installation).toMatchObject({
    status: "installing",
    version: "0.3.0",
    startedAt: T0,
  });
  // A second click while it runs changes nothing.
  await checker.install();
  expect(installer.runs).toEqual(["0.3.0"]);
  clock.advance(3000);
  const state = await running;
  expect(state.installation).toMatchObject({
    status: "installed",
    version: "0.3.0",
    error: null,
    output: expect.stringContaining("added 1 package"),
    finishedAt: T0 + 3000,
  });
  expect(done).toEqual(["0.3.0"]);
  // The running version is still the old one until the restart.
  expect(state.current).toBe("0.2.0");
});

test("install: a failure keeps the tail of the output and does not call onInstalled", async () => {
  const installed: string[] = [];
  const { checker } = setup({
    installer: new FakeInstaller({ fail: "EACCES: permission denied" }),
    onInstalled: (v) => installed.push(v),
  });
  await checker.checkNow();
  const state = await checker.install();
  expect(state.installation).toMatchObject({
    status: "failed",
    version: "0.3.0",
    output: "EACCES: permission denied",
    error: "The install failed (exit 1).",
  });
  expect(installed).toEqual([]);
  // And it can be tried again.
  (checker as unknown as { options: { installer: FakeInstaller } }).options.installer.fail = false;
  expect((await checker.install()).installation.status).toBe("installed");
});

test("install: nothing runs without an update on offer or a known install method", async () => {
  const none = setup({ version: "0.3.0" });
  await none.checker.checkNow();
  expect((await none.checker.install()).installation).toMatchObject({
    status: "failed",
    error: "There is no update to install.",
  });
  expect(none.installer.runs).toEqual([]);

  const unknown = setup({ installer: new FakeInstaller({ method: null }) });
  await unknown.checker.checkNow();
  expect(unknown.checker.state.install).toEqual({ method: null, command: null });
  expect((await unknown.checker.install()).installation.status).toBe("failed");
  expect(unknown.installer.runs).toEqual([]);
});
