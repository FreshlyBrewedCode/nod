/**
 * The check at install: what the service's nod will see of `gh`, with a
 * stand-in `gh` in a temp folder (never the real one, never a real login).
 */

import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { makeFakeGh } from "../server/github/fake-gh";
import { blocksSignIn, hostsToCheck, preflightProblems, servicePreflight } from "./preflight";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const fakeGh = async (hosts: ReadonlyArray<string> = []) => {
  const f = await makeFakeGh(hosts);
  cleanups.push(f.cleanup);
  return f;
};

test("gh logged in through its own config: nothing to say; gh is pinned", async () => {
  const f = await fakeGh(["github.com"]);
  const p = servicePreflight({
    env: { PATH: `${f.bin}:/bin`, HOME: f.dir, GH_CONFIG_DIR: f.config },
    hosts: ["github.com"],
  });
  expect(p).toMatchObject({ gh: f.gh, hosts: [{ host: "github.com", ok: true }], tokenVars: [] });
  expect(blocksSignIn(p)).toBe(false);
  expect(preflightProblems(p).filter((l) => !l.includes("`git`"))).toEqual([]);
});

test("gh logged in only through GH_TOKEN: the service would not be; said before it starts", async () => {
  const f = await fakeGh();
  const p = servicePreflight({
    env: { PATH: `${f.bin}:/bin`, GH_CONFIG_DIR: f.config, GH_TOKEN: "from-the-shell" },
    hosts: ["github.com"],
  });
  expect(p.hosts).toEqual([
    { host: "github.com", ok: false, detail: "no oauth token found for github.com" },
  ]);
  expect(p.tokenVars).toEqual(["GH_TOKEN"]);
  expect(blocksSignIn(p)).toBe(true);
  expect(preflightProblems(p)[0]).toBe(
    "`gh` is not logged in to github.com without GH_TOKEN, which your shell sets and a service does not get (nod writes no token into a file). Run `gh auth login` so gh keeps its own login, then `nod service install` again.",
  );
  expect(JSON.stringify(p)).not.toContain("from-the-shell");
});

test("not logged in to a host of the list: gh's words, the host's login command", async () => {
  const f = await fakeGh(["github.com"]);
  const p = servicePreflight({
    env: { PATH: `${f.bin}:/bin`, GH_CONFIG_DIR: f.config },
    hosts: ["github.com", "acme.ghe.com", "github.com"],
  });
  expect(p.hosts.map((h) => [h.host, h.ok])).toEqual([
    ["github.com", true],
    ["acme.ghe.com", false],
  ]);
  expect(preflightProblems(p)[0]).toBe(
    `\`gh\` (${f.gh}) is not logged in to acme.ghe.com in the service's environment (gh: no oauth token found for acme.ghe.com). Run \`gh auth login --hostname acme.ghe.com\`, then \`nod service install\` again.`,
  );
});

test("no gh on the PATH: said, and nothing is asked", () => {
  let asked = 0;
  const p = servicePreflight({
    env: {
      PATH: join("/nonexistent", "bin"),
      HTTPS_PROXY: "http://mara:pw@proxy.example.test:3128",
    },
    hosts: ["github.com"],
    token: () => {
      asked++;
      return { token: "x", path: "/x" };
    },
  });
  expect(asked).toBe(0);
  expect(p).toMatchObject({ gh: null, git: null, hosts: [], droppedProxies: ["HTTPS_PROXY"] });
  expect(blocksSignIn(p)).toBe(true);
  const problems = preflightProblems(p);
  expect(problems[0]).toContain("no `gh` on its PATH");
  expect(problems.join(" ")).toContain("no `git` on its PATH");
  expect(problems.join(" ")).toContain("HTTPS_PROXY has a password in it");
  expect(problems.join(" ")).not.toContain("pw@");
});

test("the hosts to check: --host, else the list's, else github.com", () => {
  expect(hostsToCheck(["--host", "Acme.GHE.com"], ["github.com"])).toEqual(["acme.ghe.com"]);
  expect(hostsToCheck(["--host=git.example.test"], [])).toEqual(["git.example.test"]);
  expect(hostsToCheck([], ["github.com", "acme.ghe.com", "github.com"])).toEqual([
    "github.com",
    "acme.ghe.com",
  ]);
  expect(hostsToCheck(["--port", "4600"], [])).toEqual(["github.com"]);
});
