import { expect, test } from "bun:test";

import { compareSemver, isPrerelease, normalizeVersion, parseSemver } from "./semver";

test("parses versions with a v, a pre-release and build metadata", () => {
  expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
  expect(parseSemver("v0.2.0-next.6")).toEqual({ major: 0, minor: 2, patch: 0, pre: ["next", 6] });
  expect(parseSemver("1.0.0-alpha.1+build.5")?.pre).toEqual(["alpha", 1]);
  expect(normalizeVersion("v0.2.0-next.6+abc")).toBe("0.2.0-next.6");
});

test("rejects what is not semver", () => {
  for (const bad of ["", "1", "1.2", "01.2.3", "1.2.3-", "1.2.3-01", "latest", "v1.2.3.4", "1.2.x"])
    expect(parseSemver(bad)).toBeNull();
  expect(() => compareSemver("1.2.3", "nope")).toThrow();
});

test("orders by numbers, not text", () => {
  expect(compareSemver("0.10.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
  expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  expect(compareSemver("1.2.3+a", "1.2.3+b")).toBe(0);
});

test("pre-releases come before their release and order by identifier", () => {
  const ascending = ["0.2.0-next.5", "0.2.0-next.10", "0.2.0", "0.2.1-next.1", "0.2.1"];
  for (let i = 0; i < ascending.length - 1; i++) {
    expect(compareSemver(ascending[i]!, ascending[i + 1]!)).toBeLessThan(0);
    expect(compareSemver(ascending[i + 1]!, ascending[i]!)).toBeGreaterThan(0);
  }
  // The semver.org example chain.
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 0; i < chain.length - 1; i++)
    expect(compareSemver(chain[i]!, chain[i + 1]!)).toBeLessThan(0);
});

test("a pre-release is a version with a suffix", () => {
  expect(isPrerelease("0.2.0-next.1")).toBe(true);
  expect(isPrerelease("0.2.0")).toBe(false);
  expect(isPrerelease("nope")).toBe(false);
});
