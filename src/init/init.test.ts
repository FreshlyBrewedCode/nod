/**
 * `nod init` with real git and a fake `gh` and `bun`: the files land on
 * `nod/setup`, get committed and pushed, and the setup PR is opened.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { git } from "../kit/patch-id.ts";
import { tempDir, tempRepo } from "../kit/test-support.ts";
import type { InitFlags } from "./args.ts";
import { runInit } from "./init.ts";
import { processRunner, type Runner } from "./runner.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOlUZ/AOlw2SV2ao6jmZ+Qrdv6ZSX3YU8fHHxyaar/sy";
const SHA = "5a6fb495d7936dbe15069979607003fab4dc71e5";

const flags = (over: Partial<InitFlags> = {}): InitFlags => ({
  repo: null,
  dir: null,
  signers: [`alice ${KEY}`],
  signerKeys: [],
  kit: `github:FreshlyBrewedCode/nod#${SHA}`,
  dryRun: false,
  pr: true,
  force: false,
  ruleset: false,
  ...over,
});

let repo: Awaited<ReturnType<typeof tempRepo>>;
let origin: Awaited<ReturnType<typeof tempDir>>;
let calls: string[][];
let prBody: string;
let lines: string[];
/** Answers for `gh api …` calls, by the endpoint argument. */
let api: Record<string, { status: number; stdout: string; stderr?: string }>;

/** Real git; `gh` and `bun` faked. */
const runner: Runner = {
  async run(cmd, options) {
    calls.push([...cmd]);
    if (cmd[0] === "git") return processRunner.run(cmd, options);
    if (cmd[0] === "bun") {
      await writeFile(join(options!.cwd!, "bun.lock"), '{ "lockfileVersion": 1 }\n');
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd[1] === "repo" && cmd[2] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "acme/widgets",
          defaultBranchRef: { name: "main" },
          isPrivate: false,
        }),
        stderr: "",
      };
    }
    if (cmd[1] === "pr" && cmd[2] === "create") {
      prBody = await readFile(cmd[cmd.indexOf("--body-file") + 1]!, "utf8");
      return { status: 0, stdout: "https://github.com/acme/widgets/pull/1\n", stderr: "" };
    }
    if (cmd[1] === "api") {
      const endpoint = cmd
        .slice(2)
        .find((a) => !a.startsWith("-") && a !== "PUT" && a !== "POST" && a !== "PATCH")!;
      if (endpoint === "user") return { status: 0, stdout: "alice\n", stderr: "" };
      const answer = api[endpoint];
      if (answer) return { stderr: "", ...answer };
      return { status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) ${endpoint}` };
    }
    return { status: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
  },
};

const deps = () => ({
  runner,
  version: "0.0.0-development",
  cwd: repo.dir,
  log: (l: string) => lines.push(l),
});

beforeEach(async () => {
  calls = [];
  lines = [];
  prBody = "";
  api = {};
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

test("commits the setup on nod/setup, pushes it and opens the setup PR", async () => {
  expect(await runInit(flags(), deps())).toBe(0);
  const files = (await git(origin.dir, ["ls-tree", "-r", "--name-only", "nod/setup"])).split("\n");
  expect(files).toEqual(
    expect.arrayContaining([
      ".github/workflows/nod.yml",
      ".nod/.gitignore",
      ".nod/allowed_signers",
      ".nod/bun.lock",
      ".nod/classifiers/module-tier.ts",
      ".nod/package.json",
      ".nod/policy.ts",
      ".nod/verify.ts",
      "README.md",
    ]),
  );
  expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  const signers = await git(origin.dir, ["show", "nod/setup:.nod/allowed_signers"]);
  expect(signers).toContain(`alice namespaces="nod" ${KEY}`);
  expect(await git(origin.dir, ["show", "nod/setup:.nod/package.json"])).toContain(SHA);
  // the PR, through gh, with the body from setupPrBody
  const create = calls.find((c) => c[0] === "gh" && c[1] === "pr")!;
  expect(create).toEqual(expect.arrayContaining(["--base", "main", "--head", "nod/setup"]));
  expect(prBody).toContain("nod init --ruleset --repo acme/widgets");
  expect(lines.join("\n")).toContain("https://github.com/acme/widgets/pull/1");
  // back on the branch the user was on, with a clean tree
  expect((await repo.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
  expect((await repo.git("status", "--porcelain")).trim()).toBe("");
});

test("--signer-key takes the login from gh", async () => {
  const key = join(repo.dir, "..", `${repo.dir.split("/").pop()}-key.pub`);
  await writeFile(key, `${KEY} alice@laptop\n`);
  expect(await runInit(flags({ signers: [], signerKeys: [key], pr: false }), deps())).toBe(0);
  expect(await repo.git("show", "nod/setup:.nod/allowed_signers")).toContain(
    `alice namespaces="nod" ${KEY}`,
  );
});

test("--no-pr commits but neither pushes nor opens a PR", async () => {
  expect(await runInit(flags({ pr: false }), deps())).toBe(0);
  expect(calls.some((c) => c[0] === "git" && c.includes("push"))).toBe(false);
  expect(calls.some((c) => c[0] === "gh" && c[1] === "pr")).toBe(false);
  expect(await repo.git("log", "--format=%s", "-1", "nod/setup")).toContain("set up nod");
});

test("--dry-run writes the files and nothing else", async () => {
  expect(await runInit(flags({ dryRun: true }), deps())).toBe(0);
  expect(existsSync(join(repo.dir, ".nod", "verify.ts"))).toBe(true);
  expect(calls.some((c) => ["push", "commit", "switch"].some((x) => c.includes(x)))).toBe(false);
  expect(calls.some((c) => c[0] === "bun" || c[1] === "pr")).toBe(false);
  expect(lines.join("\n")).toContain("would also");
});

test("refuses an existing .nod/ without --force, and a run without a signer", async () => {
  await repo.write(".nod/policy.ts", "export default {};\n");
  await repo.commit("someone set up nod already");
  await repo.git("push", "-q", "origin", "main");
  expect(await runInit(flags(), deps())).toBe(1);
  expect(lines.join("\n")).toContain(".nod/ exists already");

  lines = [];
  expect(await runInit(flags({ signers: [] }), deps())).toBe(1);
  expect(lines.join("\n")).toContain("at least one signer");
});

test("refuses a dirty working tree", async () => {
  await repo.write("README.md", "# changed\n");
  expect(await runInit(flags(), deps())).toBe(1);
  expect(lines.join("\n")).toContain("uncommitted changes");
});

test("--ruleset refuses before the verifier is on the default branch", async () => {
  expect(await runInit(flags({ ruleset: true }), deps())).toBe(1);
  expect(lines.join("\n")).toContain("Merge the setup PR first");
  expect(calls.some((c) => c.includes("POST"))).toBe(false);
});

test("--ruleset creates the ruleset and enables auto-merge", async () => {
  api = {
    "repos/acme/widgets/contents/.nod/verify.ts?ref=main": { status: 0, stdout: "" },
    "apps/github-actions": { status: 0, stdout: "15368\n" },
    "repos/acme/widgets/rulesets": { status: 0, stdout: "\n" },
    "repos/acme/widgets": { status: 0, stdout: "true\n" },
  };
  expect(await runInit(flags({ ruleset: true }), deps())).toBe(0);
  const post = calls.find((c) => c.includes("POST"))!;
  expect(post).toContain("repos/acme/widgets/rulesets");
  expect(lines.join("\n")).toContain('created the ruleset "nod"');
  expect(lines.join("\n")).toContain("auto-merge is enabled");
});

test("--ruleset says plainly when the plan refuses", async () => {
  const refusal = {
    status: 1,
    stdout:
      '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}',
    stderr:
      "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
  };
  api = {
    "repos/acme/widgets/contents/.nod/verify.ts?ref=main": { status: 0, stdout: "" },
    "repos/acme/widgets/rulesets": refusal,
  };
  expect(await runInit(flags({ ruleset: true }), deps())).toBe(1);
  expect(lines.join("\n")).toContain("Private repositories need GitHub Pro, Team or Enterprise");
});
