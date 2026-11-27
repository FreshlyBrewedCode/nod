import { expect, test } from "bun:test";

import { parseArgs, type ServeFlags } from "./cli";

const serveFlags = (argv: string[]): ServeFlags => {
  const cmd = parseArgs(["serve", ...argv]);
  if (cmd.kind !== "serve") throw new Error(`expected serve, got ${JSON.stringify(cmd)}`);
  return cmd.flags;
};

test("no arguments and --help show help", () => {
  expect(parseArgs([])).toEqual({ kind: "help" });
  expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  expect(parseArgs(["serve", "--help"])).toEqual({ kind: "help" });
});

test("--version", () => {
  expect(parseArgs(["--version"])).toEqual({ kind: "version" });
});

test("key: the subcommands go to nod key", () => {
  expect(parseArgs(["key", "show", "--login", "mara-l"])).toEqual({
    kind: "key",
    flags: { command: "show", keyFile: null, login: "mara-l", replace: false },
  });
  expect(parseArgs(["key"]).kind).toBe("error");
});

test("repo: add, remove, list go to nod repo", () => {
  expect(parseArgs(["repo", "add", "acme.ghe.com/finance/ledger"])).toEqual({
    kind: "repo",
    flags: { command: "add", repo: "acme.ghe.com/finance/ledger", noClone: false },
  });
  expect(parseArgs(["repo", "add", "--no-clone", "tallyho/fieldbook"])).toMatchObject({
    flags: { noClone: true },
  });
  expect(parseArgs(["repo", "remove", "tallyho/fieldbook"])).toMatchObject({
    flags: { command: "remove", repo: "tallyho/fieldbook" },
  });
  expect(parseArgs(["repo", "list"])).toMatchObject({ flags: { command: "list", repo: null } });
  for (const bad of [
    ["repo"],
    ["repo", "add"],
    ["repo", "list", "x/y"],
    ["repo", "remove", "--no-clone", "x/y"],
    ["repo", "add", "a/b", "c/d"],
  ])
    expect(parseArgs(bad).kind).toBe("error");
});

test("serve defaults: GitHub, port 4518, no browser", () => {
  expect(serveFlags([])).toEqual({
    fake: false,
    scenario: "team",
    frozen: false,
    port: 4518,
    repo: null,
    host: null,
    dir: null,
    poll: null,
    webUrl: null,
    tokenFile: null,
    newToken: false,
    newRemoteToken: false,
    open: false,
    allowHost: null,
    webDir: null,
    inbox: null,
  });
});

test("serve flags", () => {
  const flags = serveFlags([
    "--fake",
    "--scenario",
    "first-run",
    "--frozen",
    "--port",
    "4600",
    "--repo",
    "acme/widgets",
    "--web-url",
    "https://ui.example.test/next",
    "--token-file",
    "/tmp/t",
    "--new-token",
    "--open",
  ]);
  expect(flags).toEqual({
    fake: true,
    scenario: "first-run",
    frozen: true,
    port: 4600,
    repo: "acme/widgets",
    host: null,
    dir: null,
    poll: null,
    webUrl: "https://ui.example.test/next",
    tokenFile: "/tmp/t",
    newToken: true,
    newRemoteToken: false,
    open: true,
    allowHost: null,
    webDir: null,
    inbox: null,
  });
  expect(serveFlags(["--no-open"]).open).toBe(false);
  expect(serveFlags(["--dir", "/tmp/clone", "--poll", "30"])).toMatchObject({
    fake: false,
    dir: "/tmp/clone",
    poll: 30,
  });
  expect(serveFlags(["--host", "Acme.GHE.com"]).host).toBe("Acme.GHE.com");
  expect(
    serveFlags(["--fake", "--allow-host", "laptop.example-tailnet.ts.net:8445", "--web-dir", "/w"]),
  ).toMatchObject({
    allowHost: { origin: "https://laptop.example-tailnet.ts.net:8445" },
    webDir: "/w",
  });
  expect(serveFlags(["--new-remote-token"]).newRemoteToken).toBe(true);
});

test("init", () => {
  const cmd = parseArgs(["init"]);
  expect(cmd).toMatchObject({ kind: "init", flags: { pr: true, dryRun: false, signers: [] } });
  expect(
    parseArgs(["init", "--signer", "alice ssh-ed25519 AAAA", "--signer", "bob ssh-ed25519 BBBB"]),
  ).toMatchObject({ flags: { signers: ["alice ssh-ed25519 AAAA", "bob ssh-ed25519 BBBB"] } });
  expect(parseArgs(["init", "--no-pr", "--dry-run", "--ruleset"])).toMatchObject({
    flags: { pr: false, dryRun: true, ruleset: true },
  });
  expect(parseArgs(["init", "--help"])).toEqual({ kind: "help" });
  expect(
    parseArgs(["init", "--host", "acme.ghe.com", "--repo", "mona_acme/widgets"]),
  ).toMatchObject({ flags: { host: "acme.ghe.com", repo: "mona_acme/widgets" } });
});

test("bad arguments are errors", () => {
  for (const argv of [
    ["nope"],
    ["serve", "x"],
    ["serve", "--port", "http"],
    ["serve", "--port", "70000"],
    ["serve", "--scenario", "team"],
    ["serve", "--fake", "--scenario", "nope"],
    ["serve", "--repo", "no-slash"],
    ["serve", "--web-url", "ui.example.test"],
    ["serve", "--wat"],
    ["serve", "--poll", "2"],
    ["serve", "--poll", "soon"],
    ["serve", "--fake", "--dir", "/tmp/clone"],
    ["serve", "--fake", "--host", "acme.ghe.com"],
    ["serve", "--host", "api.github.com"],
    ["serve", "--host", "not a host"],
    ["serve", "--allow-host", "100.64.0.7"],
    ["serve", "--allow-host", "https://laptop.example.test"],
    ["serve", "--web-dir", "/w"],
    ["init", "x"],
    ["init", "--repo", "no-slash"],
    ["init", "--host", "https://acme.ghe.com/acme"],
    ["init", "--kit", "has space"],
  ])
    expect(parseArgs(argv).kind).toBe("error");
});
