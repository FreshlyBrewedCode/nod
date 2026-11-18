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

test("serve defaults: GitHub, port 4518, no browser", () => {
  expect(serveFlags([])).toEqual({
    fake: false,
    scenario: "team",
    frozen: false,
    port: 4518,
    repo: null,
    webUrl: null,
    tokenFile: null,
    newToken: false,
    open: false,
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
    webUrl: "https://ui.example.test/next",
    tokenFile: "/tmp/t",
    newToken: true,
    open: true,
  });
  expect(serveFlags(["--no-open"]).open).toBe(false);
});

test("init", () => {
  expect(parseArgs(["init"])).toEqual({ kind: "init" });
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
    ["init", "x"],
  ])
    expect(parseArgs(argv).kind).toBe("error");
});
