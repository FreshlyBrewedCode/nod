import { describe, expect, test } from "bun:test";

import {
  atLeast,
  describeMissing,
  describeRequirement,
  named,
  none,
  peer,
  self,
  strictest,
} from "./requirement.ts";

test("strictest takes the highest level and everyone named", () => {
  expect(strictest()).toEqual({ level: "none", named: [] });
  expect(strictest(none, self)).toEqual({ level: "self", named: [] });
  expect(strictest(peer, self, none)).toEqual({ level: "peer", named: [] });
  expect(strictest(self, named("bob"), named("Bob", "carol"))).toEqual({
    level: "self",
    named: ["bob", "carol"],
  });
});

test("order does not matter", () => {
  const parts = [named("bob"), peer, self];
  expect(strictest(...parts)).toEqual(strictest(...parts.reverse()));
});

test("atLeast", () => {
  expect(atLeast(peer, self)).toBe(true);
  expect(atLeast(self, peer)).toBe(false);
  expect(atLeast(strictest(peer, named("bob")), named("BOB"))).toBe(true);
  expect(atLeast(peer, named("bob"))).toBe(false);
});

test("descriptions", () => {
  expect(describeRequirement(none)).toBe("no nod");
  expect(describeRequirement(peer)).toBe("a peer approval or nod");
  expect(describeRequirement(peer({ approvals: false }))).toBe("a peer nod");
  expect(describeRequirement(strictest(peer, named("bob", "carol")))).toBe(
    "a peer approval or nod, an approval or nod from bob and an approval or nod from carol",
  );
  expect(describeRequirement(strictest(peer, self({ approvals: false }), named("bob")))).toBe(
    "a peer approval or nod, a self nod and an approval or nod from bob",
  );
  expect(describeRequirement(named("bob", { approvals: false }))).toBe("a nod from bob");
  // Summaries of older verifiers carry no `approval`: a nod only, as it was.
  expect(describeMissing([{ kind: "self", login: "alice" }])).toBe("a self nod");
  expect(describeMissing([{ kind: "peer" }, { kind: "named", login: "bob" }])).toBe(
    "a peer nod and a nod from bob",
  );
  expect(
    describeMissing([
      { kind: "self", login: "alice", approval: true },
      { kind: "peer", approval: true },
      { kind: "named", login: "bob", approval: true },
    ]),
  ).toBe("a self nod or an approval, a peer approval or nod and an approval or nod from bob");
});

describe("approvals: false", () => {
  test("peer and self are requirements as they are, and make one when called", () => {
    expect(peer.level).toBe("peer");
    expect(peer.named).toEqual([]);
    expect(peer()).toEqual({ level: "peer", named: [] });
    expect(peer({ approvals: true })).toEqual({ level: "peer", named: [] });
    expect(self({ approvals: false })).toEqual({
      level: "self",
      named: [],
      nodsOnly: { level: "self", named: [] },
    });
    expect(Object.isFrozen(peer)).toBe(true);
  });

  test("named takes the options last", () => {
    expect(named("bob", "Bob", "carol")).toEqual({ level: "none", named: ["bob", "carol"] });
    expect(named("bob", { approvals: false })).toEqual({
      level: "none",
      named: ["bob"],
      nodsOnly: { level: "none", named: ["bob"] },
    });
  });

  test("strictest keeps the strictest of both parts", () => {
    expect(strictest(peer, self({ approvals: false }))).toEqual({
      level: "peer",
      named: [],
      nodsOnly: { level: "self", named: [] },
    });
    expect(strictest(self, peer({ approvals: false }))).toEqual({
      level: "peer",
      named: [],
      nodsOnly: { level: "peer", named: [] },
    });
    expect(strictest(named("bob"), named("Bob", { approvals: false }))).toEqual({
      level: "none",
      named: ["bob"],
      nodsOnly: { level: "none", named: ["Bob"] },
    });
    // Without any nod-only part the result stays as it was.
    expect(strictest(peer, named("bob"))).toEqual({ level: "peer", named: ["bob"] });
  });

  test("atLeast compares the nod-only part too", () => {
    expect(atLeast(peer({ approvals: false }), peer)).toBe(true);
    expect(atLeast(peer, peer({ approvals: false }))).toBe(false);
    expect(atLeast(named("bob", { approvals: false }), named("BOB"))).toBe(true);
    expect(atLeast(named("bob"), named("bob", { approvals: false }))).toBe(false);
  });
});
