import { expect, test } from "bun:test";

import { parseArgs } from "../cli";
import { FakeServiceManager } from "./fake";
import { describeStatus, portOf, runService, type ServiceFlags } from "./cli";

const service = (...argv: string[]) => parseArgs(["service", ...argv]);
const flags = (...argv: string[]): ServiceFlags => {
  const cmd = service(...argv);
  if (cmd.kind !== "service") throw new Error(`expected service, got ${JSON.stringify(cmd)}`);
  return cmd.flags;
};

test("service install passes the serve flags on, validated by serve", () => {
  expect(flags("install")).toEqual({ command: "install", serveArgs: [] });
  expect(
    flags("install", "--port", "4600", "--poll", "30", "--allow-host", "dev.tail1234.ts.net"),
  ).toEqual({
    command: "install",
    serveArgs: ["--port", "4600", "--poll", "30", "--allow-host", "dev.tail1234.ts.net"],
  });
  expect(service("install", "--port", "x").kind).toBe("error");
  expect(service("install", "--bogus").kind).toBe("error");
  expect(service("install", "--open").kind).toBe("error");
  expect(service("install", "--help")).toEqual({ kind: "help" });
});

test("service uninstall and status take nothing", () => {
  expect(flags("uninstall")).toEqual({ command: "uninstall", serveArgs: [] });
  expect(flags("status")).toEqual({ command: "status", serveArgs: [] });
  expect(service("status", "--port", "1").kind).toBe("error");
  expect(service("status", "--help")).toEqual({ kind: "help" });
  expect(service("--help")).toEqual({ kind: "help" });
});

test("service needs a known subcommand", () => {
  expect(service().kind).toBe("error");
  expect(service("restart").kind).toBe("error");
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) },
    out,
    err,
  };
};

test("status prints the state, the unit and the command; unsupported exits 1", async () => {
  const c = capture();
  expect(
    await runService(
      { command: "status", serveArgs: [] },
      { manager: new FakeServiceManager("running"), io: c.io },
    ),
  ).toBe(0);
  expect(c.out.join("")).toBe(
    "nod service: running (pid 4242)\n  unit:    /home/mara/.config/systemd/user/nod.service\n  command: /home/mara/.bun/bin/bun /home/mara/nod/src/cli.ts serve\n",
  );
  const u = capture();
  expect(
    await runService(
      { command: "status", serveArgs: [] },
      { manager: new FakeServiceManager("unsupported"), io: u.io },
    ),
  ).toBe(1);
  expect(describeStatus({ state: "not-installed" })).toContain("nod service install");
});

test("install runs the manager with the flags; a fragile entry warns", async () => {
  const fake = new FakeServiceManager();
  const c = capture();
  const code = await runService(
    { command: "install", serveArgs: ["--port", "4600"] },
    { manager: fake, io: c.io, entry: "/tmp/bunx-1000-nod/bin/nod.js", tmpdir: "/tmp" },
  );
  expect(code).toBe(0);
  expect(fake.installedArgs).toEqual(["--port", "4600"]);
  expect(c.err.join("")).toContain("looks like a cache or temp folder");
  expect(c.out.join("")).toContain("running");
});

test("install failures print the reason and exit 1", async () => {
  const fake = new FakeServiceManager();
  fake.failNext = "systemctl --user enable nod.service failed: no bus";
  const c = capture();
  expect(
    await runService(
      { command: "install", serveArgs: [] },
      { manager: fake, io: c.io, entry: "/x/cli.ts" },
    ),
  ).toBe(1);
  expect(c.err.join("")).toBe(
    "nod service install: systemctl --user enable nod.service failed: no bus\n",
  );
});

test("uninstall says what happened", async () => {
  const c = capture();
  await runService(
    { command: "uninstall", serveArgs: [] },
    { manager: new FakeServiceManager("running"), io: c.io },
  );
  expect(c.out.join("")).toBe("nod service: stopped and removed\n");
  const d = capture();
  await runService(
    { command: "uninstall", serveArgs: [] },
    { manager: new FakeServiceManager(), io: d.io },
  );
  expect(d.out.join("")).toBe("nod service: it was not installed\n");
});

test("status names the gh the unit runs and what the running service sees of GitHub", async () => {
  const running = new FakeServiceManager({
    state: "running",
    unitPath: "/home/mara/.config/systemd/user/nod.service",
    command: ["/b/bun", "/n/cli.ts", "serve", "--port", "4600"],
    env: { PATH: "/nonexistent" },
    pid: 4242,
  });
  const asked: number[] = [];
  const c = capture();
  await runService(
    { command: "status", serveArgs: [] },
    {
      manager: running,
      io: c.io,
      health: async (port) => {
        asked.push(port);
        return {
          host: "github.com",
          state: "signed-out",
          detail: "no oauth token found for github.com",
        };
      },
    },
  );
  expect(asked).toEqual([4600]);
  expect(c.out.join("")).toContain(
    "  gh:      not found on the service's PATH (nod service install pins it)\n  GitHub:  github.com: gh is not logged in (no oauth token found for github.com)\n",
  );
  const quiet = capture();
  await runService(
    { command: "status", serveArgs: [] },
    { manager: running, io: quiet.io, health: async () => null },
  );
  expect(quiet.out.join("")).toContain("GitHub:  the service does not answer on its port yet");
});

test("install warns about what the service's nod would not see", async () => {
  const c = capture();
  const code = await runService(
    { command: "install", serveArgs: [] },
    {
      manager: new FakeServiceManager(),
      io: c.io,
      entry: "/x/cli.ts",
      preflight: () => ({
        gh: "/opt/tools/bin/gh",
        git: "/usr/bin/git",
        hosts: [{ host: "github.com", ok: false, detail: "no oauth token found for github.com" }],
        tokenVars: ["GH_TOKEN"],
        droppedProxies: [],
      }),
    },
  );
  expect(code).toBe(0);
  expect(c.err.join("")).toContain(
    "nod service: warning: `gh` is not logged in to github.com without GH_TOKEN",
  );
});

test("the port of a service's command", () => {
  expect(portOf(["bun", "cli.ts", "serve"])).toBe(4518);
  expect(portOf(["bun", "cli.ts", "serve", "--port", "4600"])).toBe(4600);
  expect(portOf(["bun", "cli.ts", "serve", "--port=4601"])).toBe(4601);
});
