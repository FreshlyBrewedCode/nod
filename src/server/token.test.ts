import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configDir, loadOrCreateToken, tokensEqual } from "./token";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "nod-token-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the config dir follows XDG_CONFIG_HOME", () => {
  expect(configDir({ XDG_CONFIG_HOME: "/x/config" }, "/home/someone")).toBe("/x/config/nod");
  expect(configDir({}, "/home/someone")).toBe("/home/someone/.config/nod");
  // a relative XDG_CONFIG_HOME is ignored, as the spec says
  expect(configDir({ XDG_CONFIG_HOME: "rel" }, "/home/someone")).toBe("/home/someone/.config/nod");
});

test("a token is created once, mode 0600, and stays across restarts", () => {
  const file = join(temp(), "nested", "serve-token");
  const token = loadOrCreateToken(file);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
  expect(loadOrCreateToken(file)).toBe(token);
});

test("--new-token replaces it; a broken file is replaced too", () => {
  const file = join(temp(), "serve-token");
  const first = loadOrCreateToken(file);
  const second = loadOrCreateToken(file, { fresh: true });
  expect(second).not.toBe(first);
  expect(readFileSync(file, "utf8").trim()).toBe(second);
  writeFileSync(file, "short\n");
  expect(loadOrCreateToken(file)).not.toBe("short");
});

test("tokens compare by value, whatever their lengths", () => {
  expect(tokensEqual("abc", "abc")).toBe(true);
  expect(tokensEqual("abd", "abc")).toBe(false);
  expect(tokensEqual("abcd", "abc")).toBe(false);
  expect(tokensEqual("", "abc")).toBe(false);
  expect(tokensEqual(null, "abc")).toBe(false);
});
