import { expect, test } from "bun:test";

import { parseArgs } from "./cli";

test("no arguments and --help show help", () => {
  expect(parseArgs([])).toEqual({ kind: "help" });
  expect(parseArgs(["--help"])).toEqual({ kind: "help" });
});

test("--version", () => {
  expect(parseArgs(["--version"])).toEqual({ kind: "version" });
});

test("serve and init", () => {
  expect(parseArgs(["serve"])).toEqual({ kind: "serve" });
  expect(parseArgs(["init"])).toEqual({ kind: "init" });
});

test("unknown commands and extra arguments are errors", () => {
  expect(parseArgs(["nope"]).kind).toBe("error");
  expect(parseArgs(["serve", "x"]).kind).toBe("error");
});
