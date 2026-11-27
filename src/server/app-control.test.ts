import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppState, Reply, ServerToClient } from "../shared/protocol";
import { FakeServiceManager, type FakeServiceState } from "../service/fake";
import {
  AppControl,
  serveCommand,
  shellQuote,
  toAppState,
  type AppControlOptions,
} from "./app-control";
import { ManualClock } from "./clock";
import { fakeApp } from "./fake-app";
import { FakeSource } from "./fake-source";
import { Session } from "./session";
import { FakeSigner, type Side } from "./signer";
import { inertAppSeams, start } from "./start";
import { FakeInstaller, FakeReleaseFeed, UpdateChecker, memoryChannelStore } from "./update";
import { NEXT_WEB_URL } from "./web-url";

const NOW = Date.UTC(2026, 10, 27, 9, 0);
const GRACE = 800;

/** Lets pending promises (the fakes answer at once) run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function control(overrides: Partial<AppControlOptions> = {}) {
  const clock = new ManualClock(NOW);
  const feed = (overrides.feed as FakeReleaseFeed | undefined) ?? new FakeReleaseFeed();
  const installer =
    (overrides.installer as FakeInstaller | undefined) ?? new FakeInstaller({ method: "npm" });
  const service =
    (overrides.service as FakeServiceManager | undefined) ??
    new FakeServiceManager("not-installed");
  const handOvers: number[] = [];
  const app = new AppControl({
    feed,
    installer,
    channelStore: memoryChannelStore(),
    service,
    clock,
    version: "0.2.0",
    serveArgs: ["--port", "4520"],
    isThisNod: (status) => status.state === "running",
    onHandOver: () => handOvers.push(clock.now()),
    ...overrides,
  });
  const states: AppState[] = [];
  app.subscribe(() => states.push(app.state("loopback")));
  return { clock, feed, installer, service, app, states, handOvers };
}

describe("the wire", () => {
  test("an update on offer: the release, the method and its command, the service", async () => {
    const { app } = control();
    app.start();
    await flush();
    const state = app.state("loopback");
    expect(state).toEqual({
      version: "0.2.0",
      development: false,
      channel: "stable",
      update: {
        status: "available",
        latest: {
          version: "0.3.0",
          publishedAt: Date.parse("2026-11-25T08:00:19Z"),
          notes: expect.stringContaining("### Features") as unknown as string,
          url: "https://github.com/FreshlyBrewedCode/nod/releases/tag/v0.3.0",
          prerelease: false,
        },
        kind: "upgrade",
        checkedAt: NOW,
        nextCheckAt: NOW + 10 * 60_000,
        error: null,
        installation: {
          status: "idle",
          version: null,
          output: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        },
        after: null,
      },
      install: { method: "npm", command: "npm install -g @frebreco/nod@0.3.0", commands: [] },
      service: {
        state: "not-installed",
        manager: "fake",
        unitPath: null,
        command: null,
        thisNod: false,
        args: ["--port", "4520"],
        logs: "journalctl --user -u nod.service -f",
        busy: null,
        error: null,
        handOver: false,
      },
      mayChange: true,
      otherDevice: null,
    });
    // Only plain JSON: what the socket sends is what the page gets.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test("the other device's side reads the same state and may change nothing", async () => {
    const { app } = control({ namedOrigin: "https://laptop.example-tailnet.ts.net:8445" });
    app.start();
    await flush();
    const here = app.state("loopback");
    const there = app.state("named-host");
    expect(there.mayChange).toBe(false);
    expect({ ...there, mayChange: true }).toEqual(here);
    expect(there.otherDevice).toEqual({ origin: "https://laptop.example-tailnet.ts.net:8445" });
  });

  test("an unknown install method: no command of its own, the usual ones to run by hand", async () => {
    const { app } = control({ installer: new FakeInstaller({ method: null }) });
    app.start();
    await flush();
    expect(app.state("loopback").install).toEqual({
      method: null,
      command: null,
      commands: ["npm install -g @frebreco/nod@0.3.0", "bun add -g @frebreco/nod@0.3.0"],
    });
  });

  test("up to date, the command names the channel's dist-tag", async () => {
    const { app } = control({ version: "0.3.0" });
    app.start();
    await flush();
    const state = app.state("loopback");
    expect(state.update).toMatchObject({ status: "up-to-date", kind: null });
    expect(state.install.command).toBe("npm install -g @frebreco/nod@latest");
  });

  test("the service's states, as the wire names them", async () => {
    const update = new UpdateChecker({
      version: "0.2.0",
      feed: new FakeReleaseFeed(),
      installer: new FakeInstaller(),
      channelStore: memoryChannelStore(),
      clock: new ManualClock(NOW),
    }).state;
    const of = async (state: FakeServiceState) =>
      toAppState(
        {
          update,
          installer: new FakeInstaller(),
          serviceKind: "systemd",
          service: {
            status: await new FakeServiceManager(state).status(),
            busy: null,
            error: null,
            handOver: false,
          },
          thisNod: false,
          serveArgs: [],
          after: null,
          namedOrigin: null,
        },
        "loopback",
      ).service;
    expect(await of("installed-stopped")).toMatchObject({
      state: "stopped",
      unitPath: "/home/mara/.config/systemd/user/nod.service",
      command: "/home/mara/.bun/bin/bun /home/mara/nod/src/cli.ts serve",
    });
    expect(await of("running")).toMatchObject({ state: "running" });
    expect(await of("unsupported")).toMatchObject({ state: "unsupported", unitPath: null });
    expect(await of("not-installed")).toMatchObject({ state: "not-installed", command: null });
  });

  test("commands are quoted for a shell", () => {
    expect(shellQuote("--port")).toBe("--port");
    expect(shellQuote("/tmp/my dir")).toBe("'/tmp/my dir'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(serveCommand(["--token-file", "/tmp/a b"])).toBe("nod serve --token-file '/tmp/a b'");
  });
});

describe("installing takes a click, and what follows", () => {
  test("nothing installs on its own: checks only, the installer never runs", async () => {
    const { app, clock, installer } = control();
    app.start();
    await flush();
    clock.advance(60 * 60_000);
    await flush();
    expect(app.state("loopback").update.status).toBe("available");
    expect(installer.runs).toEqual([]);
  });

  test("the version clicked must be the one on offer", async () => {
    const { app } = control();
    app.start();
    await flush();
    expect(() => app.installUpdate("0.4.0-next.2")).toThrow(/on offer is 0.3.0/);
    const none = control({ version: "0.3.0" });
    none.app.start();
    await flush();
    expect(() => none.app.installUpdate("0.3.0")).toThrow(/no update to install/);
    const unknown = control({ installer: new FakeInstaller({ method: null }) });
    unknown.app.start();
    await flush();
    expect(() => unknown.app.installUpdate("0.3.0")).toThrow(/does not know how it was installed/);
    expect(unknown.installer.runs).toEqual([]);
  });

  test("as the service: installing, restarting, and the service restarts nod", async () => {
    const { app, installer, service, clock, states } = control({
      service: new FakeServiceManager("running"),
    });
    app.start();
    await flush();
    app.installUpdate("0.3.0");
    expect(app.state("loopback").update.installation).toMatchObject({
      status: "installing",
      version: "0.3.0",
    });
    await flush();
    expect(installer.runs).toEqual(["0.3.0"]);
    expect(app.state("loopback").update).toMatchObject({
      installation: { status: "installed", version: "0.3.0" },
      after: { state: "restarting" },
    });
    expect(service.calls).toEqual([]);
    // The push reaches the tabs before the restart.
    clock.advance(GRACE);
    await flush();
    expect(service.calls).toEqual(["restart"]);
    expect(states.some((s) => s.update.after?.state === "restarting")).toBe(true);
  });

  test("a plain nod serve: installed, restart it by hand with this command", async () => {
    const { app, service, clock } = control({ serveArgs: ["--port", "4520", "--dir", "/tmp/a b"] });
    app.start();
    await flush();
    app.installUpdate("0.3.0");
    await flush();
    clock.advance(GRACE);
    await flush();
    expect(app.state("loopback").update.after).toEqual({
      state: "restart-by-hand",
      command: "nod serve --port 4520 --dir '/tmp/a b'",
    });
    expect(service.calls).toEqual([]);
  });

  test("the service does not restart: said so", async () => {
    const service = new FakeServiceManager("running");
    const { app, clock } = control({ service });
    app.start();
    await flush();
    service.failNext = "Job for nod.service failed.";
    app.installUpdate("0.3.0");
    await flush();
    clock.advance(GRACE);
    await flush();
    expect(app.state("loopback").update.after).toEqual({
      state: "restart-failed",
      error: "Job for nod.service failed.",
    });
  });

  test("a failed install: the output, no restart", async () => {
    const { app, service, clock } = control({
      installer: new FakeInstaller({ fail: true }),
      service: new FakeServiceManager("running"),
    });
    app.start();
    await flush();
    app.installUpdate("0.3.0");
    await flush();
    clock.advance(GRACE);
    await flush();
    expect(app.state("loopback").update).toMatchObject({
      installation: { status: "failed", error: "The install failed (exit 1)." },
      after: null,
    });
    expect(app.state("loopback").update.installation.output).toContain("EACCES");
    expect(service.calls).toEqual([]);
  });

  test("--fake plays the restart: the new version, nothing installing, every tab reconnects", async () => {
    const reconnects: number[] = [];
    const { app, clock } = control({
      service: new FakeServiceManager("running"),
      simulate: { onRestarted: () => reconnects.push(1) },
    });
    app.start();
    await flush();
    app.installUpdate("0.3.0");
    await flush();
    clock.advance(GRACE);
    await flush();
    expect(reconnects).toEqual([1]);
    expect(app.state("loopback")).toMatchObject({
      version: "0.3.0",
      update: { status: "up-to-date", kind: null, installation: { status: "idle" }, after: null },
    });
  });

  test("the channel: next offers its newest, stable then a downgrade; nothing installs", async () => {
    const { app, installer } = control({ version: "0.4.0-next.1" });
    app.start();
    await flush();
    expect(app.state("loopback")).toMatchObject({
      channel: "next",
      update: { kind: "upgrade", latest: { version: "0.4.0-next.2" } },
    });
    await app.setChannel("stable");
    expect(app.state("loopback")).toMatchObject({
      channel: "stable",
      update: { kind: "downgrade", latest: { version: "0.3.0" } },
      install: { command: "npm install -g @frebreco/nod@0.3.0" },
    });
    expect(installer.runs).toEqual([]);
  });
});

describe("the background service from the page", () => {
  test("a plain nod serve sets it up with its own flags, then hands over", async () => {
    const { app, service, clock, handOvers } = control();
    app.start();
    await flush();
    await app.installService();
    expect(service.installedArgs).toEqual(["--port", "4520"]);
    // The fake counts a running service as this process; a real one is another pid.
    const real = control({ isThisNod: () => false });
    real.app.start();
    await flush();
    await real.app.installService();
    expect(real.app.state("loopback").service).toMatchObject({
      state: "running",
      handOver: true,
      busy: null,
    });
    expect(real.handOvers).toEqual([]);
    real.clock.advance(GRACE);
    expect(real.handOvers).toEqual([NOW + GRACE]);
    // The one that is the service after the install does not hand over.
    clock.advance(GRACE);
    expect(handOvers).toEqual([]);
  });

  test("--fake plays the hand-over: the tabs reconnect to the 'service'", async () => {
    const reconnects: number[] = [];
    const { app, clock } = control({ simulate: { onRestarted: () => reconnects.push(1) } });
    app.start();
    await flush();
    await app.installService();
    expect(app.state("loopback").service).toMatchObject({ handOver: true, thisNod: true });
    clock.advance(GRACE);
    expect(reconnects).toEqual([1]);
    expect(app.state("loopback").service.handOver).toBe(false);
  });

  test("a failure is shown and answered", async () => {
    const service = new FakeServiceManager("not-installed");
    service.failNext = "systemctl --user enable nod.service: Failed to connect to bus";
    const { app } = control({ service });
    app.start();
    await flush();
    await expect(app.installService()).rejects.toMatchObject({ code: "service" });
    expect(app.state("loopback").service).toMatchObject({
      busy: null,
      error: "systemctl --user enable nod.service: Failed to connect to bus",
    });
  });

  test("unsupported: not-implemented, nothing written", async () => {
    const service = new FakeServiceManager("unsupported");
    const { app } = control({ service });
    app.start();
    await flush();
    await expect(app.installService()).rejects.toMatchObject({ code: "not-implemented" });
    expect(app.state("loopback").service.state).toBe("unsupported");
  });

  test("removing it", async () => {
    const { app, service } = control({ service: new FakeServiceManager("running") });
    app.start();
    await flush();
    await app.uninstallService();
    expect(service.calls).toEqual(["uninstall"]);
    expect(app.state("loopback").service).toMatchObject({ state: "not-installed", thisNod: false });
  });
});

// ---------------------------------------------------------------------------
// the session: requests, and the other device's side

function sessionWithApp() {
  const clock = new ManualClock(NOW);
  const source = new FakeSource({ clock, scenario: "team" });
  const signer = new FakeSigner(clock, { hasKey: true });
  const fake = fakeApp({ clock, service: "running", installMs: 1000 });
  const reconnects: number[] = [];
  const app = new AppControl({
    ...fake.seams,
    version: fake.version,
    clock,
    serveArgs: ["--fake"],
    isThisNod: fake.isThisNod,
    namedOrigin: "https://laptop.example-tailnet.ts.net:8445",
    deviceLink: async () => ({ origin: "https://laptop.example-tailnet.ts.net:8445", qr: ["10"] }),
    simulate: { onRestarted: () => reconnects.push(1) },
  });
  app.start();
  const session = new Session({ source, signer, clock, version: null, fake: true, app });
  const tab = (side: Side) => {
    const messages: ServerToClient[] = [];
    const client = { side, send: (d: string) => void messages.push(JSON.parse(d)) };
    let id = 0;
    const ask = async (t: string, body: Record<string, unknown> = {}): Promise<Reply> => {
      const rid = `q${++id}`;
      await session.handle(client, JSON.stringify({ ...body, t, id: rid }));
      return messages.find((m) => m.t === "reply" && m.id === rid) as Reply;
    };
    const app = () =>
      messages.filter((m): m is Extract<ServerToClient, { t: "app" }> => m.t === "app").at(-1)?.app;
    return { client, messages, ask, app };
  };
  return { clock, session, tab, fake, reconnects };
}

const code = (reply: Reply) => (reply.ok ? "ok" : reply.error.code);

describe("the session", () => {
  test("the welcome carries the app as each side sees it, and every change is pushed", async () => {
    const { session, tab, clock } = sessionWithApp();
    const here = tab("loopback");
    const there = tab("named-host");
    await flush();
    await session.attach(here.client);
    await session.attach(there.client);
    const welcome = (t: ReturnType<typeof tab>) =>
      t.messages.find((m): m is Extract<ServerToClient, { t: "welcome" }> => m.t === "welcome")!;
    expect(welcome(here).app).toMatchObject({
      version: "0.2.0",
      mayChange: true,
      update: { kind: "upgrade" },
    });
    expect(welcome(there).app).toMatchObject({ version: "0.2.0", mayChange: false });
    expect(code(await here.ask("install-update", { version: "0.3.0" }))).toBe("ok");
    expect(here.app()?.update.installation.status).toBe("installing");
    expect(there.app()?.update.installation.status).toBe("installing");
    expect(there.app()?.mayChange).toBe(false);
    clock.advance(1000);
    await flush();
    expect(here.app()?.update.after).toEqual({ state: "restarting" });
  });

  test("machine-changing requests are refused from the other device's side", async () => {
    const { session, tab, fake } = sessionWithApp();
    await flush();
    const there = tab("named-host");
    await session.attach(there.client);
    for (const [t, body] of [
      ["set-channel", { channel: "next" }],
      ["install-update", { version: "0.3.0" }],
      ["service-install", {}],
      ["service-uninstall", {}],
      ["device-link", {}],
    ] as const) {
      const reply = await there.ask(t, body);
      expect(code(reply)).toBe("forbidden");
      if (!reply.ok) expect(reply.error.message).toMatch(/on the machine nod runs on/);
    }
    expect(fake.seams.installer.runs).toEqual([]);
    expect(fake.seams.service.calls).toEqual([]);
    expect(there.app()?.channel ?? "stable").toBe("stable");
    // Checking is reading: either side.
    expect(code(await there.ask("check-update"))).toBe("ok");
  });

  test("this machine's side: the channel, the device link, and bad requests", async () => {
    const { session, tab } = sessionWithApp();
    await flush();
    const here = tab("loopback");
    await session.attach(here.client);
    expect(code(await here.ask("set-channel", { channel: "next" }))).toBe("ok");
    expect(here.app()).toMatchObject({
      channel: "next",
      update: { latest: { version: "0.4.0-next.2" } },
    });
    const link = await here.ask("device-link");
    expect(link.ok && link.result).toEqual({
      origin: "https://laptop.example-tailnet.ts.net:8445",
      qr: ["10"],
    });
    expect(code(await here.ask("set-channel", { channel: "beta" }))).toBe("bad-request");
    expect(code(await here.ask("install-update", { version: "--global" }))).toBe("bad-request");
    expect(code(await here.ask("install-update", { version: "0.3.0" }))).toBe("stale");
  });

  test("without an app: not-implemented, and no app in the welcome", async () => {
    const clock = new ManualClock(NOW);
    const session = new Session({
      source: new FakeSource({ clock, scenario: "team" }),
      signer: new FakeSigner(clock),
      clock,
      version: null,
      fake: true,
    });
    const messages: ServerToClient[] = [];
    const client = {
      side: "loopback" as const,
      send: (d: string) => void messages.push(JSON.parse(d)),
    };
    await session.attach(client);
    expect(messages[0]).not.toHaveProperty("app");
    await session.handle(client, JSON.stringify({ t: "check-update", id: "a" }));
    expect(messages.at(-1)).toMatchObject({ ok: false, error: { code: "not-implemented" } });
  });
});

// ---------------------------------------------------------------------------
// `nod serve --fake` reaches no real seam

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("start()", () => {
  test("--fake gets fakes and never calls the real seams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nod-app-"));
    dirs.push(dir);
    const started = start({
      port: 0,
      webUrl: NEXT_WEB_URL,
      tokenFile: join(dir, "serve-token"),
      version: null,
      fake: { scenario: "team", live: false },
      clock: new ManualClock(NOW),
      app: {
        seams: () => {
          throw new Error("a fake run built the real seams");
        },
        fake: { update: "downgrade", service: "stopped", install: "unknown" },
      },
    });
    try {
      expect(started.appSeams.feed).toBeInstanceOf(FakeReleaseFeed);
      expect(started.appSeams.installer).toBeInstanceOf(FakeInstaller);
      expect(started.appSeams.service).toBeInstanceOf(FakeServiceManager);
      // Not the config file: the fake's channel lives in memory.
      expect(started.appSeams.channelStore.get()).toBe("stable");
      await flush();
      expect(started.app.state("loopback")).toMatchObject({
        version: "0.4.0-next.2",
        channel: "stable",
        update: { kind: "downgrade", latest: { version: "0.3.0" } },
        install: { method: null },
        service: { state: "stopped" },
      });
    } finally {
      await started.stop();
    }
  });

  test("without seams: no releases, no install method, no service", async () => {
    const seams = inertAppSeams();
    expect(await seams.feed.latest("stable")).toBeNull();
    expect(seams.installer.method).toBeNull();
    expect(seams.service.kind).toBe("unsupported");
    expect(seams.channelStore.get()).toBeNull();
  });
});
