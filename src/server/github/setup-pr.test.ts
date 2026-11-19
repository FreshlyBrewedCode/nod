/**
 * "Open the setup PR" from nod serve: `nod init` in a temporary worktree,
 * with real git and a fake `gh` and `bun`. The user's clone keeps its
 * branch and its uncommitted work.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { processRunner, type Runner } from "../../init/runner.ts";
import { git } from "../../kit/patch-id.ts";
import { tempDir, tempRepo } from "../../kit/test-support.ts";
import { openSetupPrWithInit } from "./setup-pr";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOlUZ/AOlw2SV2ao6jmZ+Qrdv6ZSX3YU8fHHxyaar/sy";

let repo: Awaited<ReturnType<typeof tempRepo>>;
let origin: Awaited<ReturnType<typeof tempDir>>;
let calls: string[][];

const runner: Runner = {
  async run(cmd, options) {
    calls.push([...cmd]);
    if (cmd[0] === "git") return processRunner.run(cmd, options);
    if (cmd[0] === "bun") {
      await writeFile(join(options!.cwd!, "bun.lock"), '{ "lockfileVersion": 1 }\n');
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd[1] === "repo" && cmd[2] === "view")
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "acme/widgets",
          defaultBranchRef: { name: "main" },
          isPrivate: false,
        }),
        stderr: "",
      };
    if (cmd[1] === "pr" && cmd[2] === "create") {
      await readFile(cmd[cmd.indexOf("--body-file") + 1]!, "utf8");
      return { status: 0, stdout: "https://github.com/acme/widgets/pull/14\n", stderr: "" };
    }
    return { status: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
  },
};

beforeEach(async () => {
  calls = [];
  origin = await tempDir("nod-origin-");
  await git(origin.dir, ["init", "-q", "--bare", "-b", "main"]);
  repo = await tempRepo();
  await repo.write("README.md", "# widgets\n");
  await repo.commit("initial");
  await repo.git("remote", "add", "origin", origin.dir);
  await repo.git("push", "-q", "-u", "origin", "main");
});

afterEach(async () => {
  await repo.cleanup();
  await origin.cleanup();
});

test("opens the setup PR with my key as the first signer, leaving my clone as it was", async () => {
  await repo.git("switch", "-q", "-c", "my-work");
  await repo.write("README.md", "# widgets, being edited\n");
  const url = await openSetupPrWithInit({
    dir: repo.dir,
    repo: "acme/widgets",
    host: "github.com",
    login: "alice",
    publicKey: `${KEY} nod`,
    version: "0.0.0-development",
    runner,
  });
  expect(url).toBe("https://github.com/acme/widgets/pull/14");
  const signers = await git(origin.dir, ["show", "nod/setup:.nod/allowed_signers"]);
  expect(signers).toContain(`alice namespaces="nod" ${KEY}`);
  // my clone: same branch, same uncommitted edit, no worktree left behind
  expect((await repo.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("my-work");
  expect(await readFile(join(repo.dir, "README.md"), "utf8")).toBe("# widgets, being edited\n");
  expect((await repo.git("worktree", "list")).trim().split("\n")).toHaveLength(1);
  expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")).toBe(true);
});

test("a failing nod init still removes the worktree", async () => {
  const failing: Runner = {
    run: async (cmd, options) =>
      cmd[0] === "gh" && cmd[1] === "pr"
        ? { status: 1, stdout: "", stderr: "GraphQL: not allowed" }
        : runner.run(cmd, options),
  };
  await expect(
    openSetupPrWithInit({
      dir: repo.dir,
      repo: "acme/widgets",
      host: "github.com",
      login: "alice",
      publicKey: KEY,
      version: "0.0.0-development",
      runner: failing,
    }),
  ).rejects.toThrow(/not allowed/);
  expect((await repo.git("worktree", "list")).trim().split("\n")).toHaveLength(1);
});

test("on GHE.com every gh call names the host", async () => {
  const seen: Array<{ cmd: string[]; host: string | undefined }> = [];
  const recording: Runner = {
    run: (cmd, options) => {
      seen.push({ cmd: [...cmd], host: options?.env?.GH_HOST });
      return runner.run(cmd, options);
    },
  };
  await openSetupPrWithInit({
    dir: repo.dir,
    repo: "acme/widgets",
    host: "acme.ghe.com",
    login: "mona_acme",
    publicKey: KEY,
    version: "0.0.0-development",
    runner: recording,
  });
  const gh = seen.filter((s) => s.cmd[0] === "gh");
  expect(gh.length).toBeGreaterThan(0);
  expect(gh.every((s) => s.host === "acme.ghe.com")).toBe(true);
  expect(gh.find((s) => s.cmd[1] === "pr")!.cmd).toEqual(
    expect.arrayContaining(["--repo", "acme.ghe.com/acme/widgets"]),
  );
  expect(seen.filter((s) => s.cmd[0] !== "gh").every((s) => s.host === undefined)).toBe(true);
  expect(await git(origin.dir, ["show", "nod/setup:.nod/allowed_signers"])).toContain(
    `mona_acme namespaces="nod" ${KEY}`,
  );
});
