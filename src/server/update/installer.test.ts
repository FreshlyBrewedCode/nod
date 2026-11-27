import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock } from "../clock";
import { defaultChannel, jsonFileChannelStore, memoryChannelStore } from "./channel-store";
import { FakeInstaller } from "./fake-installer";
import {
  createInstaller,
  detectInstallMethod,
  installArgs,
  installCommand,
  isInstallTarget,
  spawnRunner,
  type Runner,
} from "./installer";

test("detects the package manager from where the package lives", () => {
  const detect = detectInstallMethod;
  expect(detect("/home/ann/.bun/install/global/node_modules/@frebreco/nod/src/cli.ts")).toBe("bun");
  expect(detect("/usr/lib/node_modules/@frebreco/nod/src/cli.ts")).toBe("npm");
  expect(
    detect("/home/ann/.nvm/versions/node/v22.1.0/lib/node_modules/@frebreco/nod/bin/nod.js"),
  ).toBe("npm");
  expect(
    detect(
      "/home/ann/.local/share/pnpm/global/5/node_modules/.pnpm/@frebreco+nod@0.2.0/node_modules/@frebreco/nod/src/cli.ts",
    ),
  ).toBe("pnpm");
  expect(detect("/home/ann/.config/yarn/global/node_modules/@frebreco/nod/src/cli.ts")).toBe(
    "yarn",
  );
  expect(
    detect("C:\\Users\\ann\\.bun\\install\\global\\node_modules\\@frebreco\\nod\\src\\cli.ts"),
  ).toBe("bun");
});

test("a checkout, a throwaway run and anything unknown have no method", () => {
  expect(detectInstallMethod("/home/ann/code/nod/src/cli.ts")).toBeNull();
  expect(
    detectInstallMethod("/home/ann/.npm/_npx/abc123/node_modules/@frebreco/nod/src/cli.ts"),
  ).toBeNull();
  expect(
    detectInstallMethod(
      "/home/ann/.bun/install/cache/@frebreco/nod@0.2.0@@@1/node_modules/@frebreco/nod/src/cli.ts",
    ),
  ).toBeNull();
  expect(detectInstallMethod("/opt/weird/node_modules/@frebreco/nod/src/cli.ts")).toBeNull();
  expect(detectInstallMethod(null)).toBeNull();
  expect(detectInstallMethod("")).toBeNull();
});

test("commands for a version or a dist-tag, as argument arrays", () => {
  expect(installCommand("npm", "next")).toBe("npm install -g @frebreco/nod@next");
  expect(installCommand("bun", "0.2.0-next.6")).toBe("bun add -g @frebreco/nod@0.2.0-next.6");
  expect(installCommand("pnpm", "latest")).toBe("pnpm add -g @frebreco/nod@latest");
  expect(installCommand("yarn", "0.3.0")).toBe("yarn global add @frebreco/nod@0.3.0");
  expect(installArgs("npm", "next")).toEqual({
    program: "npm",
    args: ["install", "-g", "@frebreco/nod@next"],
  });
});

test("a target that could be a flag, a path or a shell is refused", () => {
  for (const bad of [
    "",
    "--prefix=/",
    "next; rm -rf ~",
    "a b",
    "../x",
    "$(id)",
    "-g",
    "x".repeat(80),
  ]) {
    expect(isInstallTarget(bad)).toBe(false);
    expect(installArgs("npm", bad)).toBeNull();
    expect(installCommand("npm", bad)).toBeNull();
  }
  expect(isInstallTarget("0.2.0-next.6")).toBe(true);
});

function recordingRunner(result: { code: number | null; output: string } | Error) {
  const calls: Array<{ program: string; args: readonly string[]; timeoutMs?: number }> = [];
  const runner: Runner = async (program, args, options) => {
    calls.push({ program, args, timeoutMs: options?.timeoutMs });
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, calls };
}

test("run() goes through the injected runner with the right arguments", async () => {
  const { runner, calls } = recordingRunner({ code: 0, output: "added 1 package" });
  const installer = createInstaller({ method: "bun", runner, platform: "linux" });
  expect(installer.method).toBe("bun");
  expect(installer.command("next")).toBe("bun add -g @frebreco/nod@next");
  expect(await installer.run("0.2.0")).toEqual({ ok: true, code: 0, output: "added 1 package" });
  expect(calls).toEqual([
    { program: "bun", args: ["add", "-g", "@frebreco/nod@0.2.0"], timeoutMs: 300_000 },
  ]);
});

test("run() reports a failure with the tail of the output, and never throws", async () => {
  const long = `${"x".repeat(10_000)}\nEACCES: permission denied`;
  const failed = await createInstaller({
    method: "npm",
    runner: recordingRunner({ code: 243, output: long }).runner,
    platform: "linux",
  }).run("next");
  expect(failed.ok).toBe(false);
  expect(failed.code).toBe(243);
  expect(failed.output.length).toBeLessThan(4100);
  expect(failed.output.endsWith("EACCES: permission denied")).toBe(true);

  const crashed = await createInstaller({
    method: "npm",
    runner: recordingRunner(new Error("spawn npm ENOENT")).runner,
    platform: "linux",
  }).run("next");
  expect(crashed).toMatchObject({ ok: false, code: null });
  expect(crashed.output).toContain("ENOENT");
});

test("an unknown method runs nothing and has no command; Windows is later", async () => {
  const { runner, calls } = recordingRunner({ code: 0, output: "" });
  const unknown = createInstaller({
    entryPath: "/home/ann/code/nod/src/cli.ts",
    runner,
    platform: "linux",
  });
  expect(unknown.method).toBeNull();
  expect(unknown.command("next")).toBeNull();
  expect((await unknown.run("next")).ok).toBe(false);
  const windows = createInstaller({ method: "npm", runner, platform: "win32" });
  expect(windows.method).toBeNull();
  const unsafe = await createInstaller({ method: "npm", runner, platform: "linux" }).run(
    "--prefix=/",
  );
  expect(unsafe.ok).toBe(false);
  expect(calls).toEqual([]);
});

test("the real runner runs a program with an argument array and no shell", async () => {
  // Not an install: the current runtime printing something, and a failing exit.
  const hello = await spawnRunner(process.execPath, ["-e", "console.log('hi; echo no')"]);
  expect(hello).toEqual({ code: 0, output: "hi; echo no\n" });
  const bad = await spawnRunner(process.execPath, ["-e", "console.error('boom'); process.exit(3)"]);
  expect(bad.code).toBe(3);
  expect(bad.output).toContain("boom");
  const missing = await spawnRunner("nod-no-such-program", []);
  expect(missing.code).toBeNull();
  const slow = await spawnRunner(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    timeoutMs: 100,
  });
  expect(slow.output).toContain("stopped after");
});

test("FakeInstaller records, takes its time from the clock, and can fail", async () => {
  const clock = new ManualClock();
  const fake = new FakeInstaller({ clock, delayMs: 3000 });
  let done = false;
  const run = fake.run("0.3.0").then((r) => {
    done = true;
    return r;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  clock.advance(3000);
  expect(await run).toMatchObject({ ok: true, code: 0 });
  expect(fake.runs).toEqual(["0.3.0"]);
  expect(fake.command("next")).toBe("npm install -g @frebreco/nod@next");

  const failing = new FakeInstaller({ fail: true });
  expect(await failing.run("0.3.0")).toMatchObject({ ok: false, code: 1 });
  expect(new FakeInstaller({ method: null }).command("next")).toBeNull();
});

test("the default channel follows the build's own", () => {
  expect(defaultChannel("0.2.0-next.6")).toBe("next");
  expect(defaultChannel("0.2.0")).toBe("stable");
  expect(defaultChannel(null)).toBe("stable");
  expect(defaultChannel("0.0.0-development")).toBe("stable");
});

test("channel stores: memory, and a JSON file that keeps the other keys", () => {
  const memory = memoryChannelStore();
  expect(memory.get()).toBeNull();
  memory.set("next");
  expect(memory.get()).toBe("next");

  const dir = mkdtempSync(join(tmpdir(), "nod-channel-"));
  const path = join(dir, "sub", "config.json");
  const store = jsonFileChannelStore(path);
  expect(store.get()).toBeNull();
  store.set("next");
  expect(jsonFileChannelStore(path).get()).toBe("next");

  const shared = join(dir, "config.json");
  writeFileSync(shared, JSON.stringify({ port: 4518, channel: "bogus" }));
  expect(jsonFileChannelStore(shared).get()).toBeNull();
  jsonFileChannelStore(shared).set("stable");
  expect(JSON.parse(readFileSync(shared, "utf8"))).toEqual({ port: 4518, channel: "stable" });

  writeFileSync(shared, "not json");
  expect(jsonFileChannelStore(shared).get()).toBeNull();
});
