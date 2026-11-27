import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeRunner, FakeServiceManager } from "./fake";
import { createServiceManager, ServiceError } from "./manager";

const nod = { runtime: "/home/mara/.bun/bin/bun", entry: "/home/mara/nod/src/cli.ts" };
const env = { PATH: "/home/mara/.bun/bin:/usr/bin", GH_TOKEN: "never-written" };

let home: string;
let runner: FakeRunner;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nod-service-"));
  runner = new FakeRunner();
});
afterEach(() => rm(home, { recursive: true, force: true }));

const manager = (platform: NodeJS.Platform) =>
  createServiceManager({
    platform,
    home,
    uid: 501,
    runner: runner.run,
    nod,
    cwd: "/home/mara/code/widgets",
    env,
    findGh: () => "/home/mara/.local/bin/gh",
  });

const systemctlShow = (active: boolean) =>
  runner.respond((c) => c.args.includes("show"), {
    stdout: active ? "ActiveState=active\nMainPID=812\n" : "ActiveState=inactive\nMainPID=0\n",
  });

test("systemd: install writes the unit under the given home and starts it", async () => {
  systemctlShow(true);
  const status = await manager("linux").install({ args: ["--port", "4600"] });
  const unitPath = join(home, ".config", "systemd", "user", "nod.service");
  const unit = await readFile(unitPath, "utf8");
  expect(unit).toContain(
    'ExecStart="/home/mara/.bun/bin/bun" "/home/mara/nod/src/cli.ts" "serve" "--port" "4600"',
  );
  expect(unit).toContain('Environment="PATH=/home/mara/.bun/bin:/usr/bin"');
  expect(unit).toContain('Environment="NOD_GH=/home/mara/.local/bin/gh"');
  expect(unit).toContain('Environment="NOD_SERVICE=1"');
  expect(unit).not.toContain("never-written");
  expect(runner.lines).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable nod.service",
    "systemctl --user restart nod.service",
    "systemctl --user show nod.service --property=ActiveState,MainPID",
  ]);
  expect(status).toEqual({
    state: "running",
    unitPath,
    command: ["/home/mara/.bun/bin/bun", "/home/mara/nod/src/cli.ts", "serve", "--port", "4600"],
    env: {
      PATH: "/home/mara/.bun/bin:/usr/bin",
      NOD_GH: "/home/mara/.local/bin/gh",
      NOD_SERVICE: "1",
    },
    pid: 812,
  });
});

test("systemd: an explicit home never reads the real $XDG_CONFIG_HOME", async () => {
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/must/not/be/used";
  try {
    const m = createServiceManager({ platform: "linux", home, runner: runner.run, nod });
    systemctlShow(false);
    await m.install({ args: [] });
    expect(existsSync(join(home, ".config", "systemd", "user", "nod.service"))).toBe(true);
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
});

test("systemd: status in its three states", async () => {
  const m = manager("linux");
  expect(await m.status()).toEqual({ state: "not-installed" });
  expect(runner.calls).toEqual([]);
  systemctlShow(false);
  await m.install({ args: [] });
  expect((await m.status()).state).toBe("installed-stopped");
  systemctlShow(true);
  expect((await m.status()).state).toBe("running");
  runner.respond((c) => c.args.includes("show"), "throw");
  expect((await m.status()).state).toBe("installed-stopped");
});

test("systemd: installing again replaces the unit", async () => {
  systemctlShow(true);
  const m = manager("linux");
  await m.install({ args: ["--port", "4600"] });
  await m.install({ args: ["--poll", "30"] });
  const status = await m.status();
  expect(status.state === "running" && status.command.slice(3)).toEqual(["--poll", "30"]);
});

test("systemd: uninstall stops, removes and reloads; again is a no-op", async () => {
  systemctlShow(true);
  const m = manager("linux");
  await m.install({ args: [] });
  runner.calls.length = 0;
  expect(await m.uninstall()).toEqual({ state: "not-installed" });
  expect(runner.lines).toEqual([
    "systemctl --user show nod.service --property=ActiveState,MainPID",
    "systemctl --user disable --now nod.service",
    "systemctl --user daemon-reload",
  ]);
  expect(existsSync(join(home, ".config", "systemd", "user", "nod.service"))).toBe(false);
  runner.calls.length = 0;
  expect(await m.uninstall()).toEqual({ state: "not-installed" });
  expect(runner.calls).toEqual([]);
});

test("systemd: uninstall removes the file even when systemctl is missing", async () => {
  systemctlShow(true);
  const m = manager("linux");
  await m.install({ args: [] });
  runner.respond((c) => c.command === "systemctl", "throw");
  expect(await m.uninstall()).toEqual({ state: "not-installed" });
  expect(existsSync(join(home, ".config", "systemd", "user", "nod.service"))).toBe(false);
});

test("systemd: a failing systemctl is a ServiceError with its message", async () => {
  runner.respond((c) => c.args.includes("enable"), {
    status: 1,
    stderr: "Failed to connect to bus\n",
  });
  const error = await manager("linux")
    .install({ args: [] })
    .catch((e) => e);
  expect(error).toBeInstanceOf(ServiceError);
  expect(error.code).toBe("failed");
  expect(error.message).toBe(
    "systemctl --user enable nod.service failed: Failed to connect to bus",
  );
  runner.respond((c) => c.command === "systemctl", "throw");
  expect(
    (
      await manager("linux")
        .install({ args: [] })
        .catch((e) => e)
    ).message,
  ).toContain("could not run systemctl");
});

test("systemd: restart", async () => {
  const m = manager("linux");
  expect((await m.restart().catch((e) => e)).code).toBe("not-installed");
  systemctlShow(true);
  await m.install({ args: [] });
  runner.calls.length = 0;
  await m.restart();
  expect(runner.lines).toContain("systemctl --user restart nod.service");
});

test("launchd: install writes the plist and loads it in gui/<uid>", async () => {
  runner.respond((c) => c.args[0] === "print", {
    stdout: "gui/501/de.frebreco.nod = {\n\tstate = running\n\tpid = 3120\n}",
  });
  const status = await manager("darwin").install({ args: ["--poll", "30"] });
  const unitPath = join(home, "Library", "LaunchAgents", "de.frebreco.nod.plist");
  const plist = await readFile(unitPath, "utf8");
  expect(plist).toContain("<string>--poll</string>");
  expect(plist).toContain(`<string>${join(home, "Library", "Logs", "nod", "nod.log")}</string>`);
  expect(existsSync(join(home, "Library", "Logs", "nod"))).toBe(true);
  expect(runner.lines).toEqual([
    "launchctl bootout gui/501/de.frebreco.nod",
    `launchctl bootstrap gui/501 ${unitPath}`,
    "launchctl kickstart -k gui/501/de.frebreco.nod",
    "launchctl print gui/501/de.frebreco.nod",
  ]);
  expect(status).toMatchObject({ state: "running", unitPath, pid: 3120 });
  expect(status.state === "running" && status.command.slice(2)).toEqual(["serve", "--poll", "30"]);
});

test("launchd: status, uninstall, restart", async () => {
  const m = manager("darwin");
  expect(await m.status()).toEqual({ state: "not-installed" });
  expect((await m.restart().catch((e) => e)).code).toBe("not-installed");
  runner.respond((c) => c.args[0] === "print", { status: 113, stderr: "Could not find service" });
  await m.install({ args: [] });
  expect((await m.status()).state).toBe("installed-stopped");
  runner.calls.length = 0;
  expect(await m.uninstall()).toEqual({ state: "not-installed" });
  expect(runner.lines).toEqual([
    "launchctl print gui/501/de.frebreco.nod",
    "launchctl bootout gui/501/de.frebreco.nod",
  ]);
  expect(existsSync(join(home, "Library", "LaunchAgents", "de.frebreco.nod.plist"))).toBe(false);
});

test("launchd: a failing bootstrap is a ServiceError", async () => {
  runner.respond((c) => c.args[0] === "bootstrap", { status: 5, stderr: "Bootstrap failed: 5\n" });
  const error = await manager("darwin")
    .install({ args: [] })
    .catch((e) => e);
  expect(error.code).toBe("failed");
  expect(error.message).toContain("Bootstrap failed: 5");
});

test("elsewhere: unsupported, and nothing is run", async () => {
  const m = manager("win32");
  expect(await m.status()).toEqual({ state: "unsupported", platform: "win32" });
  expect((await m.install({ args: [] }).catch((e) => e)).code).toBe("unsupported");
  expect((await m.uninstall().catch((e) => e)).code).toBe("unsupported");
  expect(runner.calls).toEqual([]);
});

test("a unit read from disk that was hand-edited still reports its command", async () => {
  const dir = join(home, ".config", "systemd", "user");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "nod.service"), "[Service]\nExecStart=/usr/bin/bun /x/cli.ts serve\n");
  const status = await manager("linux").status();
  expect(status).toMatchObject({
    state: "installed-stopped",
    command: ["/usr/bin/bun", "/x/cli.ts", "serve"],
  });
});

test("the fake manager walks the states", async () => {
  const fake = new FakeServiceManager();
  expect((await fake.status()).state).toBe("not-installed");
  expect((await fake.install({ args: ["--port", "4600"] })).state).toBe("running");
  expect(fake.installedArgs).toEqual(["--port", "4600"]);
  fake.failNext = "boom";
  expect((await fake.restart().catch((e) => e)).message).toBe("boom");
  await fake.restart();
  expect((await fake.uninstall()).state).toBe("not-installed");
  expect((await fake.restart().catch((e) => e)).code).toBe("not-installed");
  expect((await new FakeServiceManager("installed-stopped").status()).state).toBe(
    "installed-stopped",
  );
  expect(
    (await new FakeServiceManager("unsupported").install({ args: [] }).catch((e) => e)).code,
  ).toBe("unsupported");
});
